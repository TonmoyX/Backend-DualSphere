import { one, query, tx } from '../config/db.js';
import { randomToken } from '../lib/crypto.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { emit } from '../lib/realtime.js';
import { publicUser } from '../lib/serialize.js';
import { cleanText, contentHash } from '../lib/text.js';
import type { AuthUser } from '../types/index.js';
import { getSelf } from './auth.service.js';
import { getFeed, hydratePosts, POST_COLUMNS } from './feed.service.js';
import { mediaService } from './media.service.js';
import { POST_SELECT } from './post.service.js';
import { areFriends, friendService } from './friend.service.js';

/**
 * Facebook rule: only the owner and their friends see a locked profile.
 * Staff get no special pass on the public site — they moderate via the admin panel.
 */
async function canSeeLocked(row: { id: string }, viewer?: AuthUser) {
  if (!viewer) return false;
  if (viewer.id === row.id) return true;
  return areFriends(viewer.id, row.id);
}

/** Who can see the full friends list: owner/staff always; otherwise per the user's setting (and lock). */
async function canSeeFriendList(row: { id: string; profile_locked: boolean; friends_visibility: string }, viewer?: AuthUser) {
  if (viewer && viewer.id === row.id) return true;
  if (row.profile_locked && !(await canSeeLocked(row, viewer))) return false;
  if (row.friends_visibility === 'public') return true;
  if (row.friends_visibility === 'friends') return !!viewer && (await areFriends(viewer.id, row.id));
  return false;
}

export const userService = {
  async byUsername(username: string) {
    const row = await one('SELECT * FROM users WHERE lower(username) = lower($1) AND is_banned = false', [username]);
    if (!row) throw notFound('User');
    return row;
  },

  async profile(username: string, viewer?: AuthUser) {
    const row = await this.byUsername(username);
    const isMe = viewer?.id === row.id;
    const blockedByMe = viewer && !isMe
      ? !!(await one('SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [viewer.id, row.id]))
      : false;

    const friendStatus = await friendService.status(viewer?.id, row.id);
    const mutual = viewer && !isMe ? await friendService.mutual(viewer.id, row.id) : { count: 0, preview: [] };
    const canSeeList = await canSeeFriendList(row, viewer);
    const friends = {
      status: friendStatus,
      mutualCount: mutual.count,
      mutualPreview: mutual.preview,
      canSeeList,
      count: canSeeList ? await friendService.friendCount(row.id) : null,
      visibility: isMe ? (row.friends_visibility as string) : undefined,
    };

    // Locked profile: visitors only get name, username and profile picture — no friends info at all
    if (row.profile_locked && !(await canSeeLocked(row, viewer))) {
      return {
        ...publicUser(row), bio: '', coverUrl: null, postCount: 0, isMe, blockedByMe, restricted: true,
        friends: { ...friends, mutualCount: 0, mutualPreview: [], canSeeList: false, count: null },
      };
    }
    return { ...publicUser(row), isMe, blockedByMe, restricted: false, friends };
  },

  /** Timeline: identity posts only. Anonymous posts are structurally impossible here (author_id IS NULL). */
  async posts(username: string, cursor: string | undefined, limit: number, viewer?: AuthUser) {
    const row = await this.byUsername(username);
    if (row.profile_locked && !(await canSeeLocked(row, viewer))) return { posts: [], cursor: null, hasMore: false, locked: true };
    return getFeed({ authorId: row.id, cursor, limit, viewer });
  },

  /** Full list when allowed; otherwise only the friends you have in common. */
  async friendsOf(username: string, viewer?: AuthUser) {
    const row = await this.byUsername(username);
    // Locked and not a friend → nothing (not even mutual friends)
    if (row.profile_locked && !(await canSeeLocked(row, viewer))) return { mode: 'locked' as const, friends: [] };
    if (await canSeeFriendList(row, viewer)) {
      return { mode: 'all' as const, friends: await friendService.list(row.id, viewer?.id, undefined, 500) };
    }
    if (viewer && viewer.id !== row.id) {
      return { mode: 'mutual' as const, friends: await friendService.mutualList(viewer.id, row.id) };
    }
    return { mode: 'hidden' as const, friends: [] };
  },

  /** Every photo from the user's IDENTITY posts (anonymous posts can never appear: author_id IS NULL). */
  async photos(username: string, viewer: AuthUser | undefined, page: number, limit: number) {
    const row = await this.byUsername(username);
    if (row.profile_locked && !(await canSeeLocked(row, viewer))) return { photos: [], hasMore: false, locked: true };
    const { rows } = await query(
      `SELECT p.id AS post_id, p.created_at, p.post_type, m->>'url' AS url
         FROM posts p CROSS JOIN LATERAL jsonb_array_elements(p.media) m
        WHERE p.author_id = $1 AND p.visibility = 'identity' AND p.is_removed = false AND p.deleted_at IS NULL
          AND m->>'type' = 'image'
        ORDER BY p.created_at DESC
        LIMIT $2 OFFSET $3`,
      [row.id, limit + 1, (page - 1) * limit],
    );
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return {
      photos: rows.map((r) => ({ url: r.url, postId: r.post_id, createdAt: r.created_at, isProfilePicture: r.post_type === 'avatar_update' })),
      hasMore,
      locked: false,
    };
  },

  /** Report a profile (impersonation, harassment, spam account…). Goes to the staff report queue. */
  async report(username: string, user: AuthUser, reason: string, details?: string) {
    const row = await this.byUsername(username);
    if (row.id === user.id) throw badRequest('OWN_PROFILE', "You can't report your own profile");
    try {
      await query(
        `INSERT INTO reports (target_id, target_type, reporter_id, reason, details) VALUES ($1, 'user', $2, $3, $4)`,
        [row.id, user.id, reason, details ? cleanText(details) : null],
      );
    } catch (err: any) {
      if (err?.code === '23505') throw new AppError(409, 'ALREADY_REPORTED', 'You already reported this profile');
      throw err;
    }
    emit.staff('admin:report', { targetType: 'user', targetId: row.id, reason });
    return { reported: true };
  },

  /** Reels tab: the user's identity posts that contain a video, newest first (full post data for the reel viewer). */
  async reels(username: string, viewer: AuthUser | undefined, page: number, limit: number) {
    const row = await this.byUsername(username);
    if (row.profile_locked && !(await canSeeLocked(row, viewer))) return { reels: [], hasMore: false, locked: true };
    const { rows } = await query(
      `SELECT ${POST_COLUMNS} FROM posts p LEFT JOIN users u ON u.id = p.author_id
        WHERE p.author_id = $1 AND p.visibility = 'identity' AND p.is_removed = false AND p.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.media) m WHERE m->>'type' = 'video')
        ORDER BY p.created_at DESC
        LIMIT $2 OFFSET $3`,
      [row.id, limit + 1, (page - 1) * limit],
    );
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return { reels: await hydratePosts(rows, viewer), hasMore, locked: false };
  },

  async search(q: string, limit = 10) {
    const { rows } = await query(
      `SELECT * FROM users
        WHERE is_banned = false AND (username ILIKE $1 OR display_name ILIKE $1)
        ORDER BY (lower(username) = lower($2)) DESC, post_count DESC LIMIT $3`,
      [`%${q.replace(/[%_\\]/g, '\\$&')}%`, q, limit],
    );
    return rows.map((r) => ({ ...publicUser(r), bio: r.profile_locked ? '' : r.bio }));
  },

  async updateMe(
    user: AuthUser,
    input: {
      displayName?: string; bio?: string; avatarMediaId?: string | null; coverMediaId?: string | null;
      showActivity?: boolean; profileLocked?: boolean; shareAvatarToFeed?: boolean; friendsVisibility?: 'public' | 'friends' | 'only_me';
    },
  ) {
    const sets: string[] = [];
    const params: unknown[] = [user.id];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };

    if (input.displayName !== undefined) set('display_name', cleanText(input.displayName).slice(0, 64) || user.username);
    if (input.bio !== undefined) set('bio', cleanText(input.bio).slice(0, 300));
    let newAvatarUrl: string | null = null;
    if (input.avatarMediaId !== undefined) {
      newAvatarUrl = input.avatarMediaId ? await mediaService.useForProfile(user.id, input.avatarMediaId, 'avatar') : null;
      set('avatar_url', newAvatarUrl);
    }
    if (input.coverMediaId !== undefined) set('cover_url', input.coverMediaId ? await mediaService.useForProfile(user.id, input.coverMediaId, 'cover') : null);
    if (input.showActivity !== undefined) set('show_activity', input.showActivity);
    if (input.profileLocked !== undefined) set('profile_locked', input.profileLocked);
    if (input.friendsVisibility !== undefined) set('friends_visibility', input.friendsVisibility);

    const before = input.avatarMediaId !== undefined || input.coverMediaId !== undefined
      ? await one<{ avatar_url: string | null; cover_url: string | null }>('SELECT avatar_url, cover_url FROM users WHERE id = $1', [user.id])
      : null;
    if (sets.length) await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params);

    // Optional: announce the new profile picture in the feed (profile picture only)
    if (newAvatarUrl && input.shareAvatarToFeed) {
      const postId = await tx(async (c) => {
        const { rows } = await c.query(
          `INSERT INTO posts (content, media, visibility, author_id, content_hash, post_type)
           VALUES ('', $1, 'identity', $2, $3, 'avatar_update') RETURNING id`,
          [JSON.stringify([{ id: input.avatarMediaId, url: newAvatarUrl, type: 'image' }]), user.id, contentHash(`avatar:${randomToken(8)}`)],
        );
        await c.query('UPDATE users SET post_count = post_count + 1 WHERE id = $1', [user.id]);
        return rows[0].id as string;
      });
      const full = await one(`${POST_SELECT} WHERE p.id = $1`, [postId]);
      emit.feed('post:new', (await hydratePosts([full]))[0]);
    }
    // Replaced/removed profile or cover photo → delete the old file from storage if nothing else shows it
    if (before && input.avatarMediaId !== undefined) await mediaService.releaseIfUnused(before.avatar_url);
    if (before && input.coverMediaId !== undefined) await mediaService.releaseIfUnused(before.cover_url);
    return getSelf(user.id);
  },
};
