// ═══════════════════════════════════════════════════════════════
// Communities — spaces with their own rules, mods and anonymous-posting policy.
//
// Security rules (see DualSphere Next architecture):
//  • Community roles are separate from platform roles; owners/mods never get Admin Panel powers.
//  • Owners/mods can hide posts and remove members, but can NEVER unmask anonymous authors.
//    Nothing here reads anonymous_post_links; ownership checks go through identityService (HMAC only).
//  • Private/invite-only content is only ever returned to members (or platform staff with posts.view).
//    Invite-only communities answer "not found" to everyone else, so their existence doesn't leak.
//  • Every owner/mod action is written to community_mod_log for platform staff.
// ═══════════════════════════════════════════════════════════════
import type { PoolClient } from 'pg';
import { one, query, tx } from '../config/db.js';
import { randomToken } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { emit } from '../lib/realtime.js';
import { decodeCursor, encodeCursor, publicUser } from '../lib/serialize.js';
import { cleanText } from '../lib/text.js';
import { isStaff } from '../middleware/rbac.middleware.js';
import type { AuthUser, Visibility } from '../types/index.js';
import { hydratePosts, POST_COLUMNS } from './feed.service.js';
import { identityService } from './identity.service.js';
import { mediaService } from './media.service.js';
import { notificationService } from './notification.service.js';
import { getSettings } from './settings.service.js';

export type CommunityRole = 'owner' | 'mod' | 'member';
export type CommunityVisibility = 'public' | 'private' | 'invite_only';
export type AnonPolicy = 'off' | 'allowed' | 'anon_only';

const RANK: Record<CommunityRole, number> = { member: 1, mod: 2, owner: 3 };
const MAX_OWNED = 10;
const MAX_CREATED_PER_DAY = 3;
const MAX_PINNED = 3;
const MAX_RULES = 15;
const RESERVED_SLUGS = new Set([
  'new', 'create', 'admin', 'administrator', 'api', 'settings', 'discover', 'explore', 'mine', 'popular', 'all', 'search',
  'help', 'support', 'dualsphere', 'official', 'staff', 'moderator', 'mod', 'mods', 'security', 'login', 'signup', 'feed',
]);

interface Ctx {
  c: any;
  role: CommunityRole | null;
  banned: boolean;
  requested: boolean;
  mutedUntil: Date | null;
  staff: boolean; // platform staff allowed to view content for moderation
}

/** Platform staff who can browse posts may look inside any community (read-only) for moderation. */
const staffViewer = (v?: AuthUser) => !!v && isStaff(v.role) && v.permissions.includes('posts.view');

async function load(where: 'slug' | 'id', value: string, viewer?: AuthUser): Promise<Ctx> {
  const c = await one(`SELECT * FROM communities WHERE ${where === 'slug' ? 'slug = lower($1)' : 'id = $1'} AND deleted_at IS NULL`, [value]);
  if (!c) throw notFound('Community');
  let role: CommunityRole | null = null;
  let banned = false;
  let requested = false;
  let mutedUntil: Date | null = null;
  if (viewer) {
    const r = await one<{ role: CommunityRole | null; muted_until: Date | null; banned: boolean; requested: boolean }>(
      `SELECT (SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2) AS role,
              (SELECT muted_until FROM community_members WHERE community_id = $1 AND user_id = $2) AS muted_until,
              EXISTS (SELECT 1 FROM community_bans WHERE community_id = $1 AND user_id = $2) AS banned,
              EXISTS (SELECT 1 FROM community_join_requests WHERE community_id = $1 AND user_id = $2) AS requested`,
      [c.id, viewer.id],
    );
    role = r?.role ?? null;
    banned = !!r?.banned;
    requested = !!r?.requested;
    mutedUntil = r?.muted_until && new Date(r.muted_until) > new Date() ? new Date(r.muted_until) : null;
  }
  return { c, role, banned, requested, mutedUntil, staff: staffViewer(viewer) };
}

/** Can this viewer see the community page at all? Invite-only stays invisible to non-members. */
function canSeePage(x: Ctx) {
  if (x.staff) return true;
  if (x.c.visibility === 'invite_only') return !!x.role;
  return true;
}

/** Can this viewer see posts and members? */
function canSeeContent(x: Ctx) {
  if (x.staff) return true;
  if (x.c.is_suspended) return false;
  if (x.c.visibility === 'public') return true;
  return !!x.role;
}

function requireRank(x: Ctx, min: CommunityRole) {
  if (!x.role || RANK[x.role] < RANK[min]) {
    throw forbidden('COMMUNITY_FORBIDDEN', min === 'owner' ? 'Only the community owner can do this' : 'Only community moderators can do this');
  }
  if (x.c.is_suspended) throw forbidden('COMMUNITY_SUSPENDED', 'This community is suspended');
}

async function logAction(
  c: PoolClient | null,
  e: { communityId: string; actorId: string; action: string; targetUserId?: string | null; targetPostId?: string | null; reason?: string | null },
) {
  const sql = `INSERT INTO community_mod_log (community_id, actor_id, action, target_user_id, target_post_id, reason) VALUES ($1, $2, $3, $4, $5, $6)`;
  const params = [e.communityId, e.actorId, e.action, e.targetUserId ?? null, e.targetPostId ?? null, e.reason ?? null];
  if (c) await c.query(sql, params);
  else await query(sql, params);
}

function serialize(x: Ctx, owner?: any) {
  const c = x.c;
  const showDetails = canSeePage(x);
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    description: showDetails ? c.description : '',
    iconUrl: c.icon_url ?? null,
    bannerUrl: c.banner_url ?? null,
    visibility: c.visibility as CommunityVisibility,
    anonPolicy: c.anon_policy as AnonPolicy,
    postApproval: !!c.post_approval,
    tags: (c.tags ?? []) as string[],
    memberCount: c.member_count ?? 0,
    postCount: c.post_count ?? 0,
    isFeatured: !!c.is_featured,
    isSuspended: !!c.is_suspended,
    suspendedReason: c.is_suspended ? (c.suspended_reason ?? null) : null,
    createdAt: new Date(c.created_at).toISOString(),
    owner: owner ? { id: owner.id, username: owner.username, displayName: owner.display_name, avatarUrl: owner.avatar_url ?? null } : null,
    viewer: {
      role: x.role,
      isMember: !!x.role,
      isBanned: x.banned,
      hasRequested: x.requested,
      mutedUntil: x.mutedUntil ? x.mutedUntil.toISOString() : null,
      canSeeContent: canSeeContent(x),
      canPost: !!x.role && !x.banned && !x.mutedUntil && !c.is_suspended,
      canModerate: !!x.role && RANK[x.role] >= RANK.mod && !c.is_suspended,
      isOwner: x.role === 'owner',
    },
  };
}

function listItem(r: any) {
  return {
    id: r.id, slug: r.slug, name: r.name, description: r.description, iconUrl: r.icon_url ?? null, bannerUrl: r.banner_url ?? null,
    visibility: r.visibility, anonPolicy: r.anon_policy, memberCount: r.member_count ?? 0, postCount: r.post_count ?? 0,
    isFeatured: !!r.is_featured, tags: r.tags ?? [], role: (r.role ?? null) as CommunityRole | null,
  };
}

function assertSlug(slug: string) {
  if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(slug) || slug.includes('--')) {
    throw badRequest('BAD_SLUG', 'Link name: 3–32 lowercase letters, numbers or single dashes');
  }
  if (RESERVED_SLUGS.has(slug)) throw badRequest('SLUG_RESERVED', 'That link name is reserved');
}

const cleanTags = (tags: string[] | undefined) => {
  const seen = new Set<string>();
  return (tags ?? [])
    .map((t) => cleanText(t).toLowerCase().replace(/[^a-z0-9ঀ-৿-]/g, '').slice(0, 24))
    .filter((t) => t && !seen.has(t) && seen.add(t))
    .slice(0, 5);
};

async function memberRole(communityId: string, userId: string, c?: PoolClient) {
  const sql = 'SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2';
  const r = c ? (await c.query(sql, [communityId, userId])).rows[0] : await one(sql, [communityId, userId]);
  return (r?.role ?? null) as CommunityRole | null;
}

async function addMember(c: PoolClient, communityId: string, userId: string, role: CommunityRole = 'member') {
  const ins = await c.query(
    'INSERT INTO community_members (community_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [communityId, userId, role],
  );
  if (ins.rowCount) await c.query('UPDATE communities SET member_count = member_count + 1 WHERE id = $1', [communityId]);
  await c.query('DELETE FROM community_join_requests WHERE community_id = $1 AND user_id = $2', [communityId, userId]);
  return !!ins.rowCount;
}

async function dropMember(c: PoolClient, communityId: string, userId: string) {
  const del = await c.query('DELETE FROM community_members WHERE community_id = $1 AND user_id = $2', [communityId, userId]);
  if (del.rowCount) await c.query('UPDATE communities SET member_count = GREATEST(member_count - 1, 0) WHERE id = $1', [communityId]);
}

/** Validates an invite code for this community and consumes one use (inside the caller's transaction). */
async function consumeInvite(c: PoolClient, communityId: string, code: string) {
  const r = await c.query(
    `UPDATE community_invites SET uses = uses + 1
      WHERE code = $1 AND community_id = $2 AND revoked_at IS NULL AND expires_at > now() AND uses < max_uses
      RETURNING code`,
    [code, communityId],
  );
  return !!r.rowCount;
}

// ── Post access (used by post.service for every post action) ──────────────────────

/**
 * Throws "not found" unless the viewer may see this community post.
 * Called for the post page, comments, likes, saves and shares, so private content can't leak through any of them.
 */
export async function assertCommunityPostVisible(row: { id: string; community_id: string | null; is_pending?: boolean; visibility: string; author_id: string | null }, viewer?: AuthUser) {
  if (!row.community_id) return;
  const x = await load('id', row.community_id, viewer).catch(() => null);
  if (!x || !canSeeContent(x)) throw notFound('Post');
  if (row.is_pending && !x.staff) {
    const isMod = !!x.role && RANK[x.role] >= RANK.mod;
    const isAuthor = !!viewer && (row.visibility === 'identity'
      ? row.author_id === viewer.id
      : (await identityService.ownedBy([row.id], viewer.id)).has(row.id));
    if (!isMod && !isAuthor) throw notFound('Post');
  }
}

/** Realtime: may this socket join the live room of a post? (Community posts follow the same rules as above.) */
export async function canWatchPost(postId: string, viewer?: AuthUser) {
  const row = await one('SELECT id, community_id, is_pending, visibility, author_id FROM posts WHERE id = $1 AND deleted_at IS NULL', [postId]);
  if (!row) return false;
  try { await assertCommunityPostVisible(row, viewer); return true; } catch { return false; }
}

/** Realtime: may this socket join the live room of a community? */
export async function canWatchCommunity(communityId: string, viewer?: AuthUser) {
  const x = await load('id', communityId, viewer).catch(() => null);
  return !!x && canSeeContent(x);
}

/**
 * Before a post is stored in a community: membership, bans, mutes and the anonymous policy.
 * Membership is read only to decide; nothing linking an anonymous post to its author is stored here.
 */
export async function preparePostInCommunity(communityId: string, user: AuthUser, mode: Visibility) {
  const c = await one('SELECT * FROM communities WHERE id = $1 AND deleted_at IS NULL', [communityId]);
  if (!c) throw notFound('Community');
  if (c.is_suspended) throw forbidden('COMMUNITY_SUSPENDED', 'This community is suspended');
  const m = await one<{ role: CommunityRole; muted_until: Date | null }>(
    'SELECT role, muted_until FROM community_members WHERE community_id = $1 AND user_id = $2',
    [communityId, user.id],
  );
  if (!m) throw forbidden('NOT_A_MEMBER', 'Join the community to post here');
  if (m.muted_until && new Date(m.muted_until) > new Date()) throw forbidden('MUTED', 'You are muted in this community');
  if (mode === 'anonymous' && c.anon_policy === 'off') throw forbidden('ANON_OFF', 'This community does not allow anonymous posts');
  if (mode === 'identity' && c.anon_policy === 'anon_only') throw forbidden('ANON_ONLY', 'This community only allows anonymous posts');
  return { community: c, pending: !!c.post_approval && m.role === 'member' };
}

/** After a community post is stored: live push to the community room only (never the global feed). */
export async function announceCommunityPost(communityId: string, post: unknown, pending: boolean) {
  if (pending) emit.community(communityId, 'community:pending', { communityId });
  else emit.community(communityId, 'post:new', post);
}

// ── Service ───────────────────────────────────────────────────────────────────────

export const communityService = {
  async create(user: AuthUser, input: { name: string; slug: string; description?: string; visibility: CommunityVisibility; anonPolicy: AnonPolicy; postApproval?: boolean; tags?: string[] }) {
    if (getSettings().features.requireEmailVerification && !user.isVerified) throw forbidden('EMAIL_NOT_VERIFIED', 'Verify your email before creating a community');
    const slug = input.slug.trim().toLowerCase();
    assertSlug(slug);
    const name = cleanText(input.name).slice(0, 60);
    if (name.length < 3) throw badRequest('BAD_NAME', 'Name must be at least 3 characters');

    const counts = await one<{ owned: number; today: number }>(
      `SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS owned,
              count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS today
         FROM communities WHERE owner_id = $1`,
      [user.id],
    );
    if ((counts?.owned ?? 0) >= MAX_OWNED) throw forbidden('COMMUNITY_LIMIT', `You can own up to ${MAX_OWNED} communities`);
    if ((counts?.today ?? 0) >= MAX_CREATED_PER_DAY) throw forbidden('COMMUNITY_RATE', 'You can create up to 3 communities a day');

    try {
      const id = await tx(async (c) => {
        const { rows } = await c.query(
          `INSERT INTO communities (slug, name, description, visibility, anon_policy, post_approval, tags, owner_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [slug, name, cleanText(input.description ?? '').slice(0, 1000), input.visibility, input.anonPolicy, !!input.postApproval, cleanTags(input.tags), user.id],
        );
        await addMember(c, rows[0].id, user.id, 'owner');
        await logAction(c, { communityId: rows[0].id, actorId: user.id, action: 'COMMUNITY_CREATE' });
        return rows[0].id as string;
      });
      return this.get(id, user, 'id');
    } catch (err: any) {
      if (err?.code === '23505') throw conflict('SLUG_TAKEN', 'That link name is already taken');
      throw err;
    }
  },

  async get(slugOrId: string, viewer?: AuthUser, by: 'slug' | 'id' = 'slug', invite?: string) {
    const x = await load(by, slugOrId, viewer);
    if (!canSeePage(x)) {
      // Invite-only: visible with a valid invite link (name + description only), otherwise it doesn't exist
      if (!invite) throw notFound('Community');
      const ok = await one(
        `SELECT 1 FROM community_invites WHERE code = $1 AND community_id = $2 AND revoked_at IS NULL AND expires_at > now() AND uses < max_uses`,
        [invite, x.c.id],
      );
      if (!ok) throw notFound('Community');
      return { community: { ...serialize(x), description: x.c.description, viaInvite: true }, rules: [] };
    }
    const owner = x.c.owner_id ? await one('SELECT id, username, display_name, avatar_url FROM users WHERE id = $1 AND is_banned = false', [x.c.owner_id]) : null;
    const { rows: rules } = await query('SELECT id, title, body FROM community_rules WHERE community_id = $1 ORDER BY position, id', [x.c.id]);
    return { community: serialize(x, owner), rules };
  },

  /** Discover: public + private communities (never invite-only), featured first. */
  async discover(viewer: AuthUser | undefined, q: string | undefined, page: number, limit: number) {
    const params: unknown[] = [];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where = [`c.deleted_at IS NULL`, `NOT c.is_suspended`, `c.visibility <> 'invite_only'`];
    if (q) {
      const like = add(`%${q.replace(/[%_\\]/g, '\\$&')}%`);
      where.push(`(c.name ILIKE ${like} OR c.slug ILIKE ${like} OR c.description ILIKE ${like} OR ${add(q.toLowerCase())} = ANY(c.tags))`);
    }
    const roleSql = viewer ? `(SELECT role FROM community_members m WHERE m.community_id = c.id AND m.user_id = ${add(viewer.id)})` : 'NULL';
    const { rows } = await query(
      `SELECT c.*, ${roleSql} AS role FROM communities c WHERE ${where.join(' AND ')}
        ORDER BY c.is_featured DESC, c.member_count DESC, c.created_at DESC
        LIMIT ${add(limit + 1)} OFFSET ${add((page - 1) * limit)}`,
      params,
    );
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return { communities: rows.map(listItem), hasMore };
  },

  async mine(user: AuthUser) {
    const { rows } = await query(
      `SELECT c.*, m.role FROM community_members m JOIN communities c ON c.id = m.community_id
        WHERE m.user_id = $1 AND c.deleted_at IS NULL
        ORDER BY (m.role = 'owner') DESC, (m.role = 'mod') DESC, m.joined_at DESC LIMIT 200`,
      [user.id],
    );
    return { communities: rows.map(listItem) };
  },

  async update(slug: string, user: AuthUser, input: {
    name?: string; description?: string; visibility?: CommunityVisibility; anonPolicy?: AnonPolicy; postApproval?: boolean; tags?: string[];
    iconMediaId?: string | null; bannerMediaId?: string | null;
  }) {
    const x = await load('slug', slug, user);
    requireRank(x, 'owner');
    const sets: string[] = [];
    const params: unknown[] = [x.c.id];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (input.name !== undefined) {
      const name = cleanText(input.name).slice(0, 60);
      if (name.length < 3) throw badRequest('BAD_NAME', 'Name must be at least 3 characters');
      set('name', name);
    }
    if (input.description !== undefined) set('description', cleanText(input.description).slice(0, 1000));
    if (input.visibility !== undefined) set('visibility', input.visibility);
    if (input.anonPolicy !== undefined) set('anon_policy', input.anonPolicy);
    if (input.postApproval !== undefined) set('post_approval', input.postApproval);
    if (input.tags !== undefined) set('tags', cleanTags(input.tags));
    const old = { icon: x.c.icon_url as string | null, banner: x.c.banner_url as string | null };
    if (input.iconMediaId !== undefined) set('icon_url', input.iconMediaId ? await mediaService.useForCommunity(user.id, input.iconMediaId) : null);
    if (input.bannerMediaId !== undefined) set('banner_url', input.bannerMediaId ? await mediaService.useForCommunity(user.id, input.bannerMediaId) : null);
    if (!sets.length) return this.get(slug, user);
    sets.push('updated_at = now()');
    await tx(async (c) => {
      await c.query(`UPDATE communities SET ${sets.join(', ')} WHERE id = $1`, params);
      await logAction(c, { communityId: x.c.id, actorId: user.id, action: 'COMMUNITY_UPDATE', reason: Object.keys(input).join(', ') });
    });
    if (input.iconMediaId !== undefined) await mediaService.releaseIfUnused(old.icon);
    if (input.bannerMediaId !== undefined) await mediaService.releaseIfUnused(old.banner);
    return this.get(slug, user);
  },

  /** Owners and mods can edit the rules list (replaced as a whole). */
  async setRules(slug: string, user: AuthUser, rules: { title: string; body?: string }[]) {
    const x = await load('slug', slug, user);
    requireRank(x, 'mod');
    const clean = rules.slice(0, MAX_RULES).map((r) => ({ title: cleanText(r.title).slice(0, 100), body: cleanText(r.body ?? '').slice(0, 500) })).filter((r) => r.title);
    await tx(async (c) => {
      await c.query('DELETE FROM community_rules WHERE community_id = $1', [x.c.id]);
      for (const [i, r] of clean.entries()) {
        await c.query('INSERT INTO community_rules (community_id, position, title, body) VALUES ($1, $2, $3, $4)', [x.c.id, i, r.title, r.body]);
      }
      await logAction(c, { communityId: x.c.id, actorId: user.id, action: 'RULES_UPDATE' });
    });
    return { rules: (await query('SELECT id, title, body FROM community_rules WHERE community_id = $1 ORDER BY position', [x.c.id])).rows };
  },

  async remove(slug: string, user: AuthUser, confirmName: string) {
    const x = await load('slug', slug, user);
    requireRank(x, 'owner');
    if (cleanText(confirmName) !== x.c.name) throw badRequest('CONFIRM_MISMATCH', 'Type the community name exactly to confirm');
    await tx(async (c) => {
      await c.query('UPDATE communities SET deleted_at = now() WHERE id = $1', [x.c.id]);
      await logAction(c, { communityId: x.c.id, actorId: user.id, action: 'COMMUNITY_DELETE' });
    });
    return { ok: true };
  },

  // ── Membership ──

  async join(slug: string, user: AuthUser, input: { message?: string; invite?: string }) {
    const x = await load('slug', slug, user);
    if (x.c.visibility === 'invite_only' && !x.role && !input.invite) throw notFound('Community');
    if (x.c.is_suspended) throw forbidden('COMMUNITY_SUSPENDED', 'This community is suspended');
    if (x.banned) throw forbidden('COMMUNITY_BANNED', 'You are banned from this community');
    if (x.role) return { status: 'member' as const };

    const result = await tx(async (c) => {
      if (input.invite) {
        if (!(await consumeInvite(c, x.c.id, input.invite))) {
          if (x.c.visibility === 'invite_only') throw notFound('Community');
          throw badRequest('BAD_INVITE', 'This invite link is invalid or has expired');
        }
        await addMember(c, x.c.id, user.id);
        await logAction(c, { communityId: x.c.id, actorId: user.id, action: 'JOIN_VIA_INVITE' });
        return 'member' as const;
      }
      if (x.c.visibility === 'public') {
        await addMember(c, x.c.id, user.id);
        return 'member' as const;
      }
      await c.query(
        `INSERT INTO community_join_requests (community_id, user_id, message) VALUES ($1, $2, $3)
         ON CONFLICT (community_id, user_id) DO UPDATE SET message = EXCLUDED.message`,
        [x.c.id, user.id, cleanText(input.message ?? '').slice(0, 300)],
      );
      return 'requested' as const;
    });
    if (result === 'requested') emit.community(x.c.id, 'community:requests', { communityId: x.c.id });
    return { status: result };
  },

  /** Leave, or cancel a pending join request. The owner must transfer ownership first. */
  async leave(slug: string, user: AuthUser) {
    const x = await load('slug', slug, user);
    if (x.role === 'owner') throw badRequest('OWNER_CANNOT_LEAVE', 'Transfer ownership before leaving your community');
    await tx(async (c) => {
      await dropMember(c, x.c.id, user.id);
      await c.query('DELETE FROM community_join_requests WHERE community_id = $1 AND user_id = $2', [x.c.id, user.id]);
    });
    return { status: 'none' as const };
  },

  async members(slug: string, viewer: AuthUser | undefined, q?: string) {
    const x = await load('slug', slug, viewer);
    if (!canSeePage(x)) throw notFound('Community');
    if (!canSeeContent(x)) throw forbidden('COMMUNITY_PRIVATE', 'Only members can see who is in this community');
    const params: unknown[] = [x.c.id];
    let filter = '';
    if (q) { params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`); filter = 'AND (u.username ILIKE $2 OR u.display_name ILIKE $2)'; }
    const { rows } = await query(
      `SELECT u.*, m.role AS community_role, m.joined_at, m.muted_until FROM community_members m JOIN users u ON u.id = m.user_id
        WHERE m.community_id = $1 AND u.is_banned = false ${filter}
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'mod' THEN 1 ELSE 2 END, m.joined_at LIMIT 200`,
      params,
    );
    const canMod = !!x.role && RANK[x.role] >= RANK.mod;
    return {
      members: rows.map((r) => ({
        ...publicUser(r),
        bio: r.profile_locked ? '' : r.bio,
        communityRole: r.community_role as CommunityRole,
        joinedAt: r.joined_at,
        // Mute state is moderation info: only for the community's own mods
        mutedUntil: canMod && r.muted_until && new Date(r.muted_until) > new Date() ? r.muted_until : null,
      })),
    };
  },

  async requests(slug: string, user: AuthUser) {
    const x = await load('slug', slug, user);
    requireRank(x, 'mod');
    const { rows } = await query(
      `SELECT u.*, r.message, r.created_at AS requested_at FROM community_join_requests r JOIN users u ON u.id = r.user_id
        WHERE r.community_id = $1 AND u.is_banned = false ORDER BY r.created_at LIMIT 200`,
      [x.c.id],
    );
    return { requests: rows.map((r) => ({ ...publicUser(r), message: r.message, requestedAt: r.requested_at })) };
  },

  async decideRequest(slug: string, user: AuthUser, targetId: string, approve: boolean) {
    const x = await load('slug', slug, user);
    requireRank(x, 'mod');
    await tx(async (c) => {
      const del = await c.query('DELETE FROM community_join_requests WHERE community_id = $1 AND user_id = $2', [x.c.id, targetId]);
      if (!del.rowCount) throw notFound('Join request');
      if (approve) {
        const banned = await c.query('SELECT 1 FROM community_bans WHERE community_id = $1 AND user_id = $2', [x.c.id, targetId]);
        if (banned.rowCount) throw badRequest('BANNED', 'This person is banned from the community');
        await addMember(c, x.c.id, targetId);
      }
      await logAction(c, { communityId: x.c.id, actorId: user.id, action: approve ? 'REQUEST_APPROVE' : 'REQUEST_DECLINE', targetUserId: targetId });
    });
    if (approve) await notificationService.create({ userId: targetId, type: 'moderation', message: `You're now a member of ${x.c.name}` }).catch(() => {});
    return { ok: true };
  },

  /** Owner only: promote to mod or demote to member. */
  async setRole(slug: string, user: AuthUser, targetId: string, role: 'mod' | 'member') {
    const x = await load('slug', slug, user);
    requireRank(x, 'owner');
    if (targetId === user.id) throw badRequest('SELF', "You can't change your own role");
    const current = await memberRole(x.c.id, targetId);
    if (!current) throw notFound('Member');
    if (current === 'owner') throw forbidden('COMMUNITY_FORBIDDEN', 'Use "transfer ownership" instead');
    await tx(async (c) => {
      await c.query('UPDATE community_members SET role = $3 WHERE community_id = $1 AND user_id = $2', [x.c.id, targetId, role]);
      await logAction(c, { communityId: x.c.id, actorId: user.id, action: role === 'mod' ? 'ROLE_MOD' : 'ROLE_MEMBER', targetUserId: targetId });
    });
    return { ok: true };
  },

  /** Remove (and optionally ban) a member. You can only act on someone below your own rank. */
  async removeMember(slug: string, user: AuthUser, targetId: string, input: { ban?: boolean; reason?: string }) {
    const x = await load('slug', slug, user);
    requireRank(x, 'mod');
    if (targetId === user.id) throw badRequest('SELF', "You can't remove yourself — leave the community instead");
    const target = await memberRole(x.c.id, targetId);
    if (target && RANK[target] >= RANK[x.role!]) throw forbidden('COMMUNITY_FORBIDDEN', "You can't remove someone with the same or a higher role");
    if (!target && !input.ban) throw notFound('Member');
    const reason = cleanText(input.reason ?? '').slice(0, 300);
    await tx(async (c) => {
      await dropMember(c, x.c.id, targetId);
      await c.query('DELETE FROM community_join_requests WHERE community_id = $1 AND user_id = $2', [x.c.id, targetId]);
      if (input.ban) {
        await c.query(
          `INSERT INTO community_bans (community_id, user_id, banned_by, reason) VALUES ($1, $2, $3, $4)
           ON CONFLICT (community_id, user_id) DO UPDATE SET reason = EXCLUDED.reason, banned_by = EXCLUDED.banned_by, created_at = now()`,
          [x.c.id, targetId, user.id, reason],
        );
      }
      await logAction(c, { communityId: x.c.id, actorId: user.id, action: input.ban ? 'MEMBER_BAN' : 'MEMBER_REMOVE', targetUserId: targetId, reason });
    });
    return { ok: true };
  },

  async bans(slug: string, user: AuthUser) {
    const x = await load('slug', slug, user);
    requireRank(x, 'mod');
    const { rows } = await query(
      `SELECT u.*, b.reason, b.created_at AS banned_at FROM community_bans b JOIN users u ON u.id = b.user_id
        WHERE b.community_id = $1 ORDER BY b.created_at DESC LIMIT 200`,
      [x.c.id],
    );
    return { bans: rows.map((r) => ({ ...publicUser(r), reason: r.reason, bannedAt: r.banned_at })) };
  },

  async unban(slug: string, user: AuthUser, targetId: string) {
    const x = await load('slug', slug, user);
    requireRank(x, 'mod');
    await tx(async (c) => {
      await c.query('DELETE FROM community_bans WHERE community_id = $1 AND user_id = $2', [x.c.id, targetId]);
      await logAction(c, { communityId: x.c.id, actorId: user.id, action: 'MEMBER_UNBAN', targetUserId: targetId });
    });
    return { ok: true };
  },

  /** Mute stops a member from posting/commenting for a while (0 hours = unmute). */
  async mute(slug: string, user: AuthUser, targetId: string, hours: number) {
    const x = await load('slug', slug, user);
    requireRank(x, 'mod');
    const target = await memberRole(x.c.id, targetId);
    if (!target) throw notFound('Member');
    if (RANK[target] >= RANK[x.role!]) throw forbidden('COMMUNITY_FORBIDDEN', "You can't mute someone with the same or a higher role");
    await tx(async (c) => {
      await c.query(
        `UPDATE community_members SET muted_until = CASE WHEN $3::int > 0 THEN now() + ($3::int || ' hours')::interval END
          WHERE community_id = $1 AND user_id = $2`,
        [x.c.id, targetId, hours],
      );
      await logAction(c, { communityId: x.c.id, actorId: user.id, action: hours > 0 ? 'MEMBER_MUTE' : 'MEMBER_UNMUTE', targetUserId: targetId, reason: hours > 0 ? `${hours}h` : null });
    });
    return { ok: true };
  },

  async transfer(slug: string, user: AuthUser, targetId: string) {
    const x = await load('slug', slug, user);
    requireRank(x, 'owner');
    if (targetId === user.id) throw badRequest('SELF', 'You already own this community');
    await tx(async (c) => {
      const target = await memberRole(x.c.id, targetId, c);
      if (!target) throw badRequest('NOT_A_MEMBER', 'The new owner must be a member of the community');
      // Order matters: exactly one owner is enforced by a unique index
      await c.query(`UPDATE community_members SET role = 'mod' WHERE community_id = $1 AND user_id = $2`, [x.c.id, user.id]);
      await c.query(`UPDATE community_members SET role = 'owner', muted_until = NULL WHERE community_id = $1 AND user_id = $2`, [x.c.id, targetId]);
      await c.query('UPDATE communities SET owner_id = $2, updated_at = now() WHERE id = $1', [x.c.id, targetId]);
      await logAction(c, { communityId: x.c.id, actorId: user.id, action: 'OWNERSHIP_TRANSFER', targetUserId: targetId });
    });
    await notificationService.create({ userId: targetId, type: 'moderation', message: `You are now the owner of ${x.c.name}` }).catch(() => {});
    return { ok: true };
  },

  // ── Invite links ──

  async createInvite(slug: string, user: AuthUser, input: { maxUses: number; expiresInDays: number }) {
    const x = await load('slug', slug, user);
    requireRank(x, 'mod');
    const active = await one<{ n: number }>(`SELECT count(*)::int AS n FROM community_invites WHERE community_id = $1 AND revoked_at IS NULL AND expires_at > now()`, [x.c.id]);
    if ((active?.n ?? 0) >= 20) throw forbidden('INVITE_LIMIT', 'Revoke an old invite link first (max 20 active)');
    const code = randomToken(15); // 20 url-safe chars, unguessable
    await tx(async (c) => {
      await c.query(
        `INSERT INTO community_invites (code, community_id, created_by, max_uses, expires_at) VALUES ($1, $2, $3, $4, now() + ($5::int || ' days')::interval)`,
        [code, x.c.id, user.id, input.maxUses, input.expiresInDays],
      );
      await logAction(c, { communityId: x.c.id, actorId: user.id, action: 'INVITE_CREATE' });
    });
    return { code };
  },

  async invites(slug: string, user: AuthUser) {
    const x = await load('slug', slug, user);
    requireRank(x, 'mod');
    const { rows } = await query(
      `SELECT i.code, i.max_uses, i.uses, i.expires_at, i.created_at, u.username AS created_by
         FROM community_invites i LEFT JOIN users u ON u.id = i.created_by
        WHERE i.community_id = $1 AND i.revoked_at IS NULL AND i.expires_at > now() ORDER BY i.created_at DESC`,
      [x.c.id],
    );
    return { invites: rows.map((r) => ({ code: r.code, maxUses: r.max_uses, uses: r.uses, expiresAt: r.expires_at, createdAt: r.created_at, createdBy: r.created_by })) };
  },

  async revokeInvite(slug: string, user: AuthUser, code: string) {
    const x = await load('slug', slug, user);
    requireRank(x, 'mod');
    await tx(async (c) => {
      const r = await c.query('UPDATE community_invites SET revoked_at = now() WHERE code = $1 AND community_id = $2 AND revoked_at IS NULL', [code, x.c.id]);
      if (!r.rowCount) throw notFound('Invite');
      await logAction(c, { communityId: x.c.id, actorId: user.id, action: 'INVITE_REVOKE' });
    });
    return { ok: true };
  },

  // ── Posts ──

  async feed(slug: string, viewer: AuthUser | undefined, cursor: string | undefined, limit: number) {
    const x = await load('slug', slug, viewer);
    if (!canSeePage(x)) throw notFound('Community');
    if (!canSeeContent(x)) return { posts: [], pinned: [], cursor: null, hasMore: false, locked: true };

    const params: unknown[] = [x.c.id];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const base = `p.community_id = $1 AND p.is_removed = false AND p.deleted_at IS NULL AND NOT p.is_pending AND (u.id IS NULL OR u.is_banned = false)`;
    const likedSql = viewer ? `EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = ${add(viewer.id)})` : 'false';

    // Pinned posts on the first page only
    const pinned = cursor
      ? []
      : (await query(`SELECT ${POST_COLUMNS}, ${likedSql} AS liked FROM posts p LEFT JOIN users u ON u.id = p.author_id WHERE ${base} AND p.pinned_at IS NOT NULL ORDER BY p.pinned_at DESC`, params)).rows;

    const where = [base, 'p.pinned_at IS NULL'];
    const c = decodeCursor(cursor);
    if (c) where.push(`(p.created_at, p.id) < (${add(c.ts)}, ${add(c.id)})`);
    const { rows } = await query(
      `SELECT ${POST_COLUMNS}, ${likedSql} AS liked FROM posts p LEFT JOIN users u ON u.id = p.author_id
        WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC, p.id DESC LIMIT ${add(limit + 1)}`,
      params,
    );
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return {
      pinned: await hydratePosts(pinned, viewer),
      posts: await hydratePosts(rows, viewer),
      cursor: hasMore ? encodeCursor(rows.at(-1)!.created_at, rows.at(-1)!.id) : null,
      hasMore,
      locked: false,
    };
  },

  async pending(slug: string, user: AuthUser) {
    const x = await load('slug', slug, user);
    requireRank(x, 'mod');
    const { rows } = await query(
      `SELECT ${POST_COLUMNS} FROM posts p LEFT JOIN users u ON u.id = p.author_id
        WHERE p.community_id = $1 AND p.is_pending AND p.is_removed = false AND p.deleted_at IS NULL
        ORDER BY p.created_at LIMIT 100`,
      [x.c.id],
    );
    return { posts: await hydratePosts(rows, user) };
  },

  async decidePost(slug: string, user: AuthUser, postId: string, approve: boolean, reason?: string) {
    const x = await load('slug', slug, user);
    requireRank(x, 'mod');
    const p = await one('SELECT id, visibility, author_id FROM posts WHERE id = $1 AND community_id = $2 AND is_pending AND deleted_at IS NULL AND is_removed = false', [postId, x.c.id]);
    if (!p) throw notFound('Pending post');
    const why = cleanText(reason ?? '').slice(0, 300);
    await tx(async (c) => {
      if (approve) {
        await c.query('UPDATE posts SET is_pending = false, created_at = now() WHERE id = $1', [postId]);
        await c.query('UPDATE communities SET post_count = post_count + 1 WHERE id = $1', [x.c.id]);
      } else {
        await c.query(`UPDATE posts SET is_removed = true, removed_reason = $2 WHERE id = $1`, [postId, `Not approved by community moderators${why ? `: ${why}` : ''}`]);
      }
      await logAction(c, { communityId: x.c.id, actorId: user.id, action: approve ? 'POST_APPROVE' : 'POST_REJECT', targetPostId: postId, reason: why || null });
    });
    if (approve) {
      const full = await one(`SELECT ${POST_COLUMNS} FROM posts p LEFT JOIN users u ON u.id = p.author_id WHERE p.id = $1`, [postId]);
      emit.community(x.c.id, 'post:new', (await hydratePosts([full]))[0]);
    }
    if (p.visibility === 'identity' && p.author_id) {
      await notificationService.create({
        userId: p.author_id, type: 'moderation', postId: approve ? postId : undefined,
        message: approve ? `Your post in ${x.c.name} was approved` : `Your post in ${x.c.name} wasn't approved${why ? `: ${why}` : ''}`,
      }).catch(() => {});
    }
    return { ok: true };
  },

  /** Community mods hide a post from the community. They can't see or reveal who wrote an anonymous post. */
  async removePost(slug: string, user: AuthUser, postId: string, reason: string) {
    const x = await load('slug', slug, user);
    requireRank(x, 'mod');
    const p = await one('SELECT id, visibility, author_id, is_removed FROM posts WHERE id = $1 AND community_id = $2 AND deleted_at IS NULL', [postId, x.c.id]);
    if (!p) throw notFound('Post');
    if (p.is_removed) return { ok: true };
    if (p.visibility === 'identity' && p.author_id && p.author_id !== user.id) {
      const authorRole = await memberRole(x.c.id, p.author_id);
      if (authorRole && RANK[authorRole] >= RANK[x.role!]) throw forbidden('COMMUNITY_FORBIDDEN', "You can't remove a post by someone with the same or a higher role");
    }
    const why = cleanText(reason).slice(0, 300);
    await tx(async (c) => {
      await c.query(`UPDATE posts SET is_removed = true, pinned_at = NULL, removed_reason = $2 WHERE id = $1`, [postId, `Removed by community moderators: ${why}`]);
      await logAction(c, { communityId: x.c.id, actorId: user.id, action: 'POST_REMOVE', targetPostId: postId, reason: why, targetUserId: p.visibility === 'identity' ? p.author_id : null });
    });
    emit.community(x.c.id, 'post:removed', { id: postId });
    if (p.visibility === 'identity' && p.author_id && p.author_id !== user.id) {
      await notificationService.create({ userId: p.author_id, type: 'moderation', postId, message: `Your post in ${x.c.name} was removed: ${why}` }).catch(() => {});
    }
    return { ok: true };
  },

  async pin(slug: string, user: AuthUser, postId: string, pinned: boolean) {
    const x = await load('slug', slug, user);
    requireRank(x, 'mod');
    if (pinned) {
      const n = await one<{ n: number }>('SELECT count(*)::int AS n FROM posts WHERE community_id = $1 AND pinned_at IS NOT NULL AND is_removed = false', [x.c.id]);
      if ((n?.n ?? 0) >= MAX_PINNED) throw badRequest('PIN_LIMIT', `You can pin up to ${MAX_PINNED} posts`);
    }
    await tx(async (c) => {
      const r = await c.query(
        `UPDATE posts SET pinned_at = ${pinned ? 'now()' : 'NULL'} WHERE id = $1 AND community_id = $2 AND is_removed = false AND NOT is_pending AND deleted_at IS NULL`,
        [postId, x.c.id],
      );
      if (!r.rowCount) throw notFound('Post');
      await logAction(c, { communityId: x.c.id, actorId: user.id, action: pinned ? 'POST_PIN' : 'POST_UNPIN', targetPostId: postId });
    });
    return { ok: true };
  },

  /** Recent owner/mod actions, for the community's own mods. */
  async modLog(slug: string, user: AuthUser) {
    const x = await load('slug', slug, user);
    requireRank(x, 'mod');
    return { entries: await modLogRows(x.c.id, 100) };
  },
};

export async function modLogRows(communityId: string, limit: number) {
  const { rows } = await query(
    `SELECT l.id, l.action, l.reason, l.created_at, l.target_post_id, a.username AS actor, t.username AS target
       FROM community_mod_log l
       LEFT JOIN users a ON a.id = l.actor_id
       LEFT JOIN users t ON t.id = l.target_user_id
      WHERE l.community_id = $1 ORDER BY l.created_at DESC LIMIT $2`,
    [communityId, limit],
  );
  return rows.map((r) => ({ id: Number(r.id), action: r.action, reason: r.reason, createdAt: r.created_at, actor: r.actor, target: r.target, targetPostId: r.target_post_id }));
}
