import { query } from '../config/db.js';
import { emit } from '../lib/realtime.js';
import { decodeCursor, encodeCursor } from '../lib/serialize.js';
import { identityService } from './identity.service.js';

/** How far back anonymous-post notifications are resolved (they are matched by HMAC at read time). */
const ANON_WINDOW = "interval '90 days'";
const ANON_SCAN = 1000;

interface NewNotification {
  userId: string;
  type: 'like' | 'comment' | 'reply' | 'security' | 'system' | 'moderation' | 'friend_request' | 'friend_accept' | 'share';
  actorId?: string | null;
  postId?: string | null;
  commentId?: string | null;
  message?: string | null;
  actorAnon?: boolean; // actor shown as "Anonymous" (e.g. an anonymous author replying)
}

interface NewAnonNotification {
  postId: string;
  type: 'like' | 'comment' | 'reply' | 'share';
  actorId?: string | null; // NULL when the actor was anonymous too
  commentId?: string | null;
}

type Item = {
  id: string; type: string; message: string | null; postId: string | null; commentId: string | null; postExcerpt: string | null;
  actor: { id: string; username: string; displayName: string; avatarUrl: string | null } | null;
  actorAnon: boolean; onAnonymousPost: boolean; read: boolean; createdAt: Date;
};

/** Anonymous-post notifications that belong to `userId` (resolved by HMAC, never by a stored recipient). */
async function ownedAnon(userId: string, where: string, params: unknown[]) {
  const { rows } = await query(
    `SELECT an.*, a.username AS actor_username, a.display_name AS actor_display_name, a.avatar_url AS actor_avatar_url,
            left(p.content, 120) AS post_excerpt
       FROM anon_notifications an
       JOIN posts p ON p.id = an.post_id AND p.visibility = 'anonymous' AND p.deleted_at IS NULL
       LEFT JOIN users a ON a.id = an.actor_id
      WHERE an.created_at > now() - ${ANON_WINDOW} ${where}
      ORDER BY an.created_at DESC, an.id DESC LIMIT ${ANON_SCAN}`,
    params,
  );
  if (!rows.length) return [];
  const mine = await identityService.ownedBy([...new Set(rows.map((r) => r.post_id as string))], userId);
  return rows.filter((r) => mine.has(r.post_id) && r.actor_id !== userId);
}

/**
 * NOTE (privacy): `notifications` rows are only ever for IDENTITY recipients. The hidden author of an
 * anonymous post is notified through `anon_notifications`, which has no recipient column (see createAnon).
 */
export const notificationService = {
  async create(n: NewNotification) {
    if (n.actorId && n.actorId === n.userId) return; // no self-notifications
    const { rows } = await query(
      `INSERT INTO notifications (user_id, type, actor_id, post_id, comment_id, message, actor_anon)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
      [n.userId, n.type, n.actorAnon ? null : (n.actorId ?? null), n.postId ?? null, n.commentId ?? null, n.message ?? null, !!n.actorAnon],
    );
    emit.user(n.userId, 'notification', { id: rows[0].id, type: n.type });
  },

  /**
   * Notify the (hidden) author of an anonymous post. Stored against the POST only; pushed live to the
   * author's open tabs via the in-memory `anonpost:<id>` room (joined after an HMAC ownership check).
   */
  async createAnon(n: NewAnonNotification) {
    const { rows } = await query(
      `INSERT INTO anon_notifications (post_id, type, actor_id, comment_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [n.postId, n.type, n.actorId ?? null, n.commentId ?? null],
    );
    emit.anonPost(n.postId, 'notification', { id: rows[0].id, type: n.type });
  },

  async removeAnonLike(postId: string, actorId: string) {
    await query(`DELETE FROM anon_notifications WHERE post_id = $1 AND actor_id = $2 AND type = 'like'`, [postId, actorId]);
  },

  async removeLike(userId: string, actorId: string, postId: string) {
    await query(`DELETE FROM notifications WHERE user_id = $1 AND actor_id = $2 AND post_id = $3 AND type = 'like'`, [userId, actorId, postId]);
  },

  async list(userId: string, cursor?: string, limit = 20) {
    const c = decodeCursor(cursor);
    const { rows } = await query(
      `SELECT n.*, a.username AS actor_username, a.display_name AS actor_display_name, a.avatar_url AS actor_avatar_url,
              left(p.content, 120) AS post_excerpt
         FROM notifications n
         LEFT JOIN users a ON a.id = n.actor_id
         LEFT JOIN posts p ON p.id = n.post_id
        WHERE n.user_id = $1 ${c ? 'AND (n.created_at, n.id) < ($3, $4)' : ''}
        ORDER BY n.created_at DESC, n.id DESC LIMIT $2`,
      c ? [userId, limit + 1, c.ts, c.id] : [userId, limit + 1],
    );
    const anon = await ownedAnon(userId, c ? 'AND (an.created_at, an.id) < ($1, $2)' : '', c ? [c.ts, c.id] : []);

    const map = (r: any, onAnonymousPost: boolean): Item => ({
      id: r.id,
      type: r.type,
      message: r.message ?? null,
      postId: r.post_id,
      commentId: r.comment_id,
      postExcerpt: r.post_excerpt,
      actor: r.actor_id ? { id: r.actor_id, username: r.actor_username, displayName: r.actor_display_name, avatarUrl: r.actor_avatar_url } : null,
      actorAnon: !!r.actor_anon || (onAnonymousPost && !r.actor_id),
      onAnonymousPost,
      read: !!r.read_at,
      createdAt: r.created_at,
    });
    const merged = [...rows.map((r) => map(r, false)), ...anon.map((r) => map(r, true))].sort(
      (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt) || (a.id < b.id ? 1 : -1),
    );
    const hasMore = merged.length > limit;
    const items = merged.slice(0, limit);
    return {
      items,
      cursor: hasMore ? encodeCursor(items.at(-1)!.createdAt, items.at(-1)!.id) : null,
      hasMore,
    };
  },

  async unreadCount(userId: string) {
    const { rows } = await query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId]);
    const anon = await ownedAnon(userId, 'AND an.read_at IS NULL', []);
    return (rows[0].n as number) + anon.length;
  },

  async markRead(userId: string, ids?: string[]) {
    if (ids?.length) {
      await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL', [userId, ids]);
    } else {
      await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [userId]);
    }
    // Anonymous-post notifications: only ones this user provably owns (HMAC), never by id alone
    const anon = await ownedAnon(userId, ids?.length ? 'AND an.read_at IS NULL AND an.id = ANY($1::uuid[])' : 'AND an.read_at IS NULL', ids?.length ? [ids] : []);
    if (anon.length) await query('UPDATE anon_notifications SET read_at = now() WHERE id = ANY($1::uuid[])', [anon.map((r) => r.id)]);
  },
};
