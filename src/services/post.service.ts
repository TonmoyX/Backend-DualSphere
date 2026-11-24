import { one, query, tx } from '../config/db.js';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { emit, joinAnonPostRoom } from '../lib/realtime.js';
import { hydratePosts } from './feed.service.js';
import { cleanText } from '../lib/text.js';
import type { AuthUser, Visibility } from '../types/index.js';
import { abuseService } from './abuse.service.js';
import { auditService } from './audit.service.js';
import { identityService } from './identity.service.js';
import { mediaService } from './media.service.js';
import { deleteObject } from '../lib/storage.js';
import { notificationService } from './notification.service.js';
import { getSettings } from './settings.service.js';
import { announceCommunityPost, assertCommunityPostVisible, preparePostInCommunity } from './community.service.js';
import { isActiveCreator, PRICE_MAX_MINOR, PRICE_MIN_MINOR } from './creator.service.js';
import { env } from '../config/env.js';

export const POST_SELECT = `
  SELECT p.*, u.username AS author_username, u.display_name AS author_display_name,
         u.avatar_url AS author_avatar_url, u.is_verified AS author_is_verified, u.role AS author_role
    FROM posts p
    LEFT JOIN users u ON u.id = p.author_id`;

type SharePolicy = 'everyone' | 'friends' | 'none';

interface CreatePostInput {
  content: string;
  mediaIds: string[];
  mode: Visibility;
  user: AuthUser;
  sharePolicy?: SharePolicy;
  communityId?: string;
  access?: 'public' | 'subscribers' | 'paid';
  priceMinor?: number;
  tagIds?: string[];
}

/**
 * Who may be tagged: only the author's friends (not banned, not themselves), deduped.
 * Tags only exist on identity posts outside communities — from an anonymous post they'd point at the hidden author.
 */
async function resolveTags(tagIds: string[] | undefined, mode: Visibility, communityId: string | null | undefined, user: AuthUser) {
  const ids = [...new Set(tagIds ?? [])].filter((id) => id !== user.id);
  if (!ids.length) return [];
  if (mode !== 'identity') throw badRequest('ANON_NO_TAGS', 'Anonymous posts can\'t tag people — it would reveal who you are');
  if (communityId) throw badRequest('COMMUNITY_NO_TAGS', 'You can\'t tag people in community posts');
  const { rows } = await query<{ friend_id: string }>(
    `SELECT e.friend_id FROM friend_edges e JOIN users u ON u.id = e.friend_id
      WHERE e.user_id = $1 AND e.friend_id = ANY($2::uuid[]) AND u.is_banned = false`,
    [user.id, ids],
  );
  if (rows.length !== ids.length) throw badRequest('BAD_TAGS', 'You can only tag your friends');
  return ids;
}

async function notifyTagged(userIds: string[], actorId: string, postId: string) {
  for (const id of userIds) await notificationService.create({ userId: id, type: 'tag', actorId, postId });
}

function assertPolicy(mode: Visibility, policy: SharePolicy) {
  // "friends only" would reveal the hidden author's friend list, so anonymous posts can't use it
  if (mode === 'anonymous' && policy === 'friends') throw badRequest('BAD_SHARE_POLICY', 'Anonymous posts can be shared by everyone or no one');
}

async function isOwnerOf(row: { id: string; visibility: string; author_id: string | null }, user: AuthUser) {
  return row.visibility === 'identity' ? row.author_id === user.id : (await identityService.ownedBy([row.id], user.id)).has(row.id);
}

/** Broadcast the PUBLIC shape only (isOwner/likedByMe/savedByMe false for everyone). */
async function broadcastNew(postId: string) {
  const full = await one(`${POST_SELECT} WHERE p.id = $1`, [postId]);
  emit.feed('post:new', (await hydratePosts([full]))[0]);
  return full;
}

function assertCanPost(user: AuthUser, mode: Visibility) {
  const s = getSettings();
  if (s.features.requireEmailVerification && !user.isVerified) {
    throw forbidden('EMAIL_NOT_VERIFIED', 'Verify your email before posting');
  }
  if (mode === 'anonymous') {
    if (!s.features.anonymousPostingEnabled) throw forbidden('ANON_DISABLED', 'Anonymous posting is currently disabled');
    const ageHours = (Date.now() - new Date(user.createdAt).getTime()) / 3_600_000;
    if (ageHours < s.limits.anonAccountAgeHours) {
      throw forbidden(
        'ACCOUNT_TOO_NEW',
        `Anonymous posting unlocks ${s.limits.anonAccountAgeHours}h after sign-up (anti-abuse).`,
        );
    }
  }
}

export const postService = {
  async create({ content: raw, mediaIds, mode, user, sharePolicy = 'everyone', communityId, access = 'public', priceMinor, tagIds }: CreatePostInput) {
    assertCanPost(user, mode);
    const tags = await resolveTags(tagIds, mode, communityId, user);
    assertPolicy(mode, sharePolicy);
    // Paid / subscriber-only: creators, identity posts, outside communities (money and anonymity never touch)
    if (access !== 'public') {
      if (mode !== 'identity') throw badRequest('ANON_NOT_PAID', 'Anonymous posts can\'t be paid or subscriber-only');
      if (communityId) throw badRequest('COMMUNITY_NOT_PAID', 'Community posts can\'t be paid or subscriber-only');
      if (!(await isActiveCreator(user.id))) throw forbidden('NOT_CREATOR', 'Turn on creator tools to post paid or subscriber-only content');
      if (access === 'paid' && (!priceMinor || priceMinor < PRICE_MIN_MINOR || priceMinor > PRICE_MAX_MINOR)) throw badRequest('BAD_PRICE', 'Set a price for the paid post');
      sharePolicy = 'none'; // paid content can't be re-shared
    }
    // Community post: membership, bans, mutes and the community's anonymous policy are checked first
    const community = communityId ? await preparePostInCommunity(communityId, user, mode) : null;
    const pending = !!community?.pending;
    const s = getSettings();
    const content = cleanText(raw);
    if (content.length > s.limits.maxPostLength) throw badRequest('TOO_LONG', `Posts are limited to ${s.limits.maxPostLength} characters`);
    if (!content && mediaIds.length === 0) throw badRequest('EMPTY_POST', 'Write something or attach media');
    if (mediaIds.length > s.limits.maxMediaPerPost) throw badRequest('TOO_MANY_MEDIA', `Max ${s.limits.maxMediaPerPost} attachments`);

    // 1. Anti-abuse: duplicate (exact → reject, similar → flag), spam, velocity
    const verdict = await abuseService.inspectPost(content, user.id);

    // 2. Media must be uploaded by this user and finished
    const media = await mediaService.claimable(mediaIds, user.id);

    const post = await tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO posts (content, media, visibility, author_id, content_hash, abuse_flags, share_policy, community_id, is_pending, access, price_minor, currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [
          content,
          JSON.stringify(media.map((m) => ({ id: m.id, url: m.url, type: m.kind, mime: m.mime }))),
          mode,
          mode === 'identity' ? user.id : null, // ← CRITICAL: anonymous posts have NO author
          verdict.hash,
          verdict.flags,
          // Posts in non-public communities can't be shared outside them
          community && community.community.visibility !== 'public' ? 'none' : sharePolicy,
          community ? community.community.id : null,
          pending,
          access,
          access === 'paid' ? priceMinor : null,
          access === 'paid' ? env.DEFAULT_CURRENCY : null,
        ],
      );
      const p = rows[0];

      // 3. Anonymous: identity goes ONLY to the encrypted link table
      if (mode === 'anonymous') await identityService.storeLink(c, p.id, user.id);
      // Community posts don't count toward the profile (they never show there)
      else if (community) await c.query('UPDATE users SET abuse_score = abuse_score + $2 WHERE id = $1', [user.id, verdict.score]);
      else await c.query('UPDATE users SET post_count = post_count + 1, abuse_score = abuse_score + $2 WHERE id = $1', [user.id, verdict.score]);
      if (community && !pending) await c.query('UPDATE communities SET post_count = post_count + 1 WHERE id = $1', [community.community.id]);

      // 4. Attach media; for anon posts the media row's owner is wiped (no user↔post trail)
      await mediaService.attach(c, media.map((m) => m.id), p.id, mode === 'anonymous');
      if (tags.length) await c.query('INSERT INTO post_tags (post_id, user_id) SELECT $1, unnest($2::uuid[])', [p.id, tags]);
      return p;
    });

    let full: any;
    if (community) {
      // Never broadcast community posts to the global feed — only to the community's own room
      full = await one(`${POST_SELECT} WHERE p.id = $1`, [post.id]);
      await announceCommunityPost(community.community.id, (await hydratePosts([full]))[0], pending);
    } else {
      full = await broadcastNew(post.id);
    }
    if (verdict.flags.length) emit.staff('admin:flagged', { postId: post.id, flags: verdict.flags });
    if (mode === 'anonymous') joinAnonPostRoom(user.id, post.id); // live activity alerts for the hidden author
    await notifyTagged(tags, user.id, post.id);
    return (await hydratePosts([full], user))[0];
  },

  /** Share a post to your feed (always re-shares the original, like Facebook). */
  async share(postId: string, user: AuthUser, { content: raw, mode }: { content: string; mode: Visibility }) {
    const row = await this.getVisible(postId, user);
    if (row.is_share && !row.shared_post_id) throw notFound('Post');
    const root = row.is_share ? await this.getVisible(row.shared_post_id, user) : row;
    if (root.is_removed) throw notFound('Post');
    if (root.is_pending) throw forbidden('SHARE_NOT_ALLOWED', 'This post is waiting for approval');
    if (root.access && root.access !== 'public') throw forbidden('SHARE_NOT_ALLOWED', 'Paid and subscriber-only posts can\'t be shared');
    // Only posts from public communities can be shared to the main feed
    if (root.community_id) {
      const c = await one('SELECT visibility FROM communities WHERE id = $1', [root.community_id]);
      if (c?.visibility !== 'public') throw forbidden('SHARE_NOT_ALLOWED', 'Posts from private communities can\'t be shared');
    }
    const [h] = await hydratePosts([root], user);
    if (!h!.canShare) {
      throw forbidden('SHARE_NOT_ALLOWED', root.share_policy === 'friends' ? 'Only the author\'s friends can share this post' : 'The author turned off sharing for this post');
    }

    assertCanPost(user, mode);
    const content = cleanText(raw);
    if (content.length > getSettings().limits.maxPostLength) throw badRequest('TOO_LONG', `Posts are limited to ${getSettings().limits.maxPostLength} characters`);
    const verdict = await abuseService.inspectPost(content, user.id);

    const { shareId, sharesCount } = await tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO posts (content, media, visibility, author_id, content_hash, abuse_flags, is_share, shared_post_id)
         VALUES ($1, '[]', $2, $3, $4, $5, true, $6) RETURNING id`,
        [content, mode, mode === 'identity' ? user.id : null, verdict.hash, verdict.flags, root.id],
      );
      const id = rows[0].id as string;
      if (mode === 'anonymous') await identityService.storeLink(c, id, user.id);
      else await c.query('UPDATE users SET post_count = post_count + 1, abuse_score = abuse_score + $2 WHERE id = $1', [user.id, verdict.score]);
      const upd = await c.query('UPDATE posts SET shares_count = shares_count + 1 WHERE id = $1 RETURNING shares_count', [root.id]);
      return { shareId: id, sharesCount: upd.rows[0].shares_count as number };
    });

    const full = await broadcastNew(shareId);
    emit.feed('post:update', { id: root.id, sharesCount });
    if (verdict.flags.length) emit.staff('admin:flagged', { postId: shareId, flags: verdict.flags });
    // Only identity → identity: notifying from an anonymous share would expose the sharer,
    // and notifying an anonymous author would store their link in plain sight.
    if (mode === 'identity' && root.visibility === 'identity' && root.author_id) {
      await notificationService.create({ userId: root.author_id, type: 'share', actorId: user.id, postId: shareId });
    }
    // Hidden author of an anonymous original: notified via the post-keyed table (sharer hidden if they shared anonymously)
    if (root.visibility === 'anonymous' && !(await identityService.ownedBy([root.id], user.id)).has(root.id)) {
      if (mode === 'anonymous') joinAnonPostRoom(user.id, shareId);
      await notificationService.createAnon({ postId: root.id, type: 'share', actorId: mode === 'identity' ? user.id : null });
    } else if (mode === 'anonymous') joinAnonPostRoom(user.id, shareId);
    return (await hydratePosts([full], user))[0];
  },

  async setSharePolicy(postId: string, user: AuthUser, sharePolicy: SharePolicy) {
    const row = await one('SELECT id, visibility, author_id, is_share, community_id, access FROM posts WHERE id = $1 AND deleted_at IS NULL', [postId]);
    if (!row) throw notFound('Post');
    if (!(await isOwnerOf(row, user))) throw forbidden('NOT_OWNER', 'Only the author can change who can share this post');
    if (row.community_id) {
      const c = await one('SELECT visibility FROM communities WHERE id = $1', [row.community_id]);
      if (c?.visibility !== 'public') throw badRequest('COMMUNITY_PRIVATE', 'Posts in private communities can\'t be shared outside');
    }
    if (row.is_share) throw badRequest('IS_SHARE', 'Sharing settings belong to the original post');
    if (row.access !== 'public') throw badRequest('PAID_POST', 'Paid and subscriber-only posts can\'t be shared');
    assertPolicy(row.visibility, sharePolicy);
    await query('UPDATE posts SET share_policy = $2 WHERE id = $1', [postId, sharePolicy]);
    emit.feed('post:update', { id: postId, sharePolicy });
    return { sharePolicy };
  },

  /**
   * Edit your own post — identity or anonymous: the text, the photos/videos (add, remove, reorder) and tags.
   * Ownership of an anonymous post is proven with the HMAC link (isOwnerOf), and nothing here writes the author
   * anywhere (new media loses its owner on attach, like on create), so editing never de-anonymises a post.
   * `mediaIds` is the full final list: ids already on the post are kept, new ones must be your finished uploads.
   */
  async edit(postId: string, user: AuthUser, { content: raw, tagIds, mediaIds }: { content?: string; tagIds?: string[]; mediaIds?: string[] }) {
    const row = await one(
      `SELECT id, visibility, author_id, content, media, is_share, is_removed, is_pending, community_id, access, post_type
         FROM posts WHERE id = $1 AND deleted_at IS NULL`,
      [postId],
    );
    if (!row) throw notFound('Post');
    if (!(await isOwnerOf(row, user))) throw forbidden('NOT_OWNER', 'You can only edit your own posts');
    if (row.is_removed) throw forbidden('POST_REMOVED', 'Posts removed by moderators can\'t be edited');
    const s = getSettings();
    if (s.features.requireEmailVerification && !user.isVerified) throw forbidden('EMAIL_NOT_VERIFIED', 'Verify your email before posting');
    if (row.visibility === 'anonymous' && !s.features.anonymousPostingEnabled) throw forbidden('ANON_DISABLED', 'Anonymous posting is currently disabled');

    const content = raw === undefined ? (row.content as string) : cleanText(raw);
    if (content.length > s.limits.maxPostLength) throw badRequest('TOO_LONG', `Posts are limited to ${s.limits.maxPostLength} characters`);
    const textChanged = content !== row.content;

    // ── Media: work out the final list, what's new and what's dropped ──
    type Item = { id?: string; url: string; type: 'image' | 'video'; mime?: string };
    const current: Item[] = Array.isArray(row.media) ? row.media : [];
    let finalMedia = current;
    let added: string[] = [];
    let dropped: Item[] = [];
    if (mediaIds !== undefined) {
      const want = [...new Set(mediaIds)];
      const curIds = current.map((m) => m.id).filter(Boolean) as string[];
      const changed = want.length !== curIds.length || want.some((id, i) => id !== curIds[i]) || current.some((m) => !m.id);
      if (changed) {
        if (row.is_share) throw badRequest('IS_SHARE', 'Shared posts can\'t have photos or videos');
        if ((row.post_type ?? 'regular') !== 'regular') throw badRequest('PROFILE_PHOTO_POST', 'Profile and cover photo posts keep their photo — you can edit the text');
        if (want.length > s.limits.maxMediaPerPost) throw badRequest('TOO_MANY_MEDIA', `Max ${s.limits.maxMediaPerPost} attachments`);
        added = want.filter((id) => !curIds.includes(id));
        const fresh = await mediaService.claimable(added, user.id);
        const byId = new Map<string, Item>([
          ...current.filter((m) => m.id).map((m) => [m.id!, m] as const),
          ...fresh.map((m) => [m.id as string, { id: m.id, url: m.url, type: m.kind, mime: m.mime }] as const),
        ]);
        finalMedia = want.map((id) => byId.get(id)!);
        dropped = current.filter((m) => !m.id || !want.includes(m.id));
      }
    }
    const mediaChanged = finalMedia !== current;
    if (!content && finalMedia.length === 0 && !row.is_share) throw badRequest('EMPTY_POST', 'Write something or attach media');

    if (textChanged || mediaChanged) {
      const verdict = textChanged ? await abuseService.inspectPost(content, user.id, { excludePostId: postId }) : null;
      const files = await tx(async (c) => {
        await c.query(
          `UPDATE posts SET content = $2, media = $3, edited_at = now(),
                  content_hash = COALESCE($4, content_hash),
                  abuse_flags = ARRAY(SELECT DISTINCT unnest(abuse_flags || $5::text[]))
            WHERE id = $1`,
          [postId, content, JSON.stringify(finalMedia), verdict?.hash ?? null, verdict?.flags ?? []],
        );
        // Same rule as create: anonymous posts never touch the author's row
        if (verdict && row.visibility === 'identity' && verdict.score > 0) {
          await c.query('UPDATE users SET abuse_score = abuse_score + $2 WHERE id = $1', [user.id, verdict.score]);
        }
        await mediaService.attach(c, added, postId, row.visibility === 'anonymous');
        const gone = dropped.map((m) => m.id).filter(Boolean) as string[];
        if (!gone.length) return [];
        const { rows: del } = await c.query<{ object_key: string; storage: 'r2' | 'local' }>(
          'DELETE FROM media WHERE id = ANY($1::uuid[]) AND post_id = $2 RETURNING object_key, storage',
          [gone, postId],
        );
        return del;
      });
      // Removed photos/videos are deleted from storage too (same as deleting the post)
      for (const f of files) await deleteObject(f.object_key, f.storage);
      for (const m of dropped.filter((x) => !x.id)) await mediaService.releaseIfUnused(m.url);
      if (verdict?.flags.length) emit.staff('admin:flagged', { postId, flags: verdict.flags });

      // Live update for everyone else — but never leak paid content or a post still waiting for approval
      if (!row.is_pending && (row.access ?? 'public') === 'public') {
        const fresh = await one('SELECT edited_at FROM posts WHERE id = $1', [postId]);
        const payload = {
          id: postId,
          content,
          media: finalMedia.map((m) => ({ id: m.id, url: m.url, type: m.type, mime: m.mime })),
          editedAt: new Date(fresh.edited_at).toISOString(),
        };
        if (row.community_id) emit.community(row.community_id, 'post:update', payload);
        else emit.feed('post:update', payload);
      }
    }

    // Tags: replace the set; only newly tagged friends get a notification
    if (tagIds !== undefined) {
      const tags = await resolveTags(tagIds, row.visibility, row.community_id, user);
      const newlyTagged = await tx(async (c) => {
        await c.query('DELETE FROM post_tags WHERE post_id = $1 AND NOT (user_id = ANY($2::uuid[]))', [postId, tags]);
        const { rows } = await c.query<{ user_id: string }>(
          'INSERT INTO post_tags (post_id, user_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING RETURNING user_id',
          [postId, tags],
        );
        return rows.map((r) => r.user_id);
      });
      // Untagged people lose the "tagged you" notification too
      await query(`DELETE FROM notifications WHERE post_id = $1 AND type = 'tag' AND NOT (user_id = ANY($2::uuid[]))`, [postId, tags]);
      if (!row.is_pending) await notifyTagged(newlyTagged, user.id, postId);
    }

    const full = await one(`${POST_SELECT} WHERE p.id = $1`, [postId]);
    return (await hydratePosts([full], user))[0];
  },

  /** A tagged person removes their own tag. */
  async untagSelf(postId: string, user: AuthUser) {
    const { rowCount } = await query('DELETE FROM post_tags WHERE post_id = $1 AND user_id = $2', [postId, user.id]);
    if (!rowCount) throw notFound('Tag');
    await query(`DELETE FROM notifications WHERE post_id = $1 AND user_id = $2 AND type = 'tag'`, [postId, user.id]);
    return { ok: true };
  },

  async setSaved(postId: string, user: AuthUser, saved: boolean) {
    if (saved) {
      await this.getVisible(postId, user);
      await query('INSERT INTO saved_posts (user_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.id, postId]);
    } else {
      await query('DELETE FROM saved_posts WHERE user_id = $1 AND post_id = $2', [user.id, postId]);
    }
    return { saved };
  },

  async getVisible(postId: string, viewer?: AuthUser) {
    const row = await one(
      `${POST_SELECT} WHERE p.id = $1 AND p.deleted_at IS NULL AND (u.id IS NULL OR u.is_banned = false)`,
      [postId],
    );
    if (!row || (row.is_removed && !['moderator', 'admin'].includes(viewer?.role ?? ''))) throw notFound('Post');
    // Private / invite-only community posts: members only (covers the post page, comments, likes, saves and shares)
    await assertCommunityPostVisible(row, viewer);
    return row;
  },

  async get(postId: string, viewer?: AuthUser) {
    const row = await this.getVisible(postId, viewer);
    const [post] = await hydratePosts([row], viewer);
    return { ...post!, isRemoved: !!row.is_removed };
  },

  async remove(postId: string, user: AuthUser) {
    const row = await one('SELECT id, visibility, author_id, is_share, shared_post_id, media, community_id, is_pending FROM posts WHERE id = $1 AND deleted_at IS NULL', [postId]);
    if (!row) throw notFound('Post');
    if (!(await isOwnerOf(row, user))) throw forbidden('NOT_OWNER', 'You can only delete your own posts');

    // Permanently delete: the post, its comments, likes, anonymous link and notifications cascade;
    // attached files are removed from storage too.
    const files = await tx(async (c) => {
      const { rows: media } = await c.query<{ id: string; object_key: string; storage: 'r2' | 'local' }>(
        'SELECT id, object_key, storage FROM media WHERE post_id = $1',
        [postId],
      );
      await c.query(
        `DELETE FROM reports WHERE (target_type = 'post' AND target_id = $1)
            OR (target_type = 'comment' AND target_id IN (SELECT id FROM comments WHERE post_id = $1))`,
        [postId],
      );
      await c.query('DELETE FROM posts WHERE id = $1', [postId]);
      await c.query('DELETE FROM media WHERE id = ANY($1::uuid[])', [media.map((m) => m.id)]);
      if (row.community_id) {
        if (!row.is_pending) await c.query('UPDATE communities SET post_count = GREATEST(post_count - 1, 0) WHERE id = $1', [row.community_id]);
      } else if (row.visibility === 'identity') await c.query('UPDATE users SET post_count = GREATEST(post_count - 1, 0) WHERE id = $1', [user.id]);
      if (row.is_share && row.shared_post_id) {
        const { rows } = await c.query('UPDATE posts SET shares_count = GREATEST(shares_count - 1, 0) WHERE id = $1 RETURNING shares_count', [row.shared_post_id]);
        if (rows[0]) emit.feed('post:update', { id: row.shared_post_id, sharesCount: rows[0].shares_count });
      }
      return media;
    });
    for (const f of files) await deleteObject(f.object_key, f.storage);
    for (const u of (row.media ?? []) as { url: string }[]) await mediaService.releaseIfUnused(u.url);
    if (row.community_id) emit.community(row.community_id, 'post:removed', { id: postId });
    else emit.feed('post:removed', { id: postId });
  },

  async toggleLike(postId: string, user: AuthUser) {
    const post = await this.getVisible(postId, user);
    const result = await tx(async (c) => {
      const ins = await c.query('INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [postId, user.id]);
      const liked = ins.rowCount === 1;
      if (!liked) await c.query('DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2', [postId, user.id]);
      const { rows } = await c.query(
        'UPDATE posts SET likes_count = GREATEST(likes_count + $2, 0) WHERE id = $1 RETURNING likes_count, comments_count',
        [postId, liked ? 1 : -1],
      );
      return { liked, likesCount: rows[0].likes_count as number, commentsCount: rows[0].comments_count as number };
    });

    emit.feed('post:update', { id: postId, likesCount: result.likesCount, commentsCount: result.commentsCount });
    if (post.visibility === 'identity' && post.author_id) {
      if (result.liked) await notificationService.create({ userId: post.author_id, type: 'like', actorId: user.id, postId });
      else await notificationService.removeLike(post.author_id, user.id, postId);
    } else if (post.visibility === 'anonymous' && !(await identityService.ownedBy([postId], user.id)).has(postId)) {
      if (result.liked) await notificationService.createAnon({ postId, type: 'like', actorId: user.id });
      else await notificationService.removeAnonLike(postId, user.id);
    }
    return { liked: result.liked, likesCount: result.likesCount };
  },

  async report(targetType: 'post' | 'comment', targetId: string, user: AuthUser, reason: string, details?: string) {
    const table = targetType === 'post' ? 'posts' : 'comments';
    const exists = await one(`SELECT id FROM ${table} WHERE id = $1`, [targetId]);
    if (!exists) throw notFound(targetType === 'post' ? 'Post' : 'Comment');

    try {
      await query(
        `INSERT INTO reports (target_id, target_type, reporter_id, reason, details) VALUES ($1, $2, $3, $4, $5)`,
        [targetId, targetType, user.id, reason, details ? cleanText(details) : null],
      );
    } catch (err: any) {
      if (err?.code === '23505') throw new AppError(409, 'ALREADY_REPORTED', 'You already reported this');
      throw err;
    }

    if (targetType === 'post') {
      const { rows } = await query('UPDATE posts SET reports_count = reports_count + 1 WHERE id = $1 RETURNING reports_count, is_removed', [targetId]);
      const threshold = getSettings().moderation.autoHideReportThreshold;
      if (threshold > 0 && rows[0].reports_count >= threshold && !rows[0].is_removed) {
        await query(`UPDATE posts SET is_removed = true, removed_reason = 'Auto-hidden: report threshold reached' WHERE id = $1`, [targetId]);
        await auditService.log({ action: 'POST_AUTO_HIDE', targetId, targetType: 'post', metadata: { reports: rows[0].reports_count } });
        emit.feed('post:removed', { id: targetId });
      }
    }
    emit.staff('admin:report', { targetType, targetId, reason });
    return { reported: true };
  },
};
