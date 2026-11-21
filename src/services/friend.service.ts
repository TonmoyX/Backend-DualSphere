// ═══════════════════════════════════════════════════════════════
// Friends — Facebook-style requests, friendships, mutual friends, suggestions.
// ═══════════════════════════════════════════════════════════════
import type { PoolClient } from 'pg';
import { one, query, tx } from '../config/db.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { emit } from '../lib/realtime.js';
import { publicUser } from '../lib/serialize.js';
import { notificationService } from './notification.service.js';
import { getSettings } from './settings.service.js';

export type FriendStatus = 'self' | 'friends' | 'outgoing' | 'incoming' | 'none';

const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a]) as [string, string];

export async function areFriends(a: string, b: string, c?: PoolClient): Promise<boolean> {
  if (a === b) return false;
  const [x, y] = pair(a, b);
  const sql = 'SELECT 1 FROM friendships WHERE user_a = $1 AND user_b = $2';
  const r = c ? await c.query(sql, [x, y]) : await query(sql, [x, y]);
  return (r.rowCount ?? 0) > 0;
}

async function isBlocked(a: string, b: string) {
  const r = await one('SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)', [a, b]);
  return !!r;
}

function card(r: any) {
  return {
    ...publicUser(r),
    bio: r.profile_locked ? '' : r.bio,
    mutualCount: r.mutual_count ?? 0,
    mutualPreview: (r.mutual_preview ?? []) as { id: string; displayName: string; avatarUrl: string | null }[],
  };
}

/** SQL fragment: mutual friend count + 3 avatar previews between $viewer and u.id. */
const MUTUAL = (viewerParam: string) => `
  (SELECT count(*)::int FROM friend_edges a JOIN friend_edges b ON b.friend_id = a.friend_id
    WHERE a.user_id = ${viewerParam} AND b.user_id = u.id) AS mutual_count,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'displayName', m.display_name, 'avatarUrl', m.avatar_url)), '[]'::jsonb)
     FROM (SELECT mu.id, mu.display_name, mu.avatar_url FROM friend_edges a
             JOIN friend_edges b ON b.friend_id = a.friend_id
             JOIN users mu ON mu.id = a.friend_id
            WHERE a.user_id = ${viewerParam} AND b.user_id = u.id LIMIT 3) m) AS mutual_preview`;

/** Admin limit (Site settings → Limits → Max friends per account). */
async function assertUnderFriendLimit(userId: string, other = false) {
  const max = getSettings().limits.maxFriends;
  const r = await one<{ n: number }>('SELECT count(*)::int AS n FROM friend_edges WHERE user_id = $1', [userId]);
  if ((r?.n ?? 0) >= max) {
    throw forbidden(
      'FRIEND_LIMIT',
      other ? `This person has reached the limit of ${max.toLocaleString()} friends` : `You've reached the limit of ${max.toLocaleString()} friends. Unfriend someone to add more.`,
    );
  }
}

export const friendService = {
  async status(viewerId: string | undefined, otherId: string): Promise<FriendStatus> {
    if (!viewerId) return 'none';
    if (viewerId === otherId) return 'self';
    if (await areFriends(viewerId, otherId)) return 'friends';
    const r = await one<{ sender_id: string }>(
      'SELECT sender_id FROM friend_requests WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)',
      [viewerId, otherId],
    );
    if (!r) return 'none';
    return r.sender_id === viewerId ? 'outgoing' : 'incoming';
  },

  async friendCount(userId: string) {
    const r = await one<{ n: number }>('SELECT count(*)::int AS n FROM friend_edges WHERE user_id = $1', [userId]);
    return r?.n ?? 0;
  },

  async mutual(viewerId: string, otherId: string) {
    const { rows } = await query(
      `SELECT u.id, u.display_name, u.avatar_url FROM friend_edges a
         JOIN friend_edges b ON b.friend_id = a.friend_id
         JOIN users u ON u.id = a.friend_id
        WHERE a.user_id = $1 AND b.user_id = $2 AND u.is_banned = false
        ORDER BY u.display_name LIMIT 6`,
      [viewerId, otherId],
    );
    const count = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM friend_edges a JOIN friend_edges b ON b.friend_id = a.friend_id WHERE a.user_id = $1 AND b.user_id = $2`,
      [viewerId, otherId],
    );
    return { count: count?.n ?? 0, preview: rows.map((r) => ({ id: r.id, displayName: r.display_name, avatarUrl: r.avatar_url })) };
  },

  /** Send a request. If they already asked you, this accepts it instead (Facebook behaviour). */
  async send(me: string, target: string) {
    if (me === target) throw badRequest('SELF', "You can't add yourself");
    const t = await one('SELECT id, is_banned FROM users WHERE id = $1', [target]);
    if (!t || t.is_banned) throw notFound('User');
    if (await isBlocked(me, target)) throw forbidden('BLOCKED', "You can't add this person");
    if (await areFriends(me, target)) throw conflict('ALREADY_FRIENDS', "You're already friends");

    const incoming = await one('SELECT 1 FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2', [target, me]);
    if (incoming) return this.accept(me, target);
    await assertUnderFriendLimit(me);

    const pending = await one<{ n: number }>('SELECT count(*)::int AS n FROM friend_requests WHERE sender_id = $1', [me]);
    if ((pending?.n ?? 0) >= 500) throw badRequest('TOO_MANY_REQUESTS', 'Too many pending friend requests — cancel some first');

    const r = await query('INSERT INTO friend_requests (sender_id, receiver_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [me, target]);
    if (r.rowCount) {
      await notificationService.create({ userId: target, type: 'friend_request', actorId: me });
      emit.users([me, target], 'friend:update', { users: [me, target] });
    }
    return { status: 'outgoing' as FriendStatus };
  },

  async cancel(me: string, target: string) {
    await query('DELETE FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2', [me, target]);
    await query(`DELETE FROM notifications WHERE user_id = $1 AND actor_id = $2 AND type = 'friend_request'`, [target, me]);
    emit.users([me, target], 'friend:update', { users: [me, target] });
    return { status: 'none' as FriendStatus };
  },

  async accept(me: string, sender: string) {
    await assertUnderFriendLimit(me);
    await assertUnderFriendLimit(sender, true);
    const ok = await tx(async (c) => {
      const del = await c.query('DELETE FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2', [sender, me]);
      if (!del.rowCount) return false;
      const [a, b] = pair(me, sender);
      await c.query('INSERT INTO friendships (user_a, user_b) VALUES ($1, $2) ON CONFLICT DO NOTHING', [a, b]);
      // Any message request between the two becomes a normal chat
      await c.query(
        `UPDATE conversation_participants p SET status = 'accepted'
           FROM conversations c WHERE c.id = p.conversation_id AND NOT c.is_group
            AND c.dm_key = $1 AND p.user_id IN ($2, $3)`,
        [`${a}:${b}`, me, sender],
      );
      return true;
    });
    if (!ok) throw notFound('Friend request');
    await query(`DELETE FROM notifications WHERE user_id = $1 AND actor_id = $2 AND type = 'friend_request'`, [me, sender]);
    await notificationService.create({ userId: sender, type: 'friend_accept', actorId: me });
    emit.users([me, sender], 'friend:update', { users: [me, sender] });
    return { status: 'friends' as FriendStatus };
  },

  async decline(me: string, sender: string) {
    await query('DELETE FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2', [sender, me]);
    await query(`DELETE FROM notifications WHERE user_id = $1 AND actor_id = $2 AND type = 'friend_request'`, [me, sender]);
    emit.user(me, 'friend:update', { users: [me, sender] });
    return { status: 'none' as FriendStatus };
  },

  async unfriend(me: string, other: string) {
    const [a, b] = pair(me, other);
    await query('DELETE FROM friendships WHERE user_a = $1 AND user_b = $2', [a, b]);
    emit.users([me, other], 'friend:update', { users: [me, other] });
    return { status: 'none' as FriendStatus };
  },

  /** Blocking someone ends the friendship and any pending requests. */
  async severOnBlock(me: string, other: string) {
    const [a, b] = pair(me, other);
    await query('DELETE FROM friendships WHERE user_a = $1 AND user_b = $2', [a, b]);
    await query('DELETE FROM friend_requests WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)', [me, other]);
  },

  async list(userId: string, viewerId: string | undefined, q?: string, limit = 60) {
    // Only bind parameters the SQL actually uses (Postgres rejects untyped unused params)
    const params: unknown[] = [userId, limit];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    let mutualSql = '0 AS mutual_count, NULL AS mutual_preview, \'none\' AS viewer_status';
    if (viewerId) {
      const v = `${add(viewerId)}::uuid`;
      mutualSql = `${MUTUAL(v)},
        CASE WHEN u.id = ${v} THEN 'self'
             WHEN EXISTS (SELECT 1 FROM friend_edges fe WHERE fe.user_id = ${v} AND fe.friend_id = u.id) THEN 'friends'
             WHEN EXISTS (SELECT 1 FROM friend_requests fr WHERE fr.sender_id = ${v} AND fr.receiver_id = u.id) THEN 'outgoing'
             WHEN EXISTS (SELECT 1 FROM friend_requests fr WHERE fr.sender_id = u.id AND fr.receiver_id = ${v}) THEN 'incoming'
             ELSE 'none' END AS viewer_status`;
    }
    let search = '';
    if (q) {
      const p = add(`%${q.replace(/[%_\\]/g, '\\$&')}%`);
      search = `AND (u.username ILIKE ${p} OR u.display_name ILIKE ${p})`;
    }
    const { rows } = await query(
      `SELECT u.*, ${mutualSql}, e.created_at AS friends_since
         FROM friend_edges e JOIN users u ON u.id = e.friend_id
        WHERE e.user_id = $1 AND u.is_banned = false ${search}
        ORDER BY e.created_at DESC LIMIT $2`,
      params,
    );
    return rows.map((r) => ({ ...card(r), friendsSince: r.friends_since, viewerStatus: r.viewer_status as FriendStatus }));
  },

  /** Everyone who is friends with both `viewer` and `other`. */
  async mutualList(viewerId: string, otherId: string) {
    const { rows } = await query(
      `SELECT u.*, ${MUTUAL('$1')}, 'friends' AS viewer_status
         FROM friend_edges a
         JOIN friend_edges b ON b.friend_id = a.friend_id
         JOIN users u ON u.id = a.friend_id
        WHERE a.user_id = $1 AND b.user_id = $2 AND u.is_banned = false
        ORDER BY u.display_name LIMIT 500`,
      [viewerId, otherId],
    );
    return rows.map((r) => ({ ...card(r), viewerStatus: 'friends' as FriendStatus }));
  },

  async incoming(me: string) {
    const { rows } = await query(
      `SELECT u.*, ${MUTUAL('$1')}, r.created_at AS requested_at
         FROM friend_requests r JOIN users u ON u.id = r.sender_id
        WHERE r.receiver_id = $1 AND u.is_banned = false
        ORDER BY r.created_at DESC LIMIT 100`,
      [me],
    );
    return rows.map((r) => ({ ...card(r), requestedAt: r.requested_at }));
  },

  async outgoing(me: string) {
    const { rows } = await query(
      `SELECT u.*, ${MUTUAL('$1')}, r.created_at AS requested_at
         FROM friend_requests r JOIN users u ON u.id = r.receiver_id
        WHERE r.sender_id = $1 AND u.is_banned = false
        ORDER BY r.created_at DESC LIMIT 100`,
      [me],
    );
    return rows.map((r) => ({ ...card(r), requestedAt: r.requested_at }));
  },

  /**
   * People you may know: friends-of-friends ranked by mutual count, then
   * newer active members as a fallback. Excludes friends, pending requests,
   * blocks (either way) and dismissed suggestions.
   */
  async suggestions(me: string, limit = 20) {
    const { rows } = await query(
      `WITH excluded AS (
         SELECT $1::uuid AS id
         UNION SELECT friend_id FROM friend_edges WHERE user_id = $1
         UNION SELECT receiver_id FROM friend_requests WHERE sender_id = $1
         UNION SELECT sender_id FROM friend_requests WHERE receiver_id = $1
         UNION SELECT blocked_id FROM user_blocks WHERE blocker_id = $1
         UNION SELECT blocker_id FROM user_blocks WHERE blocked_id = $1
         UNION SELECT dismissed_id FROM friend_suggestion_dismissals WHERE user_id = $1
       ),
       fof AS (
         SELECT b.friend_id AS id, count(*)::int AS mutual
           FROM friend_edges a JOIN friend_edges b ON b.user_id = a.friend_id
          WHERE a.user_id = $1
          GROUP BY b.friend_id
       )
       SELECT u.*, ${MUTUAL('$1')}, coalesce(f.mutual, 0) AS rank_mutual
         FROM users u
         LEFT JOIN fof f ON f.id = u.id
        WHERE u.is_banned = false AND u.id NOT IN (SELECT id FROM excluded)
        ORDER BY coalesce(f.mutual, 0) DESC, u.last_login_at DESC NULLS LAST, u.created_at DESC
        LIMIT $2`,
      [me, limit],
    );
    return rows.map(card);
  },

  async dismissSuggestion(me: string, other: string) {
    await query('INSERT INTO friend_suggestion_dismissals (user_id, dismissed_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [me, other]);
  },

  async counts(me: string) {
    const r = await one<{ friends: number; incoming: number; outgoing: number }>(
      `SELECT (SELECT count(*) FROM friend_edges WHERE user_id = $1)::int AS friends,
              (SELECT count(*) FROM friend_requests r JOIN users u ON u.id = r.sender_id WHERE r.receiver_id = $1 AND NOT u.is_banned)::int AS incoming,
              (SELECT count(*) FROM friend_requests WHERE sender_id = $1)::int AS outgoing`,
      [me],
    );
    return r ?? { friends: 0, incoming: 0, outgoing: 0 };
  },
};
