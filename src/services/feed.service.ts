import { query } from '../config/db.js';
import { decodeCursor, encodeCursor, publicPost, type PublicPost } from '../lib/serialize.js';
import type { AuthUser, FeedMode } from '../types/index.js';
import { identityService } from './identity.service.js';
import { isStaff } from '../middleware/rbac.middleware.js';
import { rankedFeed } from './feed-ranking.service.js';

export interface FeedOptions {
  mode?: FeedMode;
  /** top = ranked "for you" feed (default for the main feed); recent = newest first */
  sort?: 'top' | 'recent';
  cursor?: string;
  limit?: number;
  q?: string;
  authorId?: string; // profile timeline (identity only)
  media?: 'video'; // Reels page
  viewer?: AuthUser;
}

export const POST_COLUMNS = `
  p.*, u.username AS author_username, u.display_name AS author_display_name,
  u.avatar_url AS author_avatar_url, u.is_verified AS author_is_verified, u.role AS author_role`;

export interface PostCommunity { id: string; slug: string; name: string; iconUrl: string | null }

/** Paid / subscriber-only state. `locked` = the viewer hasn't paid: content is a short preview and media is withheld. */
export interface PostAccess { access: 'public' | 'subscribers' | 'paid'; priceMinor: number | null; currency: string | null; locked: boolean; lockedMediaCount: number }

export type HydratedPost = PublicPost & PostAccess & {
  savedByMe: boolean;
  canShare: boolean;
  sharedPost: PublicPost | null;
  community: PostCommunity | null;
  isPinned: boolean;
  isPending: boolean;
};

/** Sharing rule. A share re-shares its original, so the original's policy applies. */
function shareAllowed(row: any, viewer: AuthUser | undefined, owner: boolean, friendIds: Set<string>) {
  if (row.is_removed) return false;
  if (!viewer) return row.share_policy === 'everyone'; // public/broadcast shape; enforced again on share
  // Authors can always share their own identity posts. Not anonymous ones: an owner-only bypass
  // would let others infer who wrote a "no sharing" anonymous post.
  if (owner && row.visibility === 'identity') return true;
  if (row.share_policy === 'none') return false;
  if (row.share_policy === 'friends') return row.visibility === 'identity' && !!row.author_id && friendIds.has(row.author_id);
  return true;
}

/**
 * Adds viewer-specific state (liked, saved, owner, canShare) and embeds the original of shared posts.
 * All lookups are batched; anonymous authors are never revealed (ownership uses the HMAC check).
 */
export async function hydratePosts(rows: any[], viewer?: AuthUser): Promise<HydratedPost[]> {
  if (rows.length === 0) return [];
  const sharedIds = [...new Set(rows.filter((r) => r.shared_post_id).map((r) => r.shared_post_id as string))];
  const { rows: originals } = sharedIds.length
    ? await query(
        `SELECT ${POST_COLUMNS} FROM posts p LEFT JOIN users u ON u.id = p.author_id
          WHERE p.id = ANY($1::uuid[]) AND p.is_removed = false AND p.deleted_at IS NULL AND (u.id IS NULL OR u.is_banned = false)`,
        [sharedIds],
      )
    : { rows: [] as any[] };
  const originalById = new Map(originals.map((o) => [o.id as string, o]));

  // Community name/link for community posts (one batched lookup)
  const communityIds = [...new Set(rows.filter((r) => r.community_id).map((r) => r.community_id as string))];
  const { rows: comms } = communityIds.length
    ? await query('SELECT id, slug, name, icon_url, visibility FROM communities WHERE id = ANY($1::uuid[])', [communityIds])
    : { rows: [] as any[] };
  const communityById = new Map<string, PostCommunity>(comms.map((c) => [c.id, { id: c.id, slug: c.slug, name: c.name, iconUrl: c.icon_url ?? null }]));
  const nonPublic = new Set(comms.filter((c) => c.visibility !== 'public').map((c) => c.id as string));

  // Paid / subscriber-only posts: who is entitled (author, staff who can view posts, buyers, active members)
  const all0 = [...rows, ...originals];
  const gated = all0.filter((r) => r.access && r.access !== 'public');
  let unlocked = new Set<string>();
  let memberOf = new Set<string>();
  if (viewer && gated.length) {
    const [u, m] = await Promise.all([
      query<{ post_id: string }>('SELECT post_id FROM post_unlocks WHERE user_id = $1 AND post_id = ANY($2::uuid[])', [viewer.id, gated.filter((r) => r.access === 'paid').map((r) => r.id)]),
      query<{ creator_id: string }>(
        `SELECT creator_id FROM memberships WHERE member_id = $1 AND status IN ('active','canceled') AND current_period_end > now() AND creator_id = ANY($2::uuid[])`,
        [viewer.id, [...new Set(gated.map((r) => r.author_id).filter(Boolean))]],
      ),
    ]);
    unlocked = new Set(u.rows.map((r) => r.post_id));
    memberOf = new Set(m.rows.map((r) => r.creator_id));
  }
  const staffCanView = !!viewer && isStaff(viewer.role) && viewer.permissions.includes('posts.view');
  const entitled = (r: any) => {
    if (!r.access || r.access === 'public') return true;
    if (!viewer) return false;
    if (r.author_id === viewer.id || staffCanView) return true;
    if (r.access === 'paid') return unlocked.has(r.id) || memberOf.has(r.author_id);
    return memberOf.has(r.author_id);
  };
  /** Apply the lock to a serialized post. */
  const gate = <T extends PublicPost>(post: T, r: any): T & PostAccess => {
    const access = (r.access ?? 'public') as PostAccess['access'];
    const base = { access, priceMinor: r.price_minor != null ? Number(r.price_minor) : null, currency: r.currency ?? null, locked: false, lockedMediaCount: 0 };
    if (entitled(r)) return { ...post, ...base };
    const text = post.content ?? '';
    return { ...post, ...base, content: text.length > 100 ? `${text.slice(0, 100).trimEnd()}…` : text, media: [], locked: true, lockedMediaCount: post.media.length };
  };

  // Tagged friends (identity posts only — anonymous posts can never carry tags)
  const tagged = all0.filter((r) => r.visibility === 'identity').map((r) => r.id as string);
  const tagsByPost = new Map<string, PublicPost['tags']>();
  if (tagged.length) {
    const { rows: t } = await query<{ post_id: string; id: string; username: string; display_name: string }>(
      `SELECT t.post_id, u.id, u.username, u.display_name FROM post_tags t JOIN users u ON u.id = t.user_id
        WHERE t.post_id = ANY($1::uuid[]) AND u.is_banned = false ORDER BY t.created_at, u.display_name`,
      [tagged],
    );
    for (const r of t) {
      const list = tagsByPost.get(r.post_id) ?? [];
      list.push({ id: r.id, username: r.username, displayName: r.display_name });
      tagsByPost.set(r.post_id, list);
    }
  }
  const withTags = <T extends PublicPost>(p: T): T => ({ ...p, tags: tagsByPost.get(p.id) ?? [] });

  let saved = new Set<string>();
  let liked = new Set<string>();
  let friends = new Set<string>();
  let owned = new Set<string>();
  if (viewer) {
    const ids = rows.map((r) => r.id);
    const all = [...rows, ...originals];
    const [s, l, f, o] = await Promise.all([
      query<{ post_id: string }>('SELECT post_id FROM saved_posts WHERE user_id = $1 AND post_id = ANY($2::uuid[])', [viewer.id, ids]),
      rows.some((r) => r.liked === undefined)
        ? query<{ post_id: string }>('SELECT post_id FROM post_likes WHERE user_id = $1 AND post_id = ANY($2::uuid[])', [viewer.id, ids])
        : Promise.resolve({ rows: [] as { post_id: string }[] }),
      query<{ friend_id: string }>(
        'SELECT friend_id FROM friend_edges WHERE user_id = $1 AND friend_id = ANY($2::uuid[])',
        [viewer.id, [...new Set(all.filter((r) => r.author_id).map((r) => r.author_id))]],
      ),
      identityService.ownedBy(all.filter((r) => r.visibility === 'anonymous').map((r) => r.id), viewer.id),
    ]);
    saved = new Set(s.rows.map((r) => r.post_id));
    liked = new Set(l.rows.map((r) => r.post_id));
    friends = new Set(f.rows.map((r) => r.friend_id));
    owned = o;
  }
  const isOwner = (r: any) => !!viewer && (r.visibility === 'identity' ? r.author_id === viewer.id : owned.has(r.id));

  return rows.map((r) => {
    const original = r.shared_post_id ? originalById.get(r.shared_post_id) : undefined;
    const target = r.is_share ? original : r;
    const owner = isOwner(r);
    return {
      ...gate(withTags(publicPost(r, { owner, liked: r.liked ?? liked.has(r.id) })), r),
      savedByMe: saved.has(r.id),
      // Pending posts and posts in private / invite-only communities can't be shared
      canShare: target && !r.is_pending && (target.access ?? 'public') === 'public' && !(r.community_id && nonPublic.has(r.community_id))
        ? shareAllowed(target, viewer, isOwner(target), friends) : false,
      sharedPost: original ? gate(withTags(publicPost(original, { owner: isOwner(original) })), original) : null,
      community: r.community_id ? (communityById.get(r.community_id) ?? null) : null,
      isPinned: !!r.pinned_at,
      isPending: !!r.is_pending,
    };
  });
}

/**
 * Filters shared by every feed query (newest-first and ranked). `add` pushes a bind parameter.
 * Hidden posts and snoozed people are left out of the main feeds (not of profiles or search).
 * Returns null when the viewer can't have this feed at all (Communities feed while signed out).
 */
export function feedWhere({ mode = 'all', q, authorId, viewer, media }: FeedOptions, add: (v: unknown) => string): string[] | null {
  const where = ['p.is_removed = false', 'p.deleted_at IS NULL', 'NOT p.is_pending', '(u.id IS NULL OR u.is_banned = false)'];

  if (mode === 'communities' && !authorId) {
    // Posts from communities you belong to (never anything you couldn't open yourself)
    if (!viewer) return null;
    where.push(`p.community_id IN (SELECT m.community_id FROM community_members m JOIN communities cm ON cm.id = m.community_id
                 WHERE m.user_id = ${add(viewer.id)} AND cm.deleted_at IS NULL AND NOT cm.is_suspended)`);
  } else {
    // Main feed, search and profiles never include community posts — those live in their community
    where.push('p.community_id IS NULL');
  }

  if (authorId) {
    // Profile timeline: identity posts by this author ONLY. Anonymous posts can never match (author_id IS NULL).
    where.push(`p.visibility = 'identity'`, `p.author_id = ${add(authorId)}`);
  } else if (mode === 'identity' || mode === 'anonymous') {
    where.push(`p.visibility = ${add(mode)}`);
  }
  if (q) where.push(`p.content ILIKE ${add(`%${q.replace(/[%_\\]/g, '\\$&')}%`)}`);
  if (q) where.push(`p.access = 'public'`); // search must not reveal what's inside paid posts
  if (media === 'video') where.push(`p.access = 'public'`);
  if (media === 'video') where.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(p.media) m WHERE m->>'type' = 'video')`);
  if (viewer && !authorId && !q) {
    const v = add(viewer.id);
    where.push(`NOT EXISTS (SELECT 1 FROM post_hides h WHERE h.user_id = ${v} AND h.post_id = p.id)`);
    where.push(`(p.author_id IS NULL OR NOT EXISTS (SELECT 1 FROM author_snoozes z WHERE z.user_id = ${v} AND z.author_id = p.author_id AND z.until > now()))`);
  }
  return where;
}

/**
 * Feed entry point. The main feed, Reels and the Communities feed are RANKED (see feed-ranking.service.ts) unless
 * sort=recent; profiles and search are newest first. Anonymous rows have author_id NULL in the DB.
 */
export async function getFeed(opts: FeedOptions) {
  const ranked = !opts.authorId && !opts.q && opts.sort !== 'recent';
  if (ranked && (!opts.cursor || opts.cursor.startsWith('r.'))) return rankedFeed(opts);
  return recentFeed(opts);
}

/** Keyset-paginated, newest first. */
export async function recentFeed(opts: FeedOptions) {
  const { cursor, limit = 20, viewer } = opts;
  const params: unknown[] = [];
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where = feedWhere(opts, add);
  if (!where) return { posts: [], cursor: null, hasMore: false };

  const c = decodeCursor(cursor);
  if (c) where.push(`(p.created_at, p.id) < (${add(c.ts)}, ${add(c.id)})`);

  const likedSql = viewer
    ? `EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = ${add(viewer.id)})`
    : 'false';

  const { rows } = await query(
    `SELECT ${POST_COLUMNS}, ${likedSql} AS liked
       FROM posts p
       LEFT JOIN users u ON u.id = p.author_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ${add(limit + 1)}`,
    params,
  );

  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  return {
    posts: await hydratePosts(rows, viewer),
    cursor: hasMore ? encodeCursor(rows.at(-1)!.created_at, rows.at(-1)!.id) : null,
    hasMore,
  };
}

/**
 * YOUR OWN anonymous posts (only ever for the signed-in author themself).
 * There is deliberately no user→post index: we walk anonymous posts newest-first and keep the ones whose
 * HMAC(postId:userId) matches the viewer. Nothing new is stored, so nobody else (admins included) gains a way
 * to list someone's anonymous posts. Each call scans a bounded window; `cursor` continues where it stopped.
 */
export async function getMyAnonymous(viewer: AuthUser, cursor?: string, limit = 20) {
  const BATCH = 300;
  const MAX_SCAN = 3000; // bound the work per request; the client just asks again
  const found: any[] = [];
  let c = decodeCursor(cursor);
  let scanned = 0;
  let exhausted = false;
  while (found.length < limit && scanned < MAX_SCAN) {
    const params: unknown[] = [BATCH];
    let cur = '';
    if (c) { params.push(c.ts, c.id); cur = 'AND (p.created_at, p.id) < ($2, $3)'; }
    const { rows } = await query(
      `SELECT ${POST_COLUMNS} FROM posts p LEFT JOIN users u ON u.id = p.author_id
        WHERE p.visibility = 'anonymous' AND p.deleted_at IS NULL ${cur}
        ORDER BY p.created_at DESC, p.id DESC LIMIT $1`,
      params,
    );
    if (rows.length === 0) { exhausted = true; break; }
    scanned += rows.length;
    const mine = await identityService.ownedBy(rows.map((r) => r.id), viewer.id);
    for (const r of rows) {
      c = { ts: r.created_at, id: r.id };
      if (mine.has(r.id)) {
        found.push(r);
        if (found.length === limit) break;
      }
    }
    if (rows.length < BATCH && found.length < limit) { exhausted = true; break; }
  }
  const posts = (await hydratePosts(found, viewer)).map((p, i) => ({ ...p, isRemoved: !!found[i].is_removed }));
  return { posts, cursor: exhausted || !c ? null : encodeCursor(c.ts, c.id), hasMore: !exhausted };
}

/** Your saved posts, most recently saved first. Only posts that are still available are returned. */
export async function getSaved(viewer: AuthUser, cursor?: string, limit = 20) {
  const params: unknown[] = [viewer.id, limit + 1];
  let cursorSql = '';
  const c = decodeCursor(cursor);
  if (c) {
    params.push(c.ts, c.id);
    cursorSql = 'AND (s.created_at, p.id) < ($3, $4)';
  }
  const { rows } = await query(
    `SELECT ${POST_COLUMNS}, s.created_at AS saved_at,
            EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked
       FROM saved_posts s
       JOIN posts p ON p.id = s.post_id
       LEFT JOIN users u ON u.id = p.author_id
      WHERE s.user_id = $1 AND p.is_removed = false AND p.deleted_at IS NULL AND (u.id IS NULL OR u.is_banned = false) ${cursorSql}
        AND NOT p.is_pending
        -- A saved community post stays visible only while you can still open it (public, or you're a member)
        AND (p.community_id IS NULL OR EXISTS (
              SELECT 1 FROM communities cm WHERE cm.id = p.community_id AND cm.deleted_at IS NULL AND NOT cm.is_suspended
                AND (cm.visibility = 'public' OR EXISTS (SELECT 1 FROM community_members m WHERE m.community_id = cm.id AND m.user_id = $1))))
      ORDER BY s.created_at DESC, p.id DESC
      LIMIT $2`,
    params,
  );
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  return {
    posts: await hydratePosts(rows, viewer),
    cursor: hasMore ? encodeCursor(rows.at(-1)!.saved_at, rows.at(-1)!.id) : null,
    hasMore,
  };
}
