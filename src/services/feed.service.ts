import { query } from '../config/db.js';
import { decodeCursor, encodeCursor, publicPost, type PublicPost } from '../lib/serialize.js';
import type { AuthUser, FeedMode } from '../types/index.js';
import { identityService } from './identity.service.js';

interface FeedOptions {
  mode?: FeedMode;
  cursor?: string;
  limit?: number;
  q?: string;
  authorId?: string; // profile timeline (identity only)
  viewer?: AuthUser;
}

export const POST_COLUMNS = `
  p.*, u.username AS author_username, u.display_name AS author_display_name,
  u.avatar_url AS author_avatar_url, u.is_verified AS author_is_verified, u.role AS author_role`;

export type HydratedPost = PublicPost & {
  savedByMe: boolean;
  canShare: boolean;
  sharedPost: PublicPost | null;
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
      ...publicPost(r, { owner, liked: r.liked ?? liked.has(r.id) }),
      savedByMe: saved.has(r.id),
      canShare: target ? shareAllowed(target, viewer, isOwner(target), friends) : false,
      sharedPost: original ? publicPost(original, { owner: isOwner(original) }) : null,
    };
  });
}

/** Keyset-paginated feed. Anonymous rows have author_id NULL in the DB; the serializer double-enforces it. */
export async function getFeed({ mode = 'all', cursor, limit = 20, q, authorId, viewer }: FeedOptions) {
  const where = ['p.is_removed = false', 'p.deleted_at IS NULL', '(u.id IS NULL OR u.is_banned = false)'];
  const params: unknown[] = [];
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };

  if (authorId) {
    // Profile timeline: identity posts by this author ONLY. Anonymous posts can never match (author_id IS NULL).
    where.push(`p.visibility = 'identity'`, `p.author_id = ${add(authorId)}`);
  } else if (mode !== 'all') {
    where.push(`p.visibility = ${add(mode)}`);
  }
  if (q) where.push(`p.content ILIKE ${add(`%${q.replace(/[%_\\]/g, '\\$&')}%`)}`);

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
