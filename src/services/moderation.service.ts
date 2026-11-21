import { one, query, tx } from '../config/db.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { emit } from '../lib/realtime.js';
import { ROLE_RANK, type AuthUser, type Role } from '../types/index.js';
import { auditService } from './audit.service.js';
import { notificationService } from './notification.service.js';
import { messageService } from './message.service.js';

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
              msg.unsent_at AS message_unsent, ma.username AS message_author_username,
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
                  content: r.message_content, media: r.message_media ?? [], author: r.message_author_username,
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
      await c.query('UPDATE posts SET is_removed = true, removed_reason = $2 WHERE id = $1', [postId, reason]);
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'POST_REMOVE', targetId: postId, targetType: 'post', metadata: { reason } }, c);
    });
    if (p.visibility === 'identity' && p.author_id) {
      await notificationService.create({ userId: p.author_id, type: 'moderation', postId, message: `Your post was removed: ${reason}` });
    }
    emit.feed('post:removed', { id: postId });
  },

  async restorePost(postId: string, actor: AuthUser) {
    const r = await query('UPDATE posts SET is_removed = false, removed_reason = NULL WHERE id = $1 RETURNING id', [postId]);
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
      await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'USER_BAN', targetId: userId, targetType: 'user', metadata: { reason, until } }, c);
    });
    emit.user(userId, 'session:revoked', { reason: 'banned' });
  },

  async unbanUser(userId: string, actor: AuthUser) {
    const r = await query('UPDATE users SET is_banned = false, ban_reason = NULL, banned_until = NULL WHERE id = $1 RETURNING id', [userId]);
    if (!r.rowCount) throw notFound('User');
    await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'USER_UNBAN', targetId: userId, targetType: 'user' });
  },
};
