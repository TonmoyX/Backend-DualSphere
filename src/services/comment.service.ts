import { one, query, tx } from '../config/db.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { emit } from '../lib/realtime.js';
import { publicComment } from '../lib/serialize.js';
import { cleanText } from '../lib/text.js';
import type { AuthUser } from '../types/index.js';
import { identityService } from './identity.service.js';
import { notificationService } from './notification.service.js';
import { postService } from './post.service.js';
import { getSettings } from './settings.service.js';

// LEFT JOIN: comments by an anonymous post's author have no author row (author_id IS NULL)
const COMMENT_SELECT = `
  SELECT c.*, u.username AS author_username, u.display_name AS author_display_name,
         u.avatar_url AS author_avatar_url, u.is_verified AS author_is_verified, u.role AS author_role
    FROM comments c LEFT JOIN users u ON u.id = c.author_id`;

/** Is `user` the hidden author of this anonymous post? (HMAC check — no stored link) */
async function ownsAnonPost(post: { id: string; visibility: string }, userId: string | undefined) {
  if (!userId || post.visibility !== 'anonymous') return false;
  return (await identityService.ownedBy([post.id], userId)).has(post.id);
}

export const commentService = {
  async list(postId: string, viewer?: AuthUser, cursor?: string, limit = 200) {
    const post = await postService.getVisible(postId, viewer);
    const viewerOwnsPost = await ownsAnonPost(post, viewer?.id);
    const params: unknown[] = [postId, limit + 1];
    let cursorSql = '';
    if (cursor) {
      const d = new Date(cursor);
      if (!Number.isNaN(d.getTime())) { params.push(d); cursorSql = `AND c.created_at > $${params.length}`; }
    }
    let likedSql = 'false';
    if (viewer) { params.push(viewer.id); likedSql = `EXISTS (SELECT 1 FROM comment_likes cl WHERE cl.comment_id = c.id AND cl.user_id = $${params.length})`; }

    const { rows } = await query(
      `SELECT c.*, u.username AS author_username, u.display_name AS author_display_name,
              u.avatar_url AS author_avatar_url, u.is_verified AS author_is_verified, u.role AS author_role,
              ${likedSql} AS liked
         FROM comments c LEFT JOIN users u ON u.id = c.author_id
        WHERE c.post_id = $1 AND (c.as_post_author OR u.is_banned = false) ${cursorSql}
        ORDER BY c.created_at ASC LIMIT $2`,
      params,
    );
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return {
      comments: rows.map((r) => publicComment(r, false, !!viewer && (r.author_id === viewer.id || (r.as_post_author && viewerOwnsPost)))),
      cursor: hasMore ? new Date(rows.at(-1)!.created_at).toISOString() : null,
      hasMore,
    };
  },

  async create(postId: string, user: AuthUser, input: { content: string; parentId?: string | null; asPostAuthor?: boolean }) {
    const s = getSettings();
    if (!s.features.commentsEnabled) throw forbidden('COMMENTS_DISABLED', 'Comments are currently disabled');
    if (s.features.requireEmailVerification && !user.isVerified) throw forbidden('EMAIL_NOT_VERIFIED', 'Verify your email first');
    const post = await postService.getVisible(postId, user);
    if (post.is_removed) throw notFound('Post');

    const content = cleanText(input.content);
    if (!content) throw badRequest('EMPTY', 'Comment cannot be empty');
    if (content.length > s.limits.maxCommentLength) throw badRequest('TOO_LONG', `Max ${s.limits.maxCommentLength} characters`);

    // Anonymous post's author may reply anonymously ("Anonymous · Author") — proven by HMAC, stored without author
    const ownsPost = await ownsAnonPost(post, user.id);
    const asPostAuthor = !!input.asPostAuthor;
    if (asPostAuthor && !ownsPost) throw forbidden('NOT_POST_AUTHOR', 'Only the author of this anonymous post can reply as Anonymous');

    let parent: { author_id: string | null; as_post_author: boolean } | undefined;
    if (input.parentId) {
      parent = await one('SELECT author_id, as_post_author FROM comments WHERE id = $1 AND post_id = $2 AND is_removed = false', [input.parentId, postId]);
      if (!parent) throw badRequest('BAD_PARENT', 'Replying to a comment that no longer exists');
    }

    const comment = await tx(async (c) => {
      const { rows } = await c.query(
        'INSERT INTO comments (post_id, parent_id, author_id, content, as_post_author) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [postId, input.parentId ?? null, asPostAuthor ? null : user.id, content, asPostAuthor],
      );
      const counts = await c.query('UPDATE posts SET comments_count = comments_count + 1 WHERE id = $1 RETURNING likes_count, comments_count', [postId]);
      return { id: rows[0].id as string, counts: counts.rows[0] };
    });

    const row = await one(`${COMMENT_SELECT} WHERE c.id = $1`, [comment.id]);
    const full = publicComment(row); // broadcast shape: isMine false for everyone
    emit.post(postId, 'comment:new', full);
    emit.feed('post:update', { id: postId, likesCount: comment.counts.likes_count, commentsCount: comment.counts.comments_count });

    // ── Notifications ──
    // 1. Identity post → its author (as before)
    if (post.visibility === 'identity' && post.author_id) {
      await notificationService.create({ userId: post.author_id, type: 'comment', actorId: user.id, postId, commentId: comment.id });
    }
    // 2. Anonymous post → its hidden author, via the post-keyed table (not when they comment themselves)
    if (post.visibility === 'anonymous' && !ownsPost) {
      const repliedToAuthor = !!parent?.as_post_author;
      await notificationService.createAnon({ postId, type: repliedToAuthor ? 'reply' : 'comment', actorId: user.id, commentId: comment.id });
    }
    // 3. Reply to a normal comment → that commenter (actor shown as "Anonymous" when the anon author replies)
    if (parent?.author_id && parent.author_id !== user.id && parent.author_id !== post.author_id) {
      await notificationService.create({
        userId: parent.author_id, type: 'reply', actorId: asPostAuthor ? null : user.id, actorAnon: asPostAuthor, postId, commentId: comment.id,
      });
    }
    return publicComment(row, false, true);
  },

  async remove(commentId: string, user: AuthUser) {
    const c = await one(
      `SELECT c.id, c.post_id, c.author_id, c.is_removed, c.as_post_author, p.visibility
         FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = $1`,
      [commentId],
    );
    if (!c || c.is_removed) throw notFound('Comment');
    const mine = c.as_post_author ? await ownsAnonPost({ id: c.post_id, visibility: c.visibility }, user.id) : c.author_id === user.id;
    if (!mine) throw forbidden('NOT_OWNER', 'You can only delete your own comments');

    // Permanently delete the comment and its whole reply tree (likes/notifications cascade).
    const counts = await tx(async (cl) => {
      const { rows: tree } = await cl.query<{ id: string; is_removed: boolean }>(
        `WITH RECURSIVE t AS (
           SELECT id, is_removed FROM comments WHERE id = $1
           UNION ALL
           SELECT c.id, c.is_removed FROM comments c JOIN t ON c.parent_id = t.id
         ) SELECT id, is_removed FROM t`,
        [commentId],
      );
      const ids = tree.map((r) => r.id);
      const visible = tree.filter((r) => !r.is_removed).length; // removed ones were already uncounted
      await cl.query(`DELETE FROM reports WHERE target_type = 'comment' AND target_id = ANY($1::uuid[])`, [ids]);
      await cl.query('DELETE FROM comments WHERE id = $1', [commentId]);
      const { rows } = await cl.query(
        'UPDATE posts SET comments_count = GREATEST(comments_count - $2, 0) WHERE id = $1 RETURNING likes_count, comments_count',
        [c.post_id, visible],
      );
      return { ids, post: rows[0] };
    });
    emit.post(c.post_id, 'comment:deleted', { id: commentId, ids: counts.ids });
    emit.feed('post:update', { id: c.post_id, likesCount: counts.post.likes_count, commentsCount: counts.post.comments_count });
  },

  async toggleLike(commentId: string, user: AuthUser) {
    const c = await one('SELECT id, is_removed FROM comments WHERE id = $1', [commentId]);
    if (!c || c.is_removed) throw notFound('Comment');
    return tx(async (cl) => {
      const ins = await cl.query('INSERT INTO comment_likes (comment_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [commentId, user.id]);
      const liked = ins.rowCount === 1;
      if (!liked) await cl.query('DELETE FROM comment_likes WHERE comment_id = $1 AND user_id = $2', [commentId, user.id]);
      const { rows } = await cl.query('UPDATE comments SET likes_count = GREATEST(likes_count + $2, 0) WHERE id = $1 RETURNING likes_count', [commentId, liked ? 1 : -1]);
      return { liked, likesCount: rows[0].likes_count as number };
    });
  },
};
