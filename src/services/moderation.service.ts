import { one, query, tx } from '../config/db.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { emit } from '../lib/realtime.js';
import { ROLE_RANK, type AuthUser, type Role } from '../types/index.js';
import { auditService } from './audit.service.js';
import { notificationService } from './notification.service.js';
import { messageService } from './message.service.js';
import { deleteObject } from '../lib/storage.js';
import { mediaService } from './media.service.js';

export const moderationService = {
  async listReports(status: string | undefined, page: number, limit: number) {
    const params: unknown[] = [limit, (page - 1) * limit];
    let where = '';
    if (status && status !== 'all') { params.push(status); where = `WHERE r.status = $${params.length}`; }
    const { rows } = await query(
      `SELECT r.*, count(*) OVER() AS total,
              rep.username AS reporter_username,
              rev.username AS reviewer_username,
              p.content AS post_content, p.visibility AS post_visibility, p.is_removed AS post_removed,
              p.reports_count AS post_reports, p.media AS post_media,
              pa.username AS post_author_username,
              c.content AS comment_content, c.is_removed AS comment_removed, c.post_id AS comment_post_id,
              ca.username AS comment_author_username,
              msg.content AS message_content, msg.media AS message_media, msg.removed_by_mod AS message_removed,
              msg.unsent_at AS message_unsent, msg.is_anonymous AS message_anon, ma.username AS message_author_username,
              tu.username AS user_username, tu.display_name AS user_display_name, tu.bio AS user_bio,
              tu.avatar_url AS user_avatar_url, tu.is_banned AS user_banned
         FROM reports r
         JOIN users rep ON rep.id = r.reporter_id
         LEFT JOIN users rev ON rev.id = r.reviewed_by
         LEFT JOIN posts p ON r.target_type = 'post' AND p.id = r.target_id
         LEFT JOIN users pa ON pa.id = p.author_id
         LEFT JOIN comments c ON r.target_type = 'comment' AND c.id = r.target_id
         LEFT JOIN users ca ON ca.id = c.author_id
         LEFT JOIN messages msg ON r.target_type = 'message' AND msg.id = r.target_id
         LEFT JOIN users ma ON ma.id = msg.sender_id
         LEFT JOIN users tu ON r.target_type = 'user' AND tu.id = r.target_id
         ${where}
        ORDER BY (r.status = 'pending') DESC, r.created_at DESC
        LIMIT $1 OFFSET $2`,
      params,
    );
    return {
      total: rows[0]?.total ?? 0,
      items: rows.map((r) => ({
        id: r.id,
        targetType: r.target_type,
        targetId: r.target_id,
        reason: r.reason,
        details: r.details,
        status: r.status,
        resolutionNote: r.resolution_note,
        reporter: r.reporter_username,
        reviewer: r.reviewer_username,
        reviewedAt: r.reviewed_at,
        createdAt: r.created_at,
        target:
          r.target_type === 'post'
            ? {
                content: r.post_content, visibility: r.post_visibility, isRemoved: r.post_removed, reportsCount: r.post_reports,
                media: r.post_media ?? [],
                author: r.post_visibility === 'identity' ? r.post_author_username : null, // anon stays anon
              }
            : r.target_type === 'user'
              ? {
                  content: r.user_username ? `${r.user_display_name}${r.user_bio ? ` — ${r.user_bio}` : ''}` : null,
                  author: r.user_username, avatarUrl: r.user_avatar_url, isRemoved: !!r.user_banned, profile: r.user_username,
                }
            : r.target_type === 'message'
              ? {
                  // Only the single reported message is ever shown to staff — never the conversation
                  content: r.message_content, media: r.message_media ?? [], author: r.message_anon ? null : r.message_author_username,
                  isRemoved: !!r.message_removed || !!r.message_unsent,
                }
              : { content: r.comment_content, isRemoved: r.comment_removed, postId: r.comment_post_id, author: r.comment_author_username },
      })),
    };
  },

  async updateReport(
    reportId: string,
    actor: AuthUser,
    input: { status: 'reviewed' | 'actioned' | 'dismissed'; note?: string; action: 'none' | 'remove_content' | 'ban_author'; applyToAll: boolean },
  ) {
    const r = await one('SELECT * FROM reports WHERE id = $1', [reportId]);
    if (!r) throw notFound('Report');

    if (input.action === 'remove_content') {
      if (r.target_type === 'user') throw badRequest('NOT_CONTENT', 'A profile report has no content to remove — ban the account instead');
      if (r.target_type === 'post') await this.removePost(r.target_id, actor, `Report: ${r.reason}`);
      else if (r.target_type === 'message') await messageService.modRemove(r.target_id, actor, `Report: ${r.reason}`);
      else await this.removeComment(r.target_id, actor, `Report: ${r.reason}`);
    }
    if (input.action === 'ban_author') {
      const author = r.target_type === 'user'
        ? { author_id: r.target_id }
        : r.target_type === 'post'
        ? await one(`SELECT author_id FROM posts WHERE id = $1 AND visibility = 'identity'`, [r.target_id])
        : r.target_type === 'message'
          ? await one('SELECT sender_id AS author_id FROM messages WHERE id = $1', [r.target_id])
          : await one('SELECT author_id FROM comments WHERE id = $1', [r.target_id]);
      if (!author?.author_id) throw badRequest('ANON_TARGET', 'Anonymous author — use an audited identity lookup (admin) first');
      await this.banUser(author.author_id, actor, `Report: ${r.reason}${input.note ? ` — ${input.note}` : ''}`, null);
    }

    if (input.applyToAll) {
      await query(
        `UPDATE reports SET status = $4, reviewed_by = $5, reviewed_at = now(), resolution_note = $6
          WHERE (target_id = $1 AND target_type = $2 AND status = 'pending') OR id = $3`,
        [r.target_id, r.target_type, reportId, input.status, actor.id, input.note ?? null],
      );
    } else {
      await query(
        `UPDATE reports SET status = $2, reviewed_by = $3, reviewed_at = now(), resolution_note = $4 WHERE id = $1`,
        [reportId, input.status, actor.id, input.note ?? null],
      );
    }
    await auditService.log({
      actorId: actor.id, actorRole: actor.role, action: 'REPORT_UPDATE', targetId: reportId, targetType: r.target_type,
      metadata: { status: input.status, action: input.action, note: input.note ?? null, target: r.target_id },
    });
    emit.staff('admin:report:update', { id: reportId });
  },

  async removePost(postId: string, actor: AuthUser, reason: string) {
    const p = await one('SELECT id, is_removed, visibility, author_id FROM posts WHERE id = $1', [postId]);
    if (!p) throw notFound('Post');
    if (p.is_removed) return;
    await tx(async (c) => {
      // Removing a flagged post also closes its abuse flag
      await c.query(
        `UPDATE posts SET is_removed = true, removed_reason = $2,
                abuse_reviewed_at = CASE WHEN cardinality(abuse_flags) > 0 THEN coalesce(abuse_reviewed_at, now()) END,
                abuse_reviewed_by = CASE WHEN cardinality(abuse_flags) > 0 THEN coalesce(abuse_reviewed_by, $3) END
          WHERE id = $1`,
        [postId, reason, actor.id],
      );
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'POST_REMOVE', targetId: postId, targetType: 'post', metadata: { reason } }, c);
    });
    if (p.visibility === 'identity' && p.author_id) {
      await notificationService.create({ userId: p.author_id, type: 'moderation', postId, message: `Your post was removed: ${reason}` });
    }
    emit.feed('post:removed', { id: postId });
  },

  async restorePost(postId: string, actor: AuthUser) {
    // A moderator restoring a flagged post has reviewed it — keep the flag closed
    const r = await query(
      `UPDATE posts SET is_removed = false, removed_reason = NULL,
              abuse_reviewed_at = CASE WHEN cardinality(abuse_flags) > 0 THEN coalesce(abuse_reviewed_at, now()) END,
              abuse_reviewed_by = CASE WHEN cardinality(abuse_flags) > 0 THEN coalesce(abuse_reviewed_by, $2) END
        WHERE id = $1 RETURNING id`,
      [postId, actor.id],
    );
    if (!r.rowCount) throw notFound('Post');
    await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'POST_RESTORE', targetId: postId, targetType: 'post' });
  },

  async removeComment(commentId: string, actor: AuthUser, reason: string) {
    const c = await one('SELECT id, post_id, is_removed FROM comments WHERE id = $1', [commentId]);
    if (!c) throw notFound('Comment');
    if (c.is_removed) return;
    await tx(async (cl) => {
      await cl.query('UPDATE comments SET is_removed = true WHERE id = $1', [commentId]);
      await cl.query('UPDATE posts SET comments_count = GREATEST(comments_count - 1, 0) WHERE id = $1', [c.post_id]);
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'COMMENT_REMOVE', targetId: commentId, targetType: 'comment', metadata: { reason } }, cl);
    });
    emit.post(c.post_id, 'comment:removed', { id: commentId });
  },

  async restoreComment(commentId: string, actor: AuthUser) {
    const c = await one('UPDATE comments SET is_removed = false WHERE id = $1 AND is_removed = true RETURNING post_id', [commentId]);
    if (!c) throw notFound('Comment');
    await query('UPDATE posts SET comments_count = comments_count + 1 WHERE id = $1', [c.post_id]);
    await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'COMMENT_RESTORE', targetId: commentId, targetType: 'comment' });
  },

  /** Moderators can only act on users ranked below them. */
  async assertOutranks(actor: AuthUser, targetId: string) {
    const t = await one<{ role: Role }>('SELECT role FROM users WHERE id = $1', [targetId]);
    if (!t) throw notFound('User');
    if (actor.id === targetId) throw forbidden('SELF_ACTION', 'You cannot do that to yourself');
    if (ROLE_RANK[actor.role] <= ROLE_RANK[t.role] && actor.role !== 'admin') throw forbidden('OUTRANKED', 'Target has equal or higher role');
    if (t.role === 'admin' && actor.role === 'admin') throw forbidden('OUTRANKED', 'Admins cannot ban other admins');
    return t;
  },

  async banUser(userId: string, actor: AuthUser, reason: string, durationHours: number | null | undefined) {
    await this.assertOutranks(actor, userId);
    const until = durationHours ? new Date(Date.now() + durationHours * 3_600_000) : null;
    await tx(async (c) => {
      await c.query('UPDATE users SET is_banned = true, ban_reason = $2, banned_until = $3 WHERE id = $1', [userId, reason, until]);
      // Sessions stay alive but are limited to the suspension page (auth middleware answers BANNED everywhere else)
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'USER_BAN', targetId: userId, targetType: 'user', metadata: { reason, until } }, c);
    });
    emit.revoke(userId, { reason: 'banned' });
  },

  /**
   * Admin: permanently delete a report (and every other report on the same item). With `withContent`, the reported
   * post / comment / message is permanently deleted from the database too, with its files. Audit-logged.
   * Profiles are never deleted here (ban the account instead).
   */
  async deleteReport(reportId: string, actor: AuthUser, withContent: boolean) {
    const r = await one<{ id: string; target_type: string; target_id: string }>('SELECT id, target_type, target_id FROM reports WHERE id = $1', [reportId]);
    if (!r) throw notFound('Report');
    if (withContent && r.target_type === 'user') throw badRequest('CANT_DELETE_USER', 'Profiles can\'t be deleted here — ban the account instead');

    let deleted: 'none' | 'post' | 'comment' | 'message' = 'none';
    if (withContent && r.target_type === 'post') deleted = (await purgePost(r.target_id)) ? 'post' : 'none';
    else if (withContent && r.target_type === 'comment') deleted = (await purgeComment(r.target_id)) ? 'comment' : 'none';
    else if (withContent && r.target_type === 'message') deleted = (await purgeMessage(r.target_id)) ? 'message' : 'none';

    const { rowCount } = await query('DELETE FROM reports WHERE target_type = $1 AND target_id = $2', [r.target_type, r.target_id]);
    await auditService.log({
      actorId: actor.id, actorRole: actor.role, action: withContent ? 'REPORT_DELETE_WITH_CONTENT' : 'REPORT_DELETE',
      targetId: r.target_id, targetType: r.target_type, metadata: { reportId, reportsDeleted: rowCount, contentDeleted: deleted },
    });
    emit.staff('admin:report-deleted', { targetType: r.target_type, targetId: r.target_id });
    return { reportsDeleted: rowCount ?? 0, contentDeleted: deleted };
  },

  async unbanUser(userId: string, actor: AuthUser) {
    await this.assertOutranks(actor, userId); // a moderator can't lift a ban on another staff account
    const r = await query('UPDATE users SET is_banned = false, ban_reason = NULL, banned_until = NULL WHERE id = $1 RETURNING id', [userId]);
    if (!r.rowCount) throw notFound('User');
    // Lifting the ban answers any open review request
    await query(
      `UPDATE ban_appeals SET status = 'approved', reviewed_by = $2, reviewed_at = now(), response = COALESCE(response, 'Your account has been restored.')
        WHERE user_id = $1 AND status = 'pending'`,
      [userId, actor.id],
    );
    await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'USER_UNBAN', targetId: userId, targetType: 'user' });
  },
};

// ── permanent deletes used by deleteReport (admin) ──

async function purgePost(postId: string) {
  const row = await one('SELECT id, visibility, author_id, is_share, shared_post_id, media, community_id, is_pending FROM posts WHERE id = $1', [postId]);
  if (!row) return false;
  const files = await tx(async (c) => {
    const { rows: media } = await c.query<{ id: string; object_key: string; storage: 'r2' | 'local' }>('SELECT id, object_key, storage FROM media WHERE post_id = $1', [postId]);
    await c.query(`DELETE FROM reports WHERE target_type = 'comment' AND target_id IN (SELECT id FROM comments WHERE post_id = $1)`, [postId]);
    await c.query('DELETE FROM posts WHERE id = $1', [postId]); // comments, likes, tags, anonymous link, notifications cascade
    await c.query('DELETE FROM media WHERE id = ANY($1::uuid[])', [media.map((m) => m.id)]);
    if (row.community_id) {
      if (!row.is_pending) await c.query('UPDATE communities SET post_count = GREATEST(post_count - 1, 0) WHERE id = $1', [row.community_id]);
    } else if (row.visibility === 'identity' && row.author_id) {
      await c.query('UPDATE users SET post_count = GREATEST(post_count - 1, 0) WHERE id = $1', [row.author_id]);
    }
    if (row.is_share && row.shared_post_id) {
      const { rows } = await c.query('UPDATE posts SET shares_count = GREATEST(shares_count - 1, 0) WHERE id = $1 RETURNING shares_count', [row.shared_post_id]);
      if (rows[0]) emit.feed('post:update', { id: row.shared_post_id, sharesCount: rows[0].shares_count });
    }
    return media;
  });
  for (const f of files) await deleteObject(f.object_key, f.storage).catch(() => {});
  for (const m of (row.media ?? []) as { url: string }[]) await mediaService.releaseIfUnused(m.url);
  if (row.community_id) emit.community(row.community_id, 'post:removed', { id: postId });
  else emit.feed('post:removed', { id: postId });
  return true;
}

async function purgeComment(commentId: string) {
  const c0 = await one('SELECT id, post_id FROM comments WHERE id = $1', [commentId]);
  if (!c0) return false;
  const ids = await tx(async (cl) => {
    const { rows: tree } = await cl.query<{ id: string; is_removed: boolean }>(
      `WITH RECURSIVE t AS (SELECT id, is_removed FROM comments WHERE id = $1
         UNION ALL SELECT c.id, c.is_removed FROM comments c JOIN t ON c.parent_id = t.id) SELECT id, is_removed FROM t`,
      [commentId],
    );
    const all = tree.map((r) => r.id);
    await cl.query(`DELETE FROM reports WHERE target_type = 'comment' AND target_id = ANY($1::uuid[]) AND target_id <> $2`, [all, commentId]);
    await cl.query('DELETE FROM comments WHERE id = $1', [commentId]); // replies, likes, notifications cascade
    const { rows } = await cl.query('UPDATE posts SET comments_count = GREATEST(comments_count - $2, 0) WHERE id = $1 RETURNING comments_count', [c0.post_id, tree.filter((r) => !r.is_removed).length]);
    if (rows[0]) emit.feed('post:update', { id: c0.post_id, commentsCount: rows[0].comments_count });
    return all;
  });
  emit.post(c0.post_id, 'comment:deleted', { id: commentId, ids });
  return true;
}

/** Permanent: an admin's deletion skips the 90-day message archive on purpose. */
async function purgeMessage(messageId: string) {
  const m = await one('SELECT id, conversation_id FROM messages WHERE id = $1', [messageId]);
  if (!m) return false;
  const files = await tx(async (c) => {
    const { rows } = await c.query<{ id: string; object_key: string; storage: 'r2' | 'local' }>(
      `SELECT md.id, md.object_key, md.storage FROM media md WHERE md.message_id = $1
          AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.id <> $1 AND x.media @> jsonb_build_array(jsonb_build_object('id', md.id::text)))`,
      [messageId],
    );
    await c.query('DELETE FROM messages WHERE id = $1', [messageId]); // reactions, edit history, hidden markers cascade
    await c.query('DELETE FROM media WHERE id = ANY($1::uuid[])', [rows.map((r) => r.id)]);
    return rows;
  });
  for (const f of files) await deleteObject(f.object_key, f.storage).catch(() => {});
  const { rows: people } = await query<{ user_id: string }>('SELECT user_id FROM conversation_participants WHERE conversation_id = $1', [m.conversation_id]);
  emit.users(people.map((p) => p.user_id), 'dm:deleted', { conversationId: m.conversation_id, messageId });
  return true;
}

/**
 * Admin "Delete permanently" actions across the control panel. Everything here is erased from the database
 * (and files from storage) and can't be undone; each one writes an audit entry. The audit log itself and
 * investigation case history are deliberately NOT deletable (they're the tamper-evident safeguard).
 */
export const adminPurge = {
  async post(postId: string, actor: AuthUser) {
    const row = await one<{ id: string; visibility: string; content: string }>('SELECT id, visibility, left(content, 120) AS content FROM posts WHERE id = $1', [postId]);
    if (!row) throw notFound('Post');
    await query(`DELETE FROM reports WHERE target_type = 'post' AND target_id = $1`, [postId]);
    await purgePost(postId);
    await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'POST_PURGE', targetId: postId, targetType: 'post', metadata: { visibility: row.visibility, excerpt: row.content } });
    return { ok: true };
  },

  async comment(commentId: string, actor: AuthUser) {
    const row = await one<{ id: string; post_id: string; content: string }>('SELECT id, post_id, left(content, 120) AS content FROM comments WHERE id = $1', [commentId]);
    if (!row) throw notFound('Comment');
    await query(`DELETE FROM reports WHERE target_type = 'comment' AND target_id = $1`, [commentId]);
    await purgeComment(commentId);
    await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'COMMENT_PURGE', targetId: commentId, targetType: 'comment', metadata: { postId: row.post_id, excerpt: row.content } });
    return { ok: true };
  },

  async feedback(id: string, actor: AuthUser) {
    const { rowCount } = await query('DELETE FROM feedback WHERE id = $1', [id]);
    if (!rowCount) throw notFound('Feedback');
    await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'FEEDBACK_DELETE', targetId: id, targetType: 'feedback' });
    return { ok: true };
  },

  async appeal(id: string, actor: AuthUser) {
    const a = await one<{ user_id: string }>('DELETE FROM ban_appeals WHERE id = $1 RETURNING user_id', [id]);
    if (!a) throw notFound('Appeal');
    await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'APPEAL_DELETE', targetId: a.user_id, targetType: 'user', metadata: { appealId: id } });
    return { ok: true };
  },

  /** All reports about one ad (the ad itself is deleted from "Live ads"). */
  async adReports(creativeId: string, actor: AuthUser) {
    const { rowCount } = await query('DELETE FROM ad_reports WHERE creative_id = $1', [creativeId]);
    if (!rowCount) throw notFound('Ad reports');
    await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'AD_REPORTS_DELETE', targetId: creativeId, targetType: 'ad_creative', metadata: { count: rowCount } });
    return { ok: true, deleted: rowCount };
  },

  /** A community that's already deleted (soft), with every post in it and their files. */
  async community(id: string, actor: AuthUser) {
    const c = await one<{ id: string; slug: string; deleted_at: Date | null; icon_url: string | null; banner_url: string | null }>(
      'SELECT id, slug, deleted_at, icon_url, banner_url FROM communities WHERE id = $1', [id],
    );
    if (!c) throw notFound('Community');
    if (!c.deleted_at) throw badRequest('NOT_DELETED', 'Delete the community first, then delete it permanently');
    const { rows: posts } = await query<{ id: string }>('SELECT id FROM posts WHERE community_id = $1', [id]);
    for (const p of posts) {
      await query(`DELETE FROM reports WHERE target_type = 'post' AND target_id = $1`, [p.id]);
      await purgePost(p.id);
    }
    await query('DELETE FROM communities WHERE id = $1', [id]); // members, bans, invites cascade
    await mediaService.releaseIfUnused(c.icon_url);
    await mediaService.releaseIfUnused(c.banner_url);
    await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'COMMUNITY_PURGE', targetId: id, targetType: 'community', metadata: { slug: c.slug, posts: posts.length } });
    return { ok: true, postsDeleted: posts.length };
  },
};
