import { one, query, tx } from '../config/db.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { emit, onlineCount } from '../lib/realtime.js';
import { storageDriver } from '../lib/storage.js';
import type { AuthUser } from '../types/index.js';
import { effectivePermissions } from '../lib/permissions.js';
import { auditService } from './audit.service.js';
import { notificationService } from './notification.service.js';

const esc = (q: string) => `%${q.replace(/[%_\\]/g, '\\$&')}%`;

function adminUser(r: any) {
  return {
    id: r.id, username: r.username, email: r.email, displayName: r.display_name, bio: r.bio, avatarUrl: r.avatar_url,
    role: r.role, isVerified: r.is_verified, isBanned: r.is_banned, banReason: r.ban_reason, bannedUntil: r.banned_until,
    abuseScore: r.abuse_score, postCount: r.post_count, mfaEnabled: r.mfa_enabled, lastLoginAt: r.last_login_at, createdAt: r.created_at,
    permissions: effectivePermissions(r.role, r.permissions), customPermissions: r.role === 'moderator' && r.permissions !== null,
  };
}

export const adminService = {
  async stats() {
    const totals = await one(`
      SELECT
        (SELECT count(*) FROM users)::int AS users,
        (SELECT count(*) FROM users WHERE created_at > now() - interval '24 hours')::int AS users_today,
        (SELECT count(*) FROM users WHERE is_banned)::int AS banned,
        (SELECT count(*) FROM posts WHERE deleted_at IS NULL)::int AS posts,
        (SELECT count(*) FROM posts WHERE deleted_at IS NULL AND visibility = 'identity')::int AS identity_posts,
        (SELECT count(*) FROM posts WHERE deleted_at IS NULL AND visibility = 'anonymous')::int AS anon_posts,
        (SELECT count(*) FROM posts WHERE created_at > now() - interval '24 hours')::int AS posts_today,
        (SELECT count(*) FROM posts WHERE is_removed)::int AS removed_posts,
        (SELECT count(*) FROM comments)::int AS comments,
        (SELECT count(*) FROM messages WHERE kind <> 'system')::int AS messages,
        (SELECT count(*) FROM conversations)::int AS conversations,
        (SELECT count(*) FROM post_likes)::int AS likes,
        (SELECT count(*) FROM reports WHERE status = 'pending')::int AS pending_reports,
        (SELECT count(*) FROM posts WHERE cardinality(abuse_flags) > 0 AND deleted_at IS NULL)::int AS flagged_posts,
        (SELECT count(*) FROM sessions WHERE revoked_at IS NULL AND expires_at > now())::int AS active_sessions,
        (SELECT coalesce(sum(size_bytes),0) FROM media WHERE status <> 'pending')::bigint AS media_bytes
    `);
    const series = await query(`
      WITH days AS (SELECT generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') AS d)
      SELECT to_char(d, 'YYYY-MM-DD') AS date,
             (SELECT count(*) FROM users u WHERE date_trunc('day', u.created_at) = d)::int AS signups,
             (SELECT count(*) FROM posts p WHERE date_trunc('day', p.created_at) = d AND p.visibility = 'identity')::int AS identity,
             (SELECT count(*) FROM posts p WHERE date_trunc('day', p.created_at) = d AND p.visibility = 'anonymous')::int AS anonymous,
             (SELECT count(*) FROM comments c WHERE date_trunc('day', c.created_at) = d)::int AS comments
        FROM days ORDER BY d`);
    const recent = await query(`SELECT id, action, actor_role, target_type, created_at FROM audit_logs ORDER BY id DESC LIMIT 8`);
    return {
      totals: { ...totals, media_bytes: Number(totals.media_bytes), online: onlineCount(), storage: storageDriver },
      series: series.rows,
      recentActivity: recent.rows,
    };
  },

  async listUsers(f: { q?: string; role?: string; status?: string; page: number; limit: number }) {
    const where: string[] = [];
    const params: unknown[] = [f.limit, (f.page - 1) * f.limit];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (f.q) { const p = add(esc(f.q)); where.push(`(username ILIKE ${p} OR email ILIKE ${p} OR display_name ILIKE ${p})`); }
    if (f.role) where.push(`role = ${add(f.role)}`);
    if (f.status === 'banned') where.push('is_banned');
    if (f.status === 'active') where.push('NOT is_banned');
    if (f.status === 'unverified') where.push('NOT is_verified');
    if (f.status === 'flagged') where.push('abuse_score > 0');
    const { rows } = await query(
      `SELECT *, count(*) OVER() AS total FROM users ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      params,
    );
    return { items: rows.map(adminUser), total: rows[0]?.total ?? 0 };
  },

  async getUser(id: string) {
    const r = await one('SELECT * FROM users WHERE id = $1', [id]);
    if (!r) throw notFound('User');
    const extra = await one(
      `SELECT (SELECT count(*) FROM comments WHERE author_id = $1)::int AS comments,
              (SELECT count(*) FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now())::int AS sessions,
              (SELECT count(*) FROM reports WHERE reporter_id = $1)::int AS reports_filed,
              (SELECT count(*) FROM known_devices WHERE user_id = $1)::int AS devices`,
      [id],
    );
    // NOTE: anonymous posts are deliberately NOT listed — that requires an audited identity lookup per post.
    const posts = await query(
      `SELECT id, content, likes_count, comments_count, is_removed, created_at FROM posts
        WHERE author_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10`,
      [id],
    );
    return { ...adminUser(r), stats: extra, recentPosts: posts.rows };
  },

  async updateUser(id: string, actor: AuthUser, input: any) {
    const target = await one('SELECT id, role FROM users WHERE id = $1', [id]);
    if (!target) throw notFound('User');
    if (input.role && id === actor.id) throw forbidden('SELF_ACTION', 'You cannot change your own role');
    if (input.role === 'user' && target.role === 'admin') {
      const admins = await one<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE role = 'admin'`);
      if ((admins?.n ?? 0) <= 1) throw badRequest('LAST_ADMIN', 'Cannot demote the last admin');
    }
    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (input.role) set('role', input.role);
    if (input.isVerified !== undefined) set('is_verified', input.isVerified);
    if (input.displayName) set('display_name', input.displayName);
    if (input.bio !== undefined) set('bio', input.bio);
    if (input.resetAbuseScore) sets.push('abuse_score = 0');
    if (input.removeAvatar) sets.push('avatar_url = NULL');
    if (!sets.length) return this.getUser(id);

    await tx(async (c) => {
      await c.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params);
      // Role change: force re-login so new privileges are reflected everywhere
      if (input.role && input.role !== target.role) await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      await auditService.log({
        actorId: actor.id, actorRole: actor.role, action: input.role && input.role !== target.role ? 'USER_ROLE_CHANGE' : 'USER_UPDATE',
        targetId: id, targetType: 'user', metadata: { changes: input, previousRole: target.role },
      }, c);
    });
    if (input.role && input.role !== target.role) emit.user(id, 'session:revoked', { reason: 'role_changed' });
    return this.getUser(id);
  },

  async deleteUser(id: string, actor: AuthUser) {
    if (id === actor.id) throw forbidden('SELF_ACTION', 'You cannot delete yourself');
    const t = await one('SELECT username, role FROM users WHERE id = $1', [id]);
    if (!t) throw notFound('User');
    if (t.role === 'admin') throw forbidden('OUTRANKED', 'Demote the admin before deleting');
    await tx(async (c) => {
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'USER_DELETE', targetId: id, targetType: 'user', metadata: { username: t.username } }, c);
      await c.query('DELETE FROM users WHERE id = $1', [id]);
    });
    emit.user(id, 'session:revoked', { reason: 'deleted' });
  },

  async revokeSessions(id: string, actor: AuthUser) {
    await query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'SESSIONS_REVOKE', targetId: id, targetType: 'user' });
    emit.user(id, 'session:revoked', { reason: 'admin' });
  },

  /** Choose a moderator's permissions (null = back to the default moderator set). Audited; applies on their next request. */
  async setPermissions(id: string, actor: AuthUser, permissions: string[] | null) {
    const u = await one<{ role: string }>('SELECT role FROM users WHERE id = $1', [id]);
    if (!u) throw notFound('User');
    if (u.role !== 'moderator') throw badRequest('NOT_MODERATOR', 'Permissions can only be set for moderators (admins already have full access)');
    const clean = permissions ? [...new Set(permissions)] : null;
    await query('UPDATE users SET permissions = $2 WHERE id = $1', [id, clean]);
    await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'PERMISSIONS_UPDATE', targetId: id, targetType: 'user', metadata: { permissions: clean ?? 'default' } });
    emit.user(id, 'permissions:update', {});
    return { permissions: effectivePermissions('moderator', clean), custom: clean !== null };
  },

  /** Turn off 2FA for a user who lost their authenticator (audited; they're signed out everywhere and notified). */
  async resetMfa(id: string, actor: AuthUser) {
    if (id === actor.id) throw badRequest('USE_ACCOUNT_PAGE', 'Turn off your own 2FA from My account (needs your password and a code)');
    const u = await one<{ mfa_enabled: boolean }>('SELECT mfa_enabled FROM users WHERE id = $1', [id]);
    if (!u) throw notFound('User');
    if (!u.mfa_enabled) throw badRequest('MFA_NOT_ENABLED', '2FA is already off for this user');
    await query('UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL WHERE id = $1', [id]);
    await query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'MFA_RESET', targetId: id, targetType: 'user' });
    await notificationService.create({ userId: id, type: 'security', message: 'An administrator turned off two-factor authentication on your account. Set it up again in Settings → Security.' });
    emit.user(id, 'session:revoked', { reason: 'admin' });
  },

  async listPosts(f: { q?: string; visibility?: string; status?: string; page: number; limit: number }) {
    const where: string[] = ['p.deleted_at IS NULL'];
    const params: unknown[] = [f.limit, (f.page - 1) * f.limit];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (f.q) where.push(`p.content ILIKE ${add(esc(f.q))}`);
    if (f.visibility) where.push(`p.visibility = ${add(f.visibility)}`);
    if (f.status === 'removed') where.push('p.is_removed');
    if (f.status === 'live') where.push('NOT p.is_removed');
    if (f.status === 'flagged') where.push('cardinality(p.abuse_flags) > 0');
    if (f.status === 'reported') where.push('p.reports_count > 0');
    const { rows } = await query(
      `SELECT p.id, p.content, p.media, p.visibility, p.likes_count, p.comments_count, p.reports_count, p.is_removed,
              p.removed_reason, p.abuse_flags, p.created_at, u.username AS author_username, u.display_name AS author_display_name,
              count(*) OVER() AS total
         FROM posts p LEFT JOIN users u ON u.id = p.author_id
        WHERE ${where.join(' AND ')}
        ORDER BY p.created_at DESC LIMIT $1 OFFSET $2`,
      params,
    );
    return {
      total: rows[0]?.total ?? 0,
      items: rows.map((r) => ({
        id: r.id, content: r.content, media: r.media, visibility: r.visibility, likesCount: r.likes_count,
        commentsCount: r.comments_count, reportsCount: r.reports_count, isRemoved: r.is_removed, removedReason: r.removed_reason,
        abuseFlags: r.abuse_flags, createdAt: r.created_at,
        // Even staff list views never reveal anonymous authors
        author: r.visibility === 'identity' ? { username: r.author_username, displayName: r.author_display_name } : null,
      })),
    };
  },

  async listComments(f: { q?: string; status?: string; page: number; limit: number }) {
    const where: string[] = [];
    const params: unknown[] = [f.limit, (f.page - 1) * f.limit];
    if (f.q) { params.push(esc(f.q)); where.push(`c.content ILIKE $${params.length}`); }
    if (f.status === 'removed') where.push('c.is_removed');
    if (f.status === 'live') where.push('NOT c.is_removed');
    const { rows } = await query(
      `SELECT c.*, u.username, count(*) OVER() AS total FROM comments c LEFT JOIN users u ON u.id = c.author_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.created_at DESC LIMIT $1 OFFSET $2`,
      params,
    );
    return {
      total: rows[0]?.total ?? 0,
      items: rows.map((r) => ({
        id: r.id, postId: r.post_id, parentId: r.parent_id, content: r.content, author: r.username,
        likesCount: r.likes_count, isRemoved: r.is_removed, createdAt: r.created_at,
      })),
    };
  },

  async auditLogs(f: { actorId?: string; action?: string; from?: Date; to?: Date; page: number; limit: number }) {
    const where: string[] = [];
    const params: unknown[] = [f.limit, (f.page - 1) * f.limit];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (f.actorId) where.push(`a.actor_id = ${add(f.actorId)}`);
    if (f.action) where.push(`a.action = ${add(f.action)}`);
    if (f.from) where.push(`a.created_at >= ${add(f.from)}`);
    if (f.to) where.push(`a.created_at <= ${add(f.to)}`);
    const { rows } = await query(
      `SELECT a.*, u.username AS actor_username, count(*) OVER() AS total
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY a.id DESC LIMIT $1 OFFSET $2`,
      params,
    );
    const actions = await query('SELECT DISTINCT action FROM audit_logs ORDER BY action');
    return {
      total: rows[0]?.total ?? 0,
      actions: actions.rows.map((r) => r.action),
      items: rows.map((r) => ({
        id: r.id, actorId: r.actor_id, actorUsername: r.actor_username, actorRole: r.actor_role, action: r.action,
        targetId: r.target_id, targetType: r.target_type, metadata: r.metadata, createdAt: r.created_at,
        signatureValid: auditService.verifyRow(r),
      })),
    };
  },
};
