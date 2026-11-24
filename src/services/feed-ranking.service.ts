// ═══════════════════════════════════════════════════════════════
// Ranked "for you" feed — the same idea as Facebook's News Feed ranking.
//  1. Candidates: recent posts the viewer is allowed to see (same filters as the newest-first feed).
//  2. Signals per post: who wrote it (you / friend / someone you follow), how much you interact with that person,
//     how much people engage with it (likes, comments, shares, and likes in the last 24 h), what it is (video, photo),
//     how old it is, and whether you've already seen it.
//  3. Score = affinity × engagement × type × time-decay × seen-penalty (+ a little randomness per visit).
//  4. Diversity: never the same person twice in a row, at most two posts per person near the top.
//  5. The ranked list is saved as a short-lived session so scrolling pages through it without repeats; after the
//     ranked window, older posts continue newest-first.
// Anonymous posts carry no author in the DB, so no personal signal can ever be computed for them (no leak).
// ═══════════════════════════════════════════════════════════════
import { query } from '../config/db.js';
import { encodeCursor } from '../lib/serialize.js';
import { emit } from '../lib/realtime.js';
import { identityService } from './identity.service.js';
import { type FeedOptions, feedWhere, hydratePosts, POST_COLUMNS } from './feed.service.js';

const WINDOW_DAYS = 21;          // look this far back for candidates…
const WIDE_WINDOW_DAYS = 365;    // …or further when the network is quiet
const MAX_CANDIDATES = 500;
const SESSION_HOURS = 6;

interface Candidate {
  id: string; author_id: string | null; created_at: Date; likes_count: number; comments_count: number; shares_count: number;
  media: { type: string }[]; is_share: boolean; own: boolean; friend: boolean; following: boolean;
  views: number | null; last_seen_at: Date | null; likes_24h: number;
}

/** Score one candidate. Exported for tests. */
export function scorePost(c: Candidate, affinity: number, now = Date.now()) {
  const ageH = Math.max(0, (now - new Date(c.created_at).getTime()) / 3_600_000);
  // Relationship: you > friends > people you follow > everyone else; boosted by how often you interact with them
  let rel = 1;
  if (c.own) rel = 1.6;
  else {
    if (c.friend) rel += 2;
    if (c.following) rel += 1.2;
    rel += Math.min(2.5, affinity * 0.3);
  }
  // Engagement: comments and shares say more than likes; fresh likes show momentum
  const engagement = 1 + Math.log1p(c.likes_count + 3 * c.comments_count + 5 * c.shares_count) + 0.6 * Math.log1p(c.likes_24h);
  const hasVideo = c.media?.some((m) => m.type === 'video');
  const type = hasVideo ? 1.2 : c.media?.length ? 1.1 : c.is_share ? 0.95 : 1;
  // Time decay (gravity): a post loses about half its weight in its first few hours, then keeps sinking
  const decay = 1 / Math.pow(ageH + 2, 1.3);
  let score = rel * engagement * type * decay;
  // Already seen: push it down hard (very hard if seen in the last 2 hours) so the top of the feed keeps changing
  if (c.views) {
    const seenAgoH = c.last_seen_at ? (now - new Date(c.last_seen_at).getTime()) / 3_600_000 : 99;
    score *= (seenAgoH < 2 ? 0.03 : 0.2) / (1 + Math.log(c.views));
  }
  // Your own brand-new post shows at the top for you (like Facebook) until you've seen it a couple of times
  if (c.own && ageH < 0.5 && (c.views ?? 0) < 2) score += 1000;
  return score;
}

/** Re-order so one person never fills the top: no two in a row, max two per person in the first 30. */
export function diversify<T extends { id: string; author_id: string | null }>(sorted: T[]) {
  const pool = [...sorted];
  const out: T[] = [];
  const perAuthor = new Map<string, number>();
  const key = (x: T) => x.author_id ?? `anon:${x.id}`;
  while (pool.length) {
    const last = out.length ? key(out[out.length - 1]!) : null;
    let i = pool.findIndex((x) => key(x) !== last && (out.length >= 30 || (perAuthor.get(key(x)) ?? 0) < 2));
    if (i < 0) i = 0;
    const [x] = pool.splice(i, 1);
    out.push(x!);
    perAuthor.set(key(x!), (perAuthor.get(key(x!)) ?? 0) + 1);
  }
  return out;
}

async function buildSession(opts: FeedOptions) {
  const viewer = opts.viewer;
  const load = async (days: number) => {
    const params: unknown[] = [];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where = feedWhere(opts, add);
    if (!where) return null;
    where.push(`p.created_at > now() - ${add(`${days} days`)}::interval`);
    const v = viewer ? add(viewer.id) : null;
    const { rows } = await query<Candidate>(
      `SELECT p.id, p.author_id, p.created_at, p.likes_count, p.comments_count, p.shares_count, p.media, p.is_share,
              ${v ? `p.author_id = ${v}` : 'false'} AS own,
              ${v ? `EXISTS (SELECT 1 FROM friend_edges f WHERE f.user_id = ${v} AND f.friend_id = p.author_id)` : 'false'} AS friend,
              ${v ? `EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = ${v} AND fo.followee_id = p.author_id)` : 'false'} AS following,
              ${v ? 'pv.views' : 'NULL::int'} AS views, ${v ? 'pv.last_seen_at' : 'NULL::timestamptz'} AS last_seen_at,
              (SELECT count(*) FROM post_likes l WHERE l.post_id = p.id AND l.created_at > now() - interval '24 hours')::int AS likes_24h
         FROM posts p
         LEFT JOIN users u ON u.id = p.author_id
         ${v ? `LEFT JOIN post_views pv ON pv.post_id = p.id AND pv.user_id = ${v}` : ''}
        WHERE ${where.join(' AND ')}
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ${add(MAX_CANDIDATES)}`,
      params,
    );
    return rows;
  };
  let rows = await load(WINDOW_DAYS);
  if (rows === null) return null;
  if (rows.length < 60) rows = (await load(WIDE_WINDOW_DAYS)) ?? [];

  // How much the viewer interacts with each author (last 60 days): likes count 1, comments count 2
  const affinity = new Map<string, number>();
  const authors = [...new Set(rows.map((r) => r.author_id).filter((a): a is string => !!a && a !== viewer?.id))];
  if (viewer && authors.length) {
    const { rows: aff } = await query<{ author_id: string; n: number }>(
      `SELECT author_id, sum(n)::int AS n FROM (
         SELECT p.author_id, count(*) AS n FROM post_likes l JOIN posts p ON p.id = l.post_id
          WHERE l.user_id = $1 AND l.created_at > now() - interval '60 days' AND p.author_id = ANY($2::uuid[]) GROUP BY 1
         UNION ALL
         SELECT p.author_id, 2 * count(*) AS n FROM comments c JOIN posts p ON p.id = c.post_id
          WHERE c.author_id = $1 AND c.created_at > now() - interval '60 days' AND p.author_id = ANY($2::uuid[]) GROUP BY 1
       ) x GROUP BY author_id`,
      [viewer.id, authors],
    );
    for (const a of aff) affinity.set(a.author_id, a.n);
  }

  const now = Date.now();
  const scored = rows.map((r) => ({ ...r, score: scorePost(r, r.author_id ? (affinity.get(r.author_id) ?? 0) : 0, now) * (0.9 + Math.random() * 0.2) }));
  scored.sort((a, b) => b.score - a.score);
  const ordered = diversify(scored);
  const oldest = rows.at(-1);
  const { rows: s } = await query<{ id: string }>(
    'INSERT INTO feed_sessions (user_id, post_ids, floor_ts, floor_id) VALUES ($1, $2, $3, $4) RETURNING id',
    [viewer?.id ?? null, ordered.map((x) => x.id), oldest?.created_at ?? null, oldest?.id ?? null],
  );
  return { id: s[0]!.id, postIds: ordered.map((x) => x.id), floorTs: oldest?.created_at ?? null, floorId: oldest?.id ?? null };
}

/** Ranked feed page. Cursor "r.<session>.<offset>" pages the saved ranking; then a normal cursor continues older posts. */
export async function rankedFeed(opts: FeedOptions) {
  const limit = opts.limit ?? 20;
  const viewer = opts.viewer;
  let session: { id: string; postIds: string[]; floorTs: Date | null; floorId: string | null } | null = null;
  let offset = 0;
  const m = /^r\.([0-9a-f-]{36})\.(\d{1,4})$/i.exec(opts.cursor ?? '');
  if (m) {
    const { rows } = await query(
      `SELECT id, post_ids, floor_ts, floor_id FROM feed_sessions
        WHERE id = $1 AND user_id IS NOT DISTINCT FROM $2 AND created_at > now() - make_interval(hours => $3)`,
      [m[1], viewer?.id ?? null, SESSION_HOURS],
    );
    if (rows[0]) {
      session = { id: rows[0].id, postIds: rows[0].post_ids, floorTs: rows[0].floor_ts, floorId: rows[0].floor_id };
      offset = Number(m[2]);
    }
  }
  if (!session) session = await buildSession(opts);
  if (!session) return { posts: [], cursor: null, hasMore: false };

  const ids = session.postIds.slice(offset, offset + limit);
  let rows: any[] = [];
  if (ids.length) {
    // Re-check every filter at read time (a post may have been removed or hidden since the ranking was made)
    const params: unknown[] = [];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where = feedWhere(opts, add) ?? ['false'];
    where.push(`p.id = ANY(${add(ids)}::uuid[])`);
    const liked = viewer ? `EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = ${add(viewer.id)})` : 'false';
    const res = await query(`SELECT ${POST_COLUMNS}, ${liked} AS liked FROM posts p LEFT JOIN users u ON u.id = p.author_id WHERE ${where.join(' AND ')}`, params);
    const byId = new Map(res.rows.map((r) => [r.id as string, r]));
    rows = ids.map((id) => byId.get(id)).filter(Boolean);
  }
  const next = offset + limit;
  let cursor: string | null = null;
  if (next < session.postIds.length) cursor = `r.${session.id}.${next}`;
  else if (session.floorTs && session.floorId) cursor = encodeCursor(session.floorTs, session.floorId); // older posts, newest first
  return { posts: await hydratePosts(rows, viewer), cursor, hasMore: !!cursor };
}

/**
 * The viewer saw these posts (counted again for ranking only after 30 minutes).
 * A person's FIRST view of a post also bumps its public views_count — never the author's own view
 * (anonymous authors are recognised with the HMAC check, nothing is stored about it).
 */
export async function markSeen(userId: string, postIds: string[]) {
  const ids = [...new Set(postIds)].slice(0, 50);
  if (!ids.length) return;
  const ownAnon = [...(await identityService.ownedBy(ids, userId))];
  const { rows } = await query<{ id: string; views_count: number; community_id: string | null }>(
    `WITH ins AS (
       INSERT INTO post_views (user_id, post_id)
       SELECT $1, p.id FROM posts p WHERE p.id = ANY($2::uuid[]) AND p.deleted_at IS NULL
       ON CONFLICT (user_id, post_id) DO UPDATE SET views = post_views.views + 1, last_seen_at = now()
         WHERE post_views.last_seen_at < now() - interval '30 minutes'
       RETURNING post_id, (xmax = 0) AS fresh
     )
     UPDATE posts p SET views_count = p.views_count + 1
       FROM ins
      WHERE ins.fresh AND p.id = ins.post_id
        AND p.author_id IS DISTINCT FROM $1 AND NOT (p.id = ANY($3::uuid[]))
        AND NOT p.is_pending
      RETURNING p.id, p.views_count, p.community_id`,
    [userId, ids, ownAnon],
  );
  for (const r of rows) {
    const payload = { id: r.id, viewsCount: r.views_count };
    if (r.community_id) emit.community(r.community_id, 'post:update', payload);
    else emit.feed('post:update', payload);
  }
}

export async function cleanupFeedSessions() {
  await query(`DELETE FROM feed_sessions WHERE created_at < now() - interval '1 day'`);
  await query(`DELETE FROM author_snoozes WHERE until < now()`);
}
