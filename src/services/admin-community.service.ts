// Platform staff controls for communities (Admin Panel). Every change is written to the hash-chained audit log.
import { one, query, tx } from '../config/db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { emit } from '../lib/realtime.js';
import { cleanText } from '../lib/text.js';
import type { AuthUser } from '../types/index.js';
import { auditService } from './audit.service.js';
import { modLogRows } from './community.service.js';
import { notificationService } from './notification.service.js';

const row = (r: any) => ({
  id: r.id, slug: r.slug, name: r.name, description: r.description, iconUrl: r.icon_url ?? null, bannerUrl: r.banner_url ?? null,
  visibility: r.visibility, anonPolicy: r.anon_policy, postApproval: !!r.post_approval, tags: r.tags ?? [],
  memberCount: r.member_count ?? 0, postCount: r.post_count ?? 0,
  isFeatured: !!r.is_featured, isSuspended: !!r.is_suspended, suspendedReason: r.suspended_reason ?? null,
  deletedAt: r.deleted_at ?? null, createdAt: r.created_at,
  owner: r.owner_id ? { id: r.owner_id, username: r.owner_username, displayName: r.owner_display_name } : null,
  openReports: r.open_reports ?? 0,
});

const SELECT = `
  SELECT c.*, u.username AS owner_username, u.display_name AS owner_display_name,
         (SELECT count(*) FROM reports rp JOIN posts p ON p.id = rp.target_id
           WHERE rp.target_type = 'post' AND rp.status = 'pending' AND p.community_id = c.id)::int AS open_reports
    FROM communities c LEFT JOIN users u ON u.id = c.owner_id`;

async function load(id: string) {
  const c = await one(`${SELECT} WHERE c.id = $1`, [id]);
  if (!c) throw notFound('Community');
  return c;
}

export const adminCommunityService = {
  async list(f: { q?: string; status?: string; page: number; limit: number }) {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (f.q) {
      const like = add(`%${f.q.replace(/[%_\\]/g, '\\$&')}%`);
      where.push(`(c.name ILIKE ${like} OR c.slug ILIKE ${like} OR u.username ILIKE ${like})`);
    }
    if (f.status === 'suspended') where.push('c.is_suspended AND c.deleted_at IS NULL');
    else if (f.status === 'featured') where.push('c.is_featured AND c.deleted_at IS NULL');
    else if (f.status === 'deleted') where.push('c.deleted_at IS NOT NULL');
    else if (f.status === 'private') where.push(`c.visibility <> 'public' AND c.deleted_at IS NULL`);
    else where.push('c.deleted_at IS NULL');
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await one<{ n: number }>(`SELECT count(*)::int AS n FROM communities c LEFT JOIN users u ON u.id = c.owner_id ${w}`, params);
    const { rows } = await query(
      `${SELECT} ${w} ORDER BY c.created_at DESC LIMIT ${add(f.limit)} OFFSET ${add((f.page - 1) * f.limit)}`,
      params,
    );
    return { communities: rows.map(row), total: total?.n ?? 0, page: f.page, limit: f.limit };
  },

  async get(id: string) {
    const c = await load(id);
    const { rows: mods } = await query(
      `SELECT u.id, u.username, u.display_name, m.role FROM community_members m JOIN users u ON u.id = m.user_id
        WHERE m.community_id = $1 AND m.role IN ('owner','mod') ORDER BY (m.role = 'owner') DESC, m.joined_at`,
      [id],
    );
    // Repeat offenders: people community mods removed or banned most often here
    const { rows: offenders } = await query(
      `SELECT t.username, count(*)::int AS actions
         FROM community_mod_log l JOIN users t ON t.id = l.target_user_id
        WHERE l.community_id = $1 AND l.action IN ('POST_REMOVE','MEMBER_REMOVE','MEMBER_BAN','MEMBER_MUTE')
        GROUP BY t.username ORDER BY actions DESC LIMIT 10`,
      [id],
    );
    return {
      community: row(c),
      mods: mods.map((m) => ({ id: m.id, username: m.username, displayName: m.display_name, role: m.role })),
      offenders,
      modLog: await modLogRows(id, 100),
    };
  },

  async setSuspended(id: string, actor: AuthUser, suspended: boolean, reason?: string) {
    const c = await load(id);
    if (c.deleted_at) throw badRequest('DELETED', 'Restore the community first');
    const why = suspended ? cleanText(reason ?? '').slice(0, 300) : null;
    if (suspended && (!why || why.length < 3)) throw badRequest('REASON_REQUIRED', 'Give a reason (at least 3 characters)');
    await tx(async (cl) => {
      await cl.query('UPDATE communities SET is_suspended = $2, suspended_reason = $3, updated_at = now() WHERE id = $1', [id, suspended, why]);
      await auditService.log({
        actorId: actor.id, actorRole: actor.role, action: suspended ? 'COMMUNITY_SUSPEND' : 'COMMUNITY_UNSUSPEND',
        targetId: id, targetType: 'community', metadata: { slug: c.slug, reason: why },
      }, cl);
    });
    if (c.owner_id) {
      await notificationService.create({
        userId: c.owner_id, type: 'moderation',
        message: suspended ? `Your community ${c.name} was suspended: ${why}` : `Your community ${c.name} is active again`,
      }).catch(() => {});
    }
    emit.community(id, 'community:updated', { id });
    return this.get(id);
  },

  async setFeatured(id: string, actor: AuthUser, featured: boolean) {
    const c = await load(id);
    await tx(async (cl) => {
      await cl.query('UPDATE communities SET is_featured = $2, updated_at = now() WHERE id = $1', [id, featured]);
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: featured ? 'COMMUNITY_FEATURE' : 'COMMUNITY_UNFEATURE', targetId: id, targetType: 'community', metadata: { slug: c.slug } }, cl);
    });
    return this.get(id);
  },

  /** Staff can hand a community to another account (e.g. owner banned or gone). The new owner joins if needed. */
  async transfer(id: string, actor: AuthUser, username: string, reason: string) {
    const c = await load(id);
    const why = cleanText(reason).slice(0, 300);
    if (why.length < 3) throw badRequest('REASON_REQUIRED', 'Give a reason (at least 3 characters)');
    const target = await one('SELECT id, username, is_banned FROM users WHERE lower(username) = lower($1)', [username]);
    if (!target) throw notFound('User');
    if (target.is_banned) throw badRequest('BANNED', 'That account is banned');
    if (target.id === c.owner_id) throw badRequest('SAME_OWNER', 'That account already owns this community');
    await tx(async (cl) => {
      await cl.query(`UPDATE community_members SET role = 'mod' WHERE community_id = $1 AND role = 'owner'`, [id]);
      const ins = await cl.query(
        `INSERT INTO community_members (community_id, user_id, role) VALUES ($1, $2, 'owner')
         ON CONFLICT (community_id, user_id) DO UPDATE SET role = 'owner', muted_until = NULL RETURNING (xmax = 0) AS inserted`,
        [id, target.id],
      );
      if (ins.rows[0]?.inserted) await cl.query('UPDATE communities SET member_count = member_count + 1 WHERE id = $1', [id]);
      await cl.query('DELETE FROM community_bans WHERE community_id = $1 AND user_id = $2', [id, target.id]);
      await cl.query('UPDATE communities SET owner_id = $2, updated_at = now() WHERE id = $1', [id, target.id]);
      await cl.query(
        `INSERT INTO community_mod_log (community_id, actor_id, action, target_user_id, reason) VALUES ($1, $2, 'STAFF_OWNERSHIP_TRANSFER', $3, $4)`,
        [id, actor.id, target.id, why],
      );
      await auditService.log({
        actorId: actor.id, actorRole: actor.role, action: 'COMMUNITY_TRANSFER', targetId: id, targetType: 'community',
        metadata: { slug: c.slug, from: c.owner_username ?? null, to: target.username, reason: why },
      }, cl);
    });
    await notificationService.create({ userId: target.id, type: 'moderation', message: `You are now the owner of ${c.name}` }).catch(() => {});
    return this.get(id);
  },

  /** Soft delete / restore. Content stays in the database so the action can be undone. */
  async setDeleted(id: string, actor: AuthUser, deleted: boolean, reason?: string) {
    const c = await load(id);
    const why = cleanText(reason ?? '').slice(0, 300);
    if (deleted && why.length < 3) throw badRequest('REASON_REQUIRED', 'Give a reason (at least 3 characters)');
    if (!deleted && c.deleted_at) {
      const clash = await one('SELECT 1 FROM communities WHERE slug = $1 AND id <> $2 AND deleted_at IS NULL', [c.slug, id]);
      if (clash) throw badRequest('SLUG_TAKEN', 'Another community now uses this link name');
    }
    await tx(async (cl) => {
      await cl.query(`UPDATE communities SET deleted_at = ${deleted ? 'now()' : 'NULL'}, updated_at = now() WHERE id = $1`, [id]);
      await auditService.log({
        actorId: actor.id, actorRole: actor.role, action: deleted ? 'COMMUNITY_DELETE' : 'COMMUNITY_RESTORE',
        targetId: id, targetType: 'community', metadata: { slug: c.slug, reason: why || null },
      }, cl);
    });
    return this.get(id);
  },
};
