import { one, query } from '../config/db.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import { deleteObject } from '../lib/storage.js';
import type { AuthUser } from '../types/index.js';
import { auditService } from './audit.service.js';
import { identityService } from './identity.service.js';

/**
 * Admin investigations — disclosed to users in the Privacy Policy.
 *
 * An admin opens a CASE on one user (admin role + 2FA + written reason, checked by the route). For 30 minutes the
 * case gives access to that user's conversations (including messages deleted or edited in the last 90 days) and to
 * every anonymous post they wrote. Each view is written to the tamper-evident audit log with the case id.
 */
export const CASE_MINUTES = 30;
export const RETENTION_DAYS = 90;

type Case = { id: string; admin_id: string; target_user_id: string; target_username: string; reason: string; expires_at: Date; closed_at: Date | null };

const userShape = (r: any, prefix = '') =>
  r[`${prefix}id`]
    ? { id: r[`${prefix}id`], username: r[`${prefix}username`], displayName: r[`${prefix}display_name`], avatarUrl: r[`${prefix}avatar_url`] ?? null }
    : null;

const publicCase = (c: any) => ({
  id: c.id as string,
  reason: c.reason as string,
  openedAt: new Date(c.opened_at).toISOString(),
  expiresAt: new Date(c.expires_at).toISOString(),
  closedAt: c.closed_at ? new Date(c.closed_at).toISOString() : null,
  active: !c.closed_at && new Date(c.expires_at).getTime() > Date.now(),
  admin: c.admin_username ? { username: c.admin_username as string } : null,
  target: { id: c.target_user_id as string | null, username: c.target_username as string, displayName: (c.target_display_name ?? null) as string | null },
});

/** The case must be this admin's own, still open, and not expired. */
async function activeCase(caseId: string, admin: AuthUser): Promise<Case> {
  const c = await one<Case>('SELECT * FROM investigation_cases WHERE id = $1', [caseId]);
  if (!c) throw notFound('Case');
  if (c.admin_id !== admin.id) throw forbidden('NOT_YOUR_CASE', 'Open your own case to view this');
  if (c.closed_at || c.expires_at.getTime() < Date.now()) throw new AppError(410, 'CASE_EXPIRED', 'This case has ended — open a new one');
  if (!c.target_user_id) throw notFound('User');
  return c;
}

const log = (admin: AuthUser, action: string, c: Case, extra: Record<string, unknown> = {}, targetId = c.target_user_id, targetType = 'user') =>
  auditService.log({ actorId: admin.id, actorRole: admin.role, action, targetId, targetType, metadata: { caseId: c.id, reason: c.reason, target: c.target_username, ...extra } });

export const investigationService = {
  async open(admin: AuthUser, targetUserId: string, reason: string, ipHash: string | null) {
    const t = await one<{ id: string; username: string; role: string }>('SELECT id, username, role FROM users WHERE id = $1', [targetUserId]);
    if (!t) throw notFound('User');
    if (t.id === admin.id) throw forbidden('SELF_ACTION', 'You cannot investigate your own account');
    // Audit first, so even a failed open is on record
    await auditService.log({ actorId: admin.id, actorRole: admin.role, action: 'INVESTIGATION_OPEN', targetId: t.id, targetType: 'user', metadata: { reason, target: t.username, ipHash } });
    const c = await one(
      `INSERT INTO investigation_cases (admin_id, target_user_id, target_username, reason, ip_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' minutes')::interval) RETURNING *`,
      [admin.id, t.id, t.username, reason, ipHash, String(CASE_MINUTES)],
    );
    return this.get(c.id, admin);
  },

  async get(caseId: string, admin: AuthUser) {
    const c = await one(
      `SELECT c.*, a.username AS admin_username, t.display_name AS target_display_name
         FROM investigation_cases c LEFT JOIN users a ON a.id = c.admin_id LEFT JOIN users t ON t.id = c.target_user_id WHERE c.id = $1`,
      [caseId],
    );
    if (!c) throw notFound('Case');
    if (c.admin_id !== admin.id) throw forbidden('NOT_YOUR_CASE', 'This case belongs to another admin');
    return publicCase(c);
  },

  /** Every case by every admin — admins can see each other's investigations. */
  async list(page: number, limit: number) {
    const { rows } = await query(
      `SELECT c.*, a.username AS admin_username, t.display_name AS target_display_name, count(*) OVER() AS total
         FROM investigation_cases c LEFT JOIN users a ON a.id = c.admin_id LEFT JOIN users t ON t.id = c.target_user_id
        ORDER BY c.opened_at DESC LIMIT $1 OFFSET $2`,
      [limit, (page - 1) * limit],
    );
    return { total: rows[0] ? Number(rows[0].total) : 0, items: rows.map(publicCase) };
  },

  async close(caseId: string, admin: AuthUser) {
    const c = await one<Case>('SELECT * FROM investigation_cases WHERE id = $1', [caseId]);
    if (!c) throw notFound('Case');
    if (c.admin_id !== admin.id) throw forbidden('NOT_YOUR_CASE', 'This case belongs to another admin');
    if (!c.closed_at) {
      await query('UPDATE investigation_cases SET closed_at = now() WHERE id = $1', [caseId]);
      await log(admin, 'INVESTIGATION_CLOSE', c);
    }
    return { ok: true };
  },

  /** The target's chats — current ones, ones they left, and ones deleted in the last 90 days. */
  async conversations(caseId: string, admin: AuthUser) {
    const c = await activeCase(caseId, admin);
    const uid = c.target_user_id;
    const { rows } = await query(
      `WITH ids AS (
         SELECT conversation_id AS id FROM conversation_participants WHERE user_id = $1
         UNION SELECT DISTINCT conversation_id FROM messages WHERE sender_id = $1
         UNION SELECT DISTINCT conversation_id FROM message_archive WHERE $1 = ANY(participant_ids) OR sender_id = $1
       )
       SELECT ids.id, cv.id IS NOT NULL AS exists, cv.is_group, cv.title, cv.last_message_at,
              (SELECT count(*) FROM messages m WHERE m.conversation_id = ids.id)::int AS message_count,
              (SELECT count(*) FROM message_archive a WHERE a.conversation_id = ids.id)::int AS deleted_count,
              (SELECT max(a.sent_at) FROM message_archive a WHERE a.conversation_id = ids.id) AS last_deleted_at,
              (SELECT max(a.conversation_title) FROM message_archive a WHERE a.conversation_id = ids.id) AS archived_title,
              (SELECT bool_or(a.is_group) FROM message_archive a WHERE a.conversation_id = ids.id) AS archived_group,
              COALESCE(
                (SELECT jsonb_agg(jsonb_build_object('id', u.id, 'username', u.username, 'displayName', u.display_name, 'avatarUrl', u.avatar_url))
                   FROM conversation_participants p JOIN users u ON u.id = p.user_id WHERE p.conversation_id = ids.id),
                (SELECT jsonb_agg(jsonb_build_object('id', u.id, 'username', u.username, 'displayName', u.display_name, 'avatarUrl', u.avatar_url))
                   FROM users u WHERE u.id = ANY(COALESCE((SELECT a.participant_ids FROM message_archive a WHERE a.conversation_id = ids.id ORDER BY a.deleted_at DESC LIMIT 1), '{}'::uuid[])))
              ) AS participants
         FROM ids LEFT JOIN conversations cv ON cv.id = ids.id
        ORDER BY COALESCE(cv.last_message_at, (SELECT max(a.sent_at) FROM message_archive a WHERE a.conversation_id = ids.id)) DESC NULLS LAST`,
      [uid],
    );
    await log(admin, 'INVESTIGATION_VIEW_CONVERSATIONS', c, { count: rows.length });
    return rows.map((r) => ({
      id: r.id as string,
      deleted: !r.exists,
      isGroup: r.exists ? !!r.is_group : !!r.archived_group,
      title: (r.exists ? r.title : r.archived_title) ?? null,
      lastMessageAt: r.last_message_at ?? r.last_deleted_at ?? null,
      messageCount: r.message_count as number,
      deletedCount: r.deleted_count as number,
      participants: (r.participants ?? []) as { id: string; username: string; displayName: string; avatarUrl: string | null }[],
    }));
  },

  /** One conversation, in full: live messages (incl. ones hidden "for me"), plus deleted and edited versions. */
  async messages(caseId: string, admin: AuthUser, conversationId: string) {
    const c = await activeCase(caseId, admin);
    const uid = c.target_user_id;
    const member = await one(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2)
          OR EXISTS (SELECT 1 FROM messages WHERE conversation_id = $1 AND sender_id = $2)
          OR EXISTS (SELECT 1 FROM message_archive WHERE conversation_id = $1 AND ($2 = ANY(participant_ids) OR sender_id = $2))`,
      [conversationId, uid],
    );
    if (!member) throw forbidden('OUTSIDE_CASE', "This conversation doesn't involve the user in this case");

    const { rows: live } = await query(
      `SELECT m.id, m.kind, m.content, m.media, m.reply_to_id, m.created_at, m.edited_at, m.removed_by_mod, m.is_anonymous,
              u.id AS s_id, u.username AS s_username, u.display_name AS s_display_name, u.avatar_url AS s_avatar_url,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('content', e.previous_content, 'editedAt', e.edited_at) ORDER BY e.edited_at)
                          FROM message_edits e WHERE e.message_id = m.id), '[]'::jsonb) AS edit_history
         FROM messages m LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = $1 ORDER BY m.created_at`,
      [conversationId],
    );
    const { rows: gone } = await query(
      `SELECT a.*, u.id AS s_id, u.username AS s_username, u.display_name AS s_display_name, u.avatar_url AS s_avatar_url
         FROM message_archive a LEFT JOIN users u ON u.id = a.sender_id
        WHERE a.conversation_id = $1 ORDER BY a.sent_at`,
      [conversationId],
    );
    const items = [
      ...live.map((m) => ({
        id: m.id as string, kind: m.kind as string, content: m.content as string, media: m.media ?? [], replyToId: m.reply_to_id ?? null,
        sentAt: new Date(m.created_at).toISOString(), editedAt: m.edited_at ? new Date(m.edited_at).toISOString() : null,
        editHistory: m.edit_history as { content: string; editedAt: string }[],
        deleted: null as null | { reason: string; at: string },
        removedByModerator: !!m.removed_by_mod,
        anonymous: !!m.is_anonymous,
        sender: userShape(m, 's_'),
      })),
      ...gone.map((a) => ({
        id: a.message_id as string, kind: a.kind as string, content: a.content as string, media: a.media ?? [], replyToId: a.reply_to_id ?? null,
        sentAt: new Date(a.sent_at).toISOString(), editedAt: a.edited_at ? new Date(a.edited_at).toISOString() : null,
        editHistory: a.edit_history as { content: string; editedAt: string }[],
        deleted: { reason: a.reason as string, at: new Date(a.deleted_at).toISOString() },
        removedByModerator: false,
        anonymous: !!a.is_anonymous,
        sender: userShape(a, 's_'),
      })),
    ].sort((x, y) => +new Date(x.sentAt) - +new Date(y.sentAt));

    await log(admin, 'INVESTIGATION_VIEW_MESSAGES', c, { conversationId, count: items.length }, conversationId, 'conversation');
    return { conversationId, messages: items };
  },

  /** Every anonymous post the target wrote (de-anonymisation in bulk for this one user). */
  async anonymousPosts(caseId: string, admin: AuthUser) {
    const c = await activeCase(caseId, admin);
    const rows = await identityService.anonymousPostsOf(
      c.target_user_id,
      'id, content, media, community_id, likes_count, comments_count, shares_count, views_count, is_removed, removed_reason, created_at, edited_at, is_share',
    );
    await log(admin, 'INVESTIGATION_VIEW_ANON_POSTS', c, { count: rows.length });
    return rows.map((p) => ({
      id: p.id as string,
      content: p.content as string,
      media: (p.media ?? []) as { url: string; type: string }[],
      isShare: !!p.is_share,
      inCommunity: !!p.community_id,
      likes: p.likes_count, comments: p.comments_count, shares: p.shares_count, views: p.views_count ?? 0,
      removed: !!p.is_removed, removedReason: p.removed_reason ?? null,
      createdAt: new Date(p.created_at).toISOString(),
      editedAt: p.edited_at ? new Date(p.edited_at).toISOString() : null,
    }));
  },
};

/** Worker task: drop archived messages and earlier message versions older than the retention window. */
export async function purgeMessageArchive() {
  const { rows } = await query<{ files: { mediaId: string; objectKey: string; storage: 'r2' | 'local' }[] }>(
    `DELETE FROM message_archive WHERE deleted_at < now() - ($1 || ' days')::interval RETURNING files`,
    [String(RETENTION_DAYS)],
  );
  for (const f of rows.flatMap((r) => r.files ?? [])) {
    // A forwarded copy may still use the same file
    const used = await one(`SELECT 1 FROM messages WHERE media @> jsonb_build_array(jsonb_build_object('id', $1::text)) LIMIT 1`, [f.mediaId]);
    if (used) continue;
    await query('DELETE FROM media WHERE id = $1 AND message_id IS NULL', [f.mediaId]);
    await deleteObject(f.objectKey, f.storage).catch(() => {});
  }
  await query(`DELETE FROM message_edits WHERE edited_at < now() - ($1 || ' days')::interval`, [String(RETENTION_DAYS)]);
}
