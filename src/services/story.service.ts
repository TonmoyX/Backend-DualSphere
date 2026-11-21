// ═══════════════════════════════════════════════════════════════
// Stories — 24h photo / video / text stories (Facebook-style).
// Visible to: the author, their friends, and everyone for "public" stories.
// ═══════════════════════════════════════════════════════════════
import { one, query } from '../config/db.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { emit } from '../lib/realtime.js';
import { deleteObject } from '../lib/storage.js';
import { cleanText } from '../lib/text.js';
import type { AuthUser } from '../types/index.js';
import { mediaService } from './media.service.js';
import { messageService } from './message.service.js';

/** SQL predicate: can $1 (viewer) see story `s`? */
const VISIBLE = `
  s.expires_at > now()
  AND (s.author_id = $1
       OR s.audience = 'public'
       OR EXISTS (SELECT 1 FROM friend_edges e WHERE e.user_id = $1 AND e.friend_id = s.author_id))
  AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = s.author_id) OR (b.blocker_id = s.author_id AND b.blocked_id = $1))`;

const BACKGROUNDS = new Set([
  'linear-gradient(135deg,#6c63ff,#a855f7)',
  'linear-gradient(135deg,#22d3a0,#0ea5e9)',
  'linear-gradient(135deg,#f97316,#ec4899)',
  'linear-gradient(135deg,#0f172a,#334155)',
  'linear-gradient(135deg,#facc15,#f97316)',
  'linear-gradient(135deg,#ef4444,#7c3aed)',
]);

function serialize(r: any, viewerId: string) {
  return {
    id: r.id,
    kind: r.kind as 'image' | 'video' | 'text',
    mediaUrl: r.media_url,
    text: r.text,
    background: r.background,
    audience: r.audience as 'friends' | 'public',
    createdAt: new Date(r.created_at).toISOString(),
    expiresAt: new Date(r.expires_at).toISOString(),
    seen: r.author_id === viewerId ? true : !!r.seen,
    viewCount: r.author_id === viewerId ? (r.view_count ?? 0) : undefined, // only the author sees counts
    myReaction: (r.my_reaction ?? null) as string | null,
  };
}

async function loadVisible(storyId: string, viewerId: string) {
  const s = await one(`SELECT s.* FROM stories s WHERE s.id = $2 AND ${VISIBLE}`, [viewerId, storyId]);
  if (!s) throw notFound('Story');
  return s;
}

export const storyService = {
  async create(user: AuthUser, input: { mediaId?: string; text?: string; background?: string; audience: 'friends' | 'public' }) {
    let kind: 'image' | 'video' | 'text' = 'text';
    let mediaUrl: string | null = null;
    let mediaId: string | null = null;
    const text = input.text ? cleanText(input.text).slice(0, 500) : null;

    if (input.mediaId) {
      const [m] = await mediaService.claimable([input.mediaId], user.id, 'story');
      if (m.kind !== 'image' && m.kind !== 'video') throw badRequest('BAD_MEDIA', 'Stories support photos and videos');
      kind = m.kind;
      mediaUrl = m.url;
      mediaId = m.id;
      await query(`UPDATE media SET status = 'attached' WHERE id = $1`, [m.id]);
    } else if (!text) {
      throw badRequest('EMPTY_STORY', 'Add a photo, video or some text');
    }
    const background = kind === 'text' ? (input.background && BACKGROUNDS.has(input.background) ? input.background : [...BACKGROUNDS][0]) : null;

    const { rows } = await query(
      `INSERT INTO stories (author_id, kind, media_url, media_id, text, background, audience) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [user.id, kind, mediaUrl, mediaId, text, background, input.audience],
    );
    // Let friends' story bars refresh live
    const { rows: friends } = await query<{ friend_id: string }>('SELECT friend_id FROM friend_edges WHERE user_id = $1', [user.id]);
    emit.users([user.id, ...friends.map((f) => f.friend_id)], 'story:update', { authorId: user.id });
    return serialize(rows[0], user.id);
  },

  /** Story bar: one entry per author, you first, then authors with unseen stories. */
  async feed(viewerId: string) {
    const { rows } = await query(
      `SELECT s.*, u.username, u.display_name, u.avatar_url, u.is_verified,
              EXISTS (SELECT 1 FROM story_views v WHERE v.story_id = s.id AND v.viewer_id = $1) AS seen,
              (SELECT v.reaction FROM story_views v WHERE v.story_id = s.id AND v.viewer_id = $1) AS my_reaction,
              (SELECT count(*)::int FROM story_views v WHERE v.story_id = s.id) AS view_count
         FROM stories s JOIN users u ON u.id = s.author_id
        WHERE u.is_banned = false AND ${VISIBLE}
        ORDER BY s.created_at ASC
        LIMIT 500`,
      [viewerId],
    );
    const groups = new Map<string, any>();
    for (const r of rows) {
      const g = groups.get(r.author_id) ?? {
        author: { id: r.author_id, username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url, isVerified: !!r.is_verified },
        isMe: r.author_id === viewerId,
        stories: [] as ReturnType<typeof serialize>[],
      };
      g.stories.push(serialize(r, viewerId));
      groups.set(r.author_id, g);
    }
    return [...groups.values()]
      .map((g) => ({ ...g, hasUnseen: g.stories.some((s: { seen: boolean }) => !s.seen), latestAt: g.stories.at(-1).createdAt }))
      .sort((a, b) => Number(b.isMe) - Number(a.isMe) || Number(b.hasUnseen) - Number(a.hasUnseen) || +new Date(b.latestAt) - +new Date(a.latestAt))
      .slice(0, 60);
  },

  async view(storyId: string, viewerId: string) {
    const s = await loadVisible(storyId, viewerId);
    if (s.author_id !== viewerId) {
      await query('INSERT INTO story_views (story_id, viewer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [storyId, viewerId]);
    }
  },

  async viewers(storyId: string, ownerId: string) {
    const s = await one('SELECT author_id FROM stories WHERE id = $1', [storyId]);
    if (!s) throw notFound('Story');
    if (s.author_id !== ownerId) throw forbidden('NOT_OWNER', 'Only the author can see viewers');
    const { rows } = await query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, v.reaction, v.viewed_at
         FROM story_views v JOIN users u ON u.id = v.viewer_id
        WHERE v.story_id = $1 ORDER BY v.viewed_at DESC LIMIT 500`,
      [storyId],
    );
    return rows.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url, reaction: r.reaction, viewedAt: r.viewed_at }));
  },

  /** A message reply goes to the author's DMs with a snapshot of the story. */
  async reply(storyId: string, user: AuthUser, content: string) {
    const s = await loadVisible(storyId, user.id);
    if (s.author_id === user.id) throw badRequest('OWN_STORY', "You can't reply to your own story");
    const conv = await messageService.create(user, [s.author_id]);
    const storyRef = { storyId: s.id, kind: s.kind, mediaUrl: s.media_url, text: s.text, background: s.background, action: 'reply' };
    const message = await messageService.send(conv.id, user, { content, storyRef });
    return { conversationId: conv.id, message };
  },

  /** A reaction stays on the story (author sees it in the viewers list); tapping the same emoji again removes it. */
  async react(storyId: string, user: AuthUser, emoji: string | null) {
    const s = await loadVisible(storyId, user.id);
    if (s.author_id === user.id) throw badRequest('OWN_STORY', "You can't react to your own story");
    await query(
      `INSERT INTO story_views (story_id, viewer_id, reaction) VALUES ($1, $2, $3)
       ON CONFLICT (story_id, viewer_id) DO UPDATE SET reaction = EXCLUDED.reaction`,
      [storyId, user.id, emoji],
    );
    emit.user(s.author_id, 'story:update', { authorId: s.author_id });
    return { reaction: emoji };
  },

  async remove(storyId: string, ownerId: string) {
    const s = await one('SELECT * FROM stories WHERE id = $1', [storyId]);
    if (!s) throw notFound('Story');
    if (s.author_id !== ownerId) throw forbidden('NOT_OWNER', 'You can only delete your own stories');
    await query('DELETE FROM stories WHERE id = $1', [storyId]);
    if (s.media_id) {
      const m = await one('SELECT object_key, storage FROM media WHERE id = $1', [s.media_id]);
      await query('DELETE FROM media WHERE id = $1', [s.media_id]);
      if (m) await deleteObject(m.object_key, m.storage);
    }
    emit.user(ownerId, 'story:update', { authorId: ownerId });
  },

  /** Background job: purge expired stories and their files. */
  async cleanupExpired() {
    const { rows } = await query(
      `DELETE FROM stories WHERE expires_at < now() RETURNING media_id`,
    );
    for (const r of rows) {
      if (!r.media_id) continue;
      const m = await one('DELETE FROM media WHERE id = $1 RETURNING object_key, storage', [r.media_id]);
      if (m) await deleteObject(m.object_key, m.storage);
    }
    if (rows.length) logger.info(`Purged ${rows.length} expired stories`);
  },

  backgrounds: [...BACKGROUNDS],
};
