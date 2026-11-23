// ═══════════════════════════════════════════════════════════════
// Follows — one-way. Friends follow each other automatically (see friend.service accept);
// either side can unfollow and stay friends.
// ═══════════════════════════════════════════════════════════════
import type { PoolClient } from 'pg';
import { one, query } from '../config/db.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { emit } from '../lib/realtime.js';
import { publicUser } from '../lib/serialize.js';

export interface FollowInfo {
  followers: number | null; // null when the profile is locked to you
  following: number | null; // 0 to people the owner hides their following list from
  isFollowing: boolean; // you follow them
  followsMe: boolean; // they follow you
}

/** Both directions at once — used when two people become friends. */
export async function followEachOther(a: string, b: string, c: PoolClient) {
  await c.query('INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING', [a, b]);
}

/** Remove both directions — used on unfriend and block. */
export async function unfollowEachOther(a: string, b: string) {
  await query('DELETE FROM follows WHERE (follower_id = $1 AND followee_id = $2) OR (follower_id = $2 AND followee_id = $1)', [a, b]);
}

export const followService = {
  async info(userId: string, viewerId: string | undefined, showCounts: boolean, hideFollowing = false): Promise<FollowInfo> {
    const r = await one<{ followers: number; following: number; is_following: boolean; follows_me: boolean }>(
      `SELECT
         (SELECT count(*)::int FROM follows WHERE followee_id = $1) AS followers,
         (SELECT count(*)::int FROM follows WHERE follower_id = $1) AS following,
         EXISTS (SELECT 1 FROM follows WHERE follower_id = $2 AND followee_id = $1) AS is_following,
         EXISTS (SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2) AS follows_me`,
      [userId, viewerId ?? null],
    );
    return {
      followers: showCounts ? (r?.followers ?? 0) : null,
      following: showCounts ? (hideFollowing ? 0 : (r?.following ?? 0)) : null,
      isFollowing: !!r?.is_following,
      followsMe: !!r?.follows_me,
    };
  },

  async follow(me: string, targetId: string) {
    if (me === targetId) throw badRequest('SELF', "You can't follow yourself");
    const t = await one('SELECT id FROM users WHERE id = $1 AND is_banned = false', [targetId]);
    if (!t) throw notFound('User');
    const blocked = await one(
      'SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)',
      [me, targetId],
    );
    if (blocked) throw forbidden('BLOCKED', "You can't follow this account");
    await query('INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [me, targetId]);
    emit.users([me, targetId], 'follow:update', { users: [me, targetId] });
    return { isFollowing: true };
  },

  async unfollow(me: string, targetId: string) {
    await query('DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2', [me, targetId]);
    emit.users([me, targetId], 'follow:update', { users: [me, targetId] });
    return { isFollowing: false };
  },

  /** Followers or following of a user, newest first, with whether the viewer follows each one. */
  async list(userId: string, kind: 'followers' | 'following', viewerId: string | undefined, limit = 200) {
    const join = kind === 'followers' ? 'f.follower_id' : 'f.followee_id';
    const where = kind === 'followers' ? 'f.followee_id' : 'f.follower_id';
    const { rows } = await query(
      `SELECT u.*, f.created_at AS followed_at,
              EXISTS (SELECT 1 FROM follows v WHERE v.follower_id = $2 AND v.followee_id = u.id) AS viewer_follows
         FROM follows f JOIN users u ON u.id = ${join}
        WHERE ${where} = $1 AND u.is_banned = false
          AND NOT EXISTS (SELECT 1 FROM user_blocks b
                           WHERE (b.blocker_id = $2 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $2))
        ORDER BY f.created_at DESC LIMIT $3`,
      [userId, viewerId ?? null, limit],
    );
    return rows.map((r) => ({
      ...publicUser(r),
      bio: r.profile_locked ? '' : r.bio,
      viewerFollows: !!r.viewer_follows,
      isMe: r.id === viewerId,
    }));
  },
};
