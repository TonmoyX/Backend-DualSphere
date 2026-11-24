// ═══════════════════════════════════════════════════════════════
// Direct messaging — Instagram-style.
// 1:1 + group chats · message requests · replies · reactions · unsend
// read receipts · typing (via realtime.ts) · blocks · activity status
// ═══════════════════════════════════════════════════════════════
import type { PoolClient } from 'pg';
import { one, query, tx } from '../config/db.js';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { emit, forgetMembership, isOnline } from '../lib/realtime.js';
import { cleanText } from '../lib/text.js';
import type { AuthUser } from '../types/index.js';
import { auditService } from './audit.service.js';
import { mediaService } from './media.service.js';
import { areFriends, friendService } from './friend.service.js';
import { getSettings } from './settings.service.js';

const MAX_GROUP = 32;
const PAGE = 40;

function assertEnabled() {
  if (!getSettings().features.messagingEnabled) throw forbidden('MESSAGING_DISABLED', 'Messaging is currently turned off');
}

async function isBlockedEitherWay(a: string, b: string, c: PoolClient | null = null) {
  const sql = `SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1) LIMIT 1`;
  const r = c ? await c.query(sql, [a, b]) : await query(sql, [a, b]);
  return (r.rowCount ?? 0) > 0;
}

async function participantIds(conversationId: string) {
  const { rows } = await query<{ user_id: string }>('SELECT user_id FROM conversation_participants WHERE conversation_id = $1', [conversationId]);
  return rows.map((r) => r.user_id);
}

/** Loads the conversation + the caller's membership. Throws 404 for non-members (no existence leak). */
async function membership(conversationId: string, userId: string) {
  const row = await one(
    `SELECT c.*, p.status, p.role AS my_role, p.hidden, p.muted, p.cleared_at, p.last_read_at
       FROM conversations c JOIN conversation_participants p ON p.conversation_id = c.id AND p.user_id = $2
      WHERE c.id = $1`,
    [conversationId, userId],
  );
  if (!row) throw notFound('Conversation');
  return row;
}

/**
 * Copy messages into the 90-day archive before they're deleted for users (see Privacy Policy).
 * Their files are kept too and only removed when the archive entry is purged.
 */
async function archiveMessages(c: PoolClient, where: { messageId: string } | { conversationId: string }, reason: 'unsent' | 'conversation_deleted', deletedBy: string | null) {
  const byMsg = 'messageId' in where;
  await c.query(
    `INSERT INTO message_archive (message_id, conversation_id, conversation_title, is_group, participant_ids, sender_id, kind, content, media,
                                  reply_to_id, edit_history, files, sent_at, edited_at, reason, deleted_by)
     SELECT m.id, m.conversation_id, cv.title, cv.is_group,
            COALESCE((SELECT array_agg(p.user_id) FROM conversation_participants p WHERE p.conversation_id = m.conversation_id), '{}'),
            m.sender_id, m.kind, m.content, m.media, m.reply_to_id,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('content', e.previous_content, 'editedAt', e.edited_at) ORDER BY e.edited_at)
                        FROM message_edits e WHERE e.message_id = m.id), '[]'::jsonb),
            COALESCE((SELECT jsonb_agg(jsonb_build_object('mediaId', md.id, 'objectKey', md.object_key, 'storage', md.storage))
                        FROM media md WHERE md.message_id = m.id), '[]'::jsonb),
            m.created_at, m.edited_at, $2, $3
       FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
      WHERE ${byMsg ? 'm.id = $1' : 'm.conversation_id = $1'} AND m.kind <> 'system'`,
    [byMsg ? where.messageId : where.conversationId, reason, deletedBy],
  );
}

async function systemMessage(c: PoolClient, conversationId: string, actorId: string, text: string) {
  await c.query(`INSERT INTO messages (conversation_id, sender_id, kind, content) VALUES ($1, $2, 'system', $3)`, [conversationId, actorId, text]);
  await c.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [conversationId]);
}

// ── serializers ──────────────────────────────────────────────────
const MESSAGE_SELECT = `
  SELECT m.*, u.username, u.display_name, u.avatar_url, u.is_verified,
         r.id AS r_id, r.content AS r_content, r.kind AS r_kind, r.unsent_at AS r_unsent, r.removed_by_mod AS r_removed,
         r.sender_id AS r_sender_id, ru.display_name AS r_sender_name, jsonb_array_length(r.media) AS r_media_count,
         coalesce((SELECT jsonb_agg(jsonb_build_object('emoji', mr.emoji, 'userId', mr.user_id) ORDER BY mr.created_at)
                     FROM message_reactions mr WHERE mr.message_id = m.id), '[]'::jsonb) AS reactions
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    LEFT JOIN messages r ON r.id = m.reply_to_id
    LEFT JOIN users ru ON ru.id = r.sender_id`;

function serializeMessage(m: any) {
  const gone = !!m.unsent_at || m.removed_by_mod;
  return {
    id: m.id,
    conversationId: m.conversation_id,
    kind: m.kind as 'text' | 'media' | 'heart' | 'system',
    content: gone ? '' : m.content,
    media: gone ? [] : (m.media ?? []),
    unsent: !!m.unsent_at,
    removed: !!m.removed_by_mod,
    sender: m.sender_id
      ? { id: m.sender_id, username: m.username, displayName: m.display_name, avatarUrl: m.avatar_url, isVerified: !!m.is_verified }
      : null,
    replyTo: m.r_id
      ? {
          id: m.r_id,
          senderId: m.r_sender_id,
          senderName: m.r_sender_name,
          kind: m.r_kind,
          content: m.r_unsent || m.r_removed ? '' : String(m.r_content ?? '').slice(0, 140),
          hasMedia: (m.r_media_count ?? 0) > 0,
          unsent: !!m.r_unsent || !!m.r_removed,
        }
      : null,
    reactions: (m.reactions ?? []) as { emoji: string; userId: string }[],
    editedAt: m.edited_at && !gone ? new Date(m.edited_at).toISOString() : null,
    call: m.kind === 'call' ? parseCall(m.content) : null,
    storyRef: m.story_ref ?? null,
    forwardedFrom: m.forwarded_from_name ? { name: m.forwarded_from_name, userId: m.forwarded_from_user ?? null } : null,
    createdAt: new Date(m.created_at).toISOString(),
  };
}
export type MessageDTO = ReturnType<typeof serializeMessage>;

function parseCall(content: string): { kind: 'audio' | 'video'; status: 'ended' | 'missed' | 'declined' | 'busy'; duration: number } | null {
  try {
    const c = JSON.parse(content);
    return { kind: c.kind === 'video' ? 'video' : 'audio', status: c.status, duration: Number(c.duration) || 0 };
  } catch {
    return null;
  }
}

function preview(m: { kind: string; content: string; unsent: boolean; removed: boolean; mediaCount: number; mediaType?: string | null }) {
  if (m.unsent) return 'Unsent a message';
  if (m.removed) return 'Message removed';
  if (m.kind === 'heart') return '❤️';
  if (m.kind === 'call') {
    const c = parseCall(m.content);
    const what = c?.kind === 'video' ? 'Video call' : 'Voice call';
    return c?.status === 'ended' ? `📞 ${what}` : `📞 ${c?.status === 'declined' ? 'Declined' : 'Missed'} ${what.toLowerCase()}`;
  }
  if (m.kind === 'media' && m.mediaType === 'audio' && !m.content) return '🎤 Voice message';
  if (m.kind === 'media' && !m.content) return m.mediaCount > 1 ? `Sent ${m.mediaCount} attachments` : 'Sent an attachment';
  // A shared post/profile link: show what it is instead of a raw URL (any text before the link is kept)
  const link = /^([\s\S]*?)\s*https?:\/\/\S+?\/(post|profile)\/[^\s/?#]+\S*\s*$/.exec(m.content);
  if (link) {
    const label = link[2] === 'post' ? '🔗 Shared a post' : '👤 Shared a profile';
    return link[1]!.trim() ? `${link[1]!.trim()} · ${label}` : label;
  }
  return m.content;
}

async function messageById(id: string) {
  const row = await one(`${MESSAGE_SELECT} WHERE m.id = $1`, [id]);
  return row ? serializeMessage(row) : null;
}

/** Shapes a set of conversation rows into summaries for `viewerId`. */
async function summarize(rows: any[], viewerId: string) {
  if (rows.length === 0) return [];
  const viewer = await one<{ show_activity: boolean }>('SELECT show_activity FROM users WHERE id = $1', [viewerId]);
  const { rows: people } = await query(
    `SELECT p.conversation_id, p.user_id, p.role, p.status, p.last_read_at,
            u.username, u.display_name, u.avatar_url, u.is_verified, u.show_activity, u.last_active_at, u.is_banned
       FROM conversation_participants p JOIN users u ON u.id = p.user_id
      WHERE p.conversation_id = ANY($1::uuid[])`,
    [rows.map((r) => r.id)],
  );
  const { rows: blocks } = await query(
    `SELECT blocker_id, blocked_id FROM user_blocks WHERE blocker_id = $1 OR blocked_id = $1`,
    [viewerId],
  );
  const blockedByMe = new Set(blocks.filter((b) => b.blocker_id === viewerId).map((b) => b.blocked_id));
  const blockedMe = new Set(blocks.filter((b) => b.blocked_id === viewerId).map((b) => b.blocker_id));

  return rows.map((c) => {
    const members = people.filter((p) => p.conversation_id === c.id);
    const others = members.filter((p) => p.user_id !== viewerId);
    const other = !c.is_group ? others[0] : undefined;
    return {
      id: c.id,
      isGroup: c.is_group,
      title: c.title,
      status: c.status as 'accepted' | 'pending',
      myRole: c.my_role as 'admin' | 'member',
      muted: !!c.muted,
      unreadCount: c.unread ?? 0,
      lastMessageAt: new Date(c.last_message_at).toISOString(),
      lastMessage: c.lm_id
        ? {
            id: c.lm_id,
            senderId: c.lm_sender,
            kind: c.lm_kind,
            preview: preview({ kind: c.lm_kind, content: c.lm_content ?? '', unsent: !!c.lm_unsent, removed: !!c.lm_removed, mediaCount: c.lm_media ?? 0, mediaType: c.lm_media_type }),
            createdAt: new Date(c.lm_at).toISOString(),
          }
        : null,
      memberCount: members.length,
      participants: others.map((p) => {
        const visible = viewer?.show_activity && p.show_activity; // Instagram rule: hide yours → can't see others'
        return {
          id: p.user_id,
          username: p.username,
          displayName: p.display_name,
          avatarUrl: p.avatar_url,
          isVerified: !!p.is_verified,
          role: p.role,
          online: visible ? isOnline(p.user_id) : null,
          lastActiveAt: visible ? p.last_active_at : null,
          // Read receipts only once they've accepted the chat
          lastReadAt: p.status === 'accepted' ? p.last_read_at : null,
          deactivated: !!p.is_banned,
        };
      }),
      blockedByMe: other ? blockedByMe.has(other.user_id) : false,
      blockedMe: other ? blockedMe.has(other.user_id) : false,
      pinned: !!c.pinned_at,
      pinnedMessage: c.pm_id
        ? {
            id: c.pm_id,
            senderName: c.pm_sender_name,
            preview: preview({ kind: c.pm_kind, content: c.pm_content ?? '', unsent: !!c.pm_unsent, removed: !!c.pm_removed, mediaCount: c.pm_media ?? 0 }),
          }
        : null,
    };
  });
}
export type ConversationDTO = Awaited<ReturnType<typeof summarize>>[number];

const CONVERSATION_SELECT = `
  SELECT c.*, p.status, p.role AS my_role, p.muted, p.last_read_at, p.cleared_at, p.pinned_at,
         pm.id AS pm_id, pm.content AS pm_content, pm.kind AS pm_kind, pm.unsent_at AS pm_unsent, pm.removed_by_mod AS pm_removed,
         jsonb_array_length(pm.media) AS pm_media, pmu.display_name AS pm_sender_name,
         lm.id AS lm_id, lm.content AS lm_content, lm.kind AS lm_kind, lm.sender_id AS lm_sender, lm.created_at AS lm_at,
         lm.unsent_at AS lm_unsent, lm.removed_by_mod AS lm_removed, jsonb_array_length(lm.media) AS lm_media, lm.media->0->>'type' AS lm_media_type,
         (SELECT count(*) FROM messages m
           WHERE m.conversation_id = c.id AND m.sender_id IS DISTINCT FROM p.user_id AND m.kind <> 'system'
             AND m.created_at > coalesce(p.last_read_at, '-infinity') AND m.created_at > coalesce(p.cleared_at, '-infinity')
             AND m.unsent_at IS NULL AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = p.user_id))::int AS unread
    FROM conversation_participants p
    JOIN conversations c ON c.id = p.conversation_id
    LEFT JOIN LATERAL (
      SELECT * FROM messages m WHERE m.conversation_id = c.id AND m.created_at > coalesce(p.cleared_at, '-infinity')
        AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = p.user_id)
      ORDER BY m.created_at DESC LIMIT 1
    ) lm ON true
    LEFT JOIN messages pm ON pm.id = c.pinned_message_id
    LEFT JOIN users pmu ON pmu.id = pm.sender_id`;

export const messageService = {
  async list(userId: string, folder: 'primary' | 'requests', q?: string) {
    const params: unknown[] = [userId, folder === 'requests' ? 'pending' : 'accepted'];
    let search = '';
    if (q) {
      params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`);
      search = `AND (c.title ILIKE $3 OR EXISTS (SELECT 1 FROM conversation_participants p3 JOIN users u3 ON u3.id = p3.user_id
                 WHERE p3.conversation_id = c.id AND p3.user_id <> $1 AND (u3.username ILIKE $3 OR u3.display_name ILIKE $3)))`;
    }
    const { rows } = await query(
      `${CONVERSATION_SELECT}
        WHERE p.user_id = $1 AND p.status = $2 AND p.hidden = false
          AND (lm.id IS NOT NULL OR c.created_by = $1)
          ${search}
          ${folder === 'requests' ? `AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = $1 AND b.blocked_id = c.created_by)` : ''}
        ORDER BY p.pinned_at DESC NULLS LAST, c.last_message_at DESC
        LIMIT 100`,
      params,
    );
    return summarize(rows, userId);
  },

  async get(conversationId: string, userId: string) {
    const { rows } = await query(`${CONVERSATION_SELECT} WHERE p.user_id = $1 AND c.id = $2`, [userId, conversationId]);
    if (!rows[0]) throw notFound('Conversation');
    return (await summarize(rows, userId))[0]!;
  },

  async unreadCounts(userId: string) {
    const row = await one<{ primary: number; requests: number }>(
      `SELECT
         count(*) FILTER (WHERE p.status = 'accepted' AND x.unread > 0 AND NOT p.muted)::int AS primary,
         count(*) FILTER (WHERE p.status = 'pending' AND x.has_msgs)::int AS requests
         FROM conversation_participants p
         JOIN LATERAL (
           SELECT count(*) FILTER (WHERE m.sender_id IS DISTINCT FROM p.user_id AND m.kind <> 'system' AND m.unsent_at IS NULL
                                    AND m.created_at > coalesce(p.last_read_at, '-infinity')
                                    AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = p.user_id)) AS unread,
                  count(*) > 0 AS has_msgs
             FROM messages m
            WHERE m.conversation_id = p.conversation_id AND m.created_at > coalesce(p.cleared_at, '-infinity')
         ) x ON true
        WHERE p.user_id = $1 AND p.hidden = false`,
      [userId],
    );
    return { primary: row?.primary ?? 0, requests: row?.requests ?? 0 };
  },

  /** One other user → (re)open the 1:1 chat. Several → new group. */
  async create(user: AuthUser, userIds: string[], title?: string) {
    assertEnabled();
    const others = [...new Set(userIds)].filter((id) => id !== user.id);
    if (others.length === 0) throw badRequest('NO_RECIPIENTS', 'Choose at least one person');
    if (others.length > MAX_GROUP - 1) throw badRequest('GROUP_TOO_BIG', `Groups can have up to ${MAX_GROUP} people`);

    const { rows: found } = await query<{ id: string; display_name: string }>(
      'SELECT id, display_name FROM users WHERE id = ANY($1::uuid[]) AND is_banned = false',
      [others],
    );
    if (found.length !== others.length) throw badRequest('INVALID_RECIPIENT', 'One or more people are unavailable');
    for (const id of others) {
      if (await isBlockedEitherWay(user.id, id)) throw forbidden('BLOCKED', "You can't message this person");
    }

    if (others.length === 1) {
      const other = others[0]!;
      const dmKey = [user.id, other].sort().join(':');
      const id = await tx(async (c) => {
        const existing = await c.query('SELECT id FROM conversations WHERE dm_key = $1', [dmKey]);
        if (existing.rows[0]) {
          await c.query('UPDATE conversation_participants SET hidden = false WHERE conversation_id = $1 AND user_id = $2', [existing.rows[0].id, user.id]);
          return existing.rows[0].id as string;
        }
        const { rows } = await c.query('INSERT INTO conversations (is_group, dm_key, created_by) VALUES (false, $1, $2) RETURNING id', [dmKey, user.id]);
        // Friends land in the inbox; everyone else goes to Message requests
        const theirStatus = (await areFriends(user.id, other, c)) ? 'accepted' : 'pending';
        await c.query(
          `INSERT INTO conversation_participants (conversation_id, user_id, status) VALUES ($1, $2, 'accepted'), ($1, $3, $4)`,
          [rows[0].id, user.id, other, theirStatus],
        );
        return rows[0].id as string;
      });
      return this.get(id, user.id);
    }

    const me = await one<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [user.id]);
    const cleanTitle = title ? cleanText(title).slice(0, 60) || null : null;
    const id = await tx(async (c) => {
      const { rows } = await c.query('INSERT INTO conversations (is_group, title, created_by) VALUES (true, $1, $2) RETURNING id', [cleanTitle, user.id]);
      const convId = rows[0].id as string;
      await c.query(`INSERT INTO conversation_participants (conversation_id, user_id, role, status) VALUES ($1, $2, 'admin', 'accepted')`, [convId, user.id]);
      for (const o of others) {
        const st = (await areFriends(user.id, o, c)) ? 'accepted' : 'pending';
        await c.query(`INSERT INTO conversation_participants (conversation_id, user_id, status) VALUES ($1, $2, $3)`, [convId, o, st]);
      }
      await systemMessage(c, convId, user.id, `${me?.display_name ?? 'Someone'} created the group`);
      return convId;
    });
    emit.users(others, 'dm:conversation', { conversationId: id });
    return this.get(id, user.id);
  },

  async messages(conversationId: string, userId: string, before?: string) {
    const conv = await membership(conversationId, userId);
    const params: unknown[] = [conversationId, conv.cleared_at, PAGE + 1, userId];
    let cursorSql = '';
    if (before) {
      const [ts, id] = Buffer.from(before, 'base64url').toString().split('|');
      if (ts && id && /^[0-9a-f-]{36}$/i.test(id) && !Number.isNaN(new Date(ts).getTime())) {
        params.push(new Date(ts), id);
        cursorSql = 'AND (m.created_at, m.id) < ($5, $6)';
      }
    }
    const { rows } = await query(
      `${MESSAGE_SELECT}
        WHERE m.conversation_id = $1 AND m.created_at > coalesce($2::timestamptz, '-infinity') ${cursorSql}
          AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = $4::uuid)
        ORDER BY m.created_at DESC, m.id DESC LIMIT $3`,
      params,
    );
    const hasMore = rows.length > PAGE;
    if (hasMore) rows.pop();
    const oldest = rows.at(-1);
    return {
      messages: rows.reverse().map(serializeMessage),
      hasMore,
      cursor: hasMore && oldest ? Buffer.from(`${new Date(oldest.created_at).toISOString()}|${oldest.id}`).toString('base64url') : null,
    };
  },

  async send(
    conversationId: string,
    user: AuthUser,
    input: { content?: string; mediaIds?: string[]; replyToId?: string | null; heart?: boolean; clientId?: string; voiceDuration?: number; storyRef?: Record<string, unknown> | null },
  ) {
    assertEnabled();
    const conv = await membership(conversationId, user.id);
    const members = await participantIds(conversationId);
    const others = members.filter((id) => id !== user.id);
    if (others.length === 0) throw badRequest('EMPTY_CHAT', 'Nobody else is in this chat');
    if (!conv.is_group && (await isBlockedEitherWay(user.id, others[0]!))) throw forbidden('BLOCKED', "You can't message this person");

    const content = input.heart ? '❤️' : cleanText(input.content ?? '');
    const mediaIds = input.heart ? [] : (input.mediaIds ?? []);
    if (!content && mediaIds.length === 0) throw badRequest('EMPTY_MESSAGE', 'Message is empty');
    if (content.length > 2000) throw badRequest('TOO_LONG', 'Messages are limited to 2000 characters');
    if (mediaIds.length > 10) throw badRequest('TOO_MANY_MEDIA', 'Max 10 attachments');

    if (input.replyToId) {
      const r = await one('SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2', [input.replyToId, conversationId]);
      if (!r) throw badRequest('BAD_REPLY', 'The message you replied to is gone');
    }
    const media = await mediaService.claimable(mediaIds, user.id, 'message');
    const kind = input.heart ? 'heart' : media.length ? 'media' : 'text';

    const id = await tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO messages (conversation_id, sender_id, kind, content, media, reply_to_id, story_ref) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          conversationId, user.id, kind, content,
          JSON.stringify(media.map((m) => ({
            id: m.id, url: m.url, type: m.kind, mime: m.mime,
            ...(m.kind === 'audio' && input.voiceDuration ? { duration: Math.min(Math.round(input.voiceDuration * 10) / 10, 3600) } : {}),
          }))),
          input.replyToId ?? null,
          input.storyRef ? JSON.stringify(input.storyRef) : null,
        ],
      );
      await mediaService.attachToMessage(c, media.map((m) => m.id), rows[0].id);
      await c.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [conversationId]);
      await c.query('UPDATE conversation_participants SET hidden = false WHERE conversation_id = $1', [conversationId]);
      // Replying to a request accepts it (Instagram behaviour)
      await c.query(`UPDATE conversation_participants SET last_read_at = now(), status = 'accepted' WHERE conversation_id = $1 AND user_id = $2`, [conversationId, user.id]);
      return rows[0].id as string;
    });

    const message = (await messageById(id))!;
    emit.users(members, 'dm:message', { conversationId, message, clientId: input.clientId ?? null });
    return message;
  },

  async markRead(conversationId: string, userId: string) {
    const conv = await membership(conversationId, userId);
    const { rows } = await query<{ last_read_at: Date }>(
      'UPDATE conversation_participants SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2 RETURNING last_read_at',
      [conversationId, userId],
    );
    // Requests stay "unseen" for the sender until accepted
    if (conv.status === 'accepted') {
      const others = (await participantIds(conversationId)).filter((id) => id !== userId);
      emit.users(others, 'dm:read', { conversationId, userId, lastReadAt: rows[0]!.last_read_at });
    }
    emit.user(userId, 'dm:unread', {});
  },

  async accept(conversationId: string, userId: string) {
    await membership(conversationId, userId);
    await query(`UPDATE conversation_participants SET status = 'accepted', hidden = false WHERE conversation_id = $1 AND user_id = $2`, [conversationId, userId]);
    await this.markRead(conversationId, userId);
    return this.get(conversationId, userId);
  },

  /** "Delete chat": hides it and clears history for me only. Also how a request is declined. */
  async removeForMe(conversationId: string, userId: string) {
    await membership(conversationId, userId);
    await query('UPDATE conversation_participants SET hidden = true, cleared_at = now() WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId]);
    emit.user(userId, 'dm:unread', {});
  },

  async update(conversationId: string, user: AuthUser, input: { title?: string | null; muted?: boolean }) {
    const conv = await membership(conversationId, user.id);
    if (input.muted !== undefined) {
      await query('UPDATE conversation_participants SET muted = $3 WHERE conversation_id = $1 AND user_id = $2', [conversationId, user.id, input.muted]);
    }
    if (input.title !== undefined) {
      if (!conv.is_group) throw badRequest('NOT_GROUP', 'Only groups can be renamed');
      const title = input.title ? cleanText(input.title).slice(0, 60) || null : null;
      const me = await one<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [user.id]);
      await tx(async (c) => {
        await c.query('UPDATE conversations SET title = $2 WHERE id = $1', [conversationId, title]);
        await systemMessage(c, conversationId, user.id, title ? `${me?.display_name} named the group "${title}"` : `${me?.display_name} removed the group name`);
      });
      emit.users(await participantIds(conversationId), 'dm:conversation', { conversationId });
    }
    return this.get(conversationId, user.id);
  },

  async addMembers(conversationId: string, user: AuthUser, userIds: string[]) {
    const conv = await membership(conversationId, user.id);
    if (!conv.is_group) throw badRequest('NOT_GROUP', 'Start a new group to add people');
    const current = await participantIds(conversationId);
    const add = [...new Set(userIds)].filter((id) => !current.includes(id));
    if (!add.length) return this.get(conversationId, user.id);
    if (current.length + add.length > MAX_GROUP) throw badRequest('GROUP_TOO_BIG', `Groups can have up to ${MAX_GROUP} people`);
    const { rows: found } = await query<{ id: string; display_name: string }>('SELECT id, display_name FROM users WHERE id = ANY($1::uuid[]) AND is_banned = false', [add]);
    if (found.length !== add.length) throw badRequest('INVALID_RECIPIENT', 'One or more people are unavailable');
    for (const id of add) if (await isBlockedEitherWay(user.id, id)) throw forbidden('BLOCKED', "You can't add someone you've blocked or who blocked you");
    const me = await one<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [user.id]);
    await tx(async (c) => {
      for (const id of add) {
        const st = (await areFriends(user.id, id, c)) ? 'accepted' : 'pending';
        await c.query(`INSERT INTO conversation_participants (conversation_id, user_id, status) VALUES ($1, $2, $3)`, [conversationId, id, st]);
      }
      await systemMessage(c, conversationId, user.id, `${me?.display_name} added ${found.map((f) => f.display_name).join(', ')}`);
    });
    emit.users([...current, ...add], 'dm:conversation', { conversationId });
    return this.get(conversationId, user.id);
  },

  async leave(conversationId: string, user: AuthUser) {
    const conv = await membership(conversationId, user.id);
    if (!conv.is_group) throw badRequest('NOT_GROUP', 'Use "Delete chat" for one-to-one conversations');
    const me = await one<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [user.id]);
    await tx(async (c) => {
      await c.query('DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2', [conversationId, user.id]);
      const left = await c.query(`SELECT user_id, role FROM conversation_participants WHERE conversation_id = $1 ORDER BY joined_at`, [conversationId]);
      if (left.rowCount === 0) {
        await archiveMessages(c, { conversationId }, 'conversation_deleted', user.id);
        await c.query('DELETE FROM conversations WHERE id = $1', [conversationId]);
        return;
      }
      if (!left.rows.some((r) => r.role === 'admin')) {
        await c.query(`UPDATE conversation_participants SET role = 'admin' WHERE conversation_id = $1 AND user_id = $2`, [conversationId, left.rows[0].user_id]);
      }
      await systemMessage(c, conversationId, user.id, `${me?.display_name} left the group`);
    });
    forgetMembership(conversationId, user.id);
    emit.users(await participantIds(conversationId), 'dm:conversation', { conversationId });
  },

  async react(messageId: string, userId: string, emoji: string | null) {
    const m = await one('SELECT id, conversation_id, kind, unsent_at, removed_by_mod FROM messages WHERE id = $1', [messageId]);
    if (!m) throw notFound('Message');
    await membership(m.conversation_id, userId);
    if (m.kind === 'system' || m.unsent_at || m.removed_by_mod) throw badRequest('CANT_REACT', "You can't react to this message");
    if (emoji) {
      await query(
        `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)
         ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji, created_at = now()`,
        [messageId, userId, emoji],
      );
    } else {
      await query('DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2', [messageId, userId]);
    }
    const msg = (await messageById(messageId))!;
    emit.users(await participantIds(m.conversation_id), 'dm:reaction', { conversationId: m.conversation_id, messageId, reactions: msg.reactions });
    return { reactions: msg.reactions };
  },

  /** Call history entry (written by the call signalling layer). */
  async recordCall(conversationId: string, callerId: string, call: { kind: 'audio' | 'video'; status: string; duration: number }) {
    const id = await tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO messages (conversation_id, sender_id, kind, content) VALUES ($1, $2, 'call', $3) RETURNING id`,
        [conversationId, callerId, JSON.stringify(call)],
      );
      await c.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [conversationId]);
      await c.query('UPDATE conversation_participants SET hidden = false WHERE conversation_id = $1', [conversationId]);
      await c.query('UPDATE conversation_participants SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2', [conversationId, callerId]);
      return rows[0].id as string;
    });
    const message = (await messageById(id))!;
    emit.users(await participantIds(conversationId), 'dm:message', { conversationId, message, clientId: null });
  },

  /** Can `userId` call in this conversation? Returns the other participant. 1:1 only. */
  async callPeer(conversationId: string, userId: string) {
    assertEnabled();
    const conv = await membership(conversationId, userId);
    if (conv.is_group) throw badRequest('GROUP_CALL', 'Group calls are not supported yet');
    if (conv.status === 'pending') throw forbidden('REQUEST_PENDING', 'Accept the message request first');
    const other = (await participantIds(conversationId)).find((id) => id !== userId);
    if (!other) throw badRequest('NO_PEER', 'Nobody to call');
    if (await isBlockedEitherWay(userId, other)) throw forbidden('BLOCKED', "You can't call this person");
    const peerRow = await one<{ status: string }>('SELECT status FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2', [conversationId, other]);
    if (peerRow?.status === 'pending') throw forbidden('REQUEST_PENDING', "They haven't accepted your message request yet");
    return other;
  },

  /** Edit your own message (Telegram allows 48h). */
  async edit(messageId: string, userId: string, content: string) {
    const m = await one('SELECT id, conversation_id, sender_id, kind, unsent_at, removed_by_mod, created_at, media FROM messages WHERE id = $1', [messageId]);
    if (!m) throw notFound('Message');
    if (m.sender_id !== userId || m.kind === 'system' || m.kind === 'heart' || m.kind === 'call') throw forbidden('NOT_OWNER', 'You can only edit your own messages');
    if (m.unsent_at || m.removed_by_mod) throw badRequest('GONE', 'This message was deleted');
    if (Date.now() - new Date(m.created_at).getTime() > 48 * 3600_000) throw badRequest('TOO_OLD', 'Messages can only be edited for 48 hours');
    const text = cleanText(content);
    if (!text && !(m.media?.length > 0)) throw badRequest('EMPTY_MESSAGE', 'Message is empty');
    if (text.length > 2000) throw badRequest('TOO_LONG', 'Messages are limited to 2000 characters');
    await tx(async (c) => {
      // Keep the earlier version (90-day retention, admin investigations only)
      await c.query('INSERT INTO message_edits (message_id, previous_content) SELECT id, content FROM messages WHERE id = $1 AND content <> $2', [messageId, text]);
      await c.query('UPDATE messages SET content = $2, edited_at = now() WHERE id = $1', [messageId, text]);
    });
    const msg = (await messageById(messageId))!;
    emit.users(await participantIds(m.conversation_id), 'dm:edit', { conversationId: m.conversation_id, message: msg });
    return msg;
  },

  /** Forward a message to one or more chats you're in (keeps "Forwarded from"). */
  async forward(messageId: string, user: AuthUser, conversationIds: string[]) {
    assertEnabled();
    const src = await one('SELECT * FROM messages WHERE id = $1', [messageId]);
    if (!src) throw notFound('Message');
    await membership(src.conversation_id, user.id);
    if (src.unsent_at || src.removed_by_mod || src.kind === 'system' || src.kind === 'call') throw badRequest('CANT_FORWARD', "This message can't be forwarded");
    const origin = src.forwarded_from_name
      ? { name: src.forwarded_from_name, id: src.forwarded_from_user }
      : await one<{ name: string; id: string }>('SELECT display_name AS name, id FROM users WHERE id = $1', [src.sender_id]);
    const sent: string[] = [];
    for (const cid of [...new Set(conversationIds)].slice(0, 20)) {
      const conv = await membership(cid, user.id);
      const members = await participantIds(cid);
      if (!conv.is_group && members.some((id) => id !== user.id) && (await isBlockedEitherWay(user.id, members.find((id) => id !== user.id)!))) continue;
      const id = await tx(async (c) => {
        const { rows } = await c.query(
          `INSERT INTO messages (conversation_id, sender_id, kind, content, media, forwarded_from_name, forwarded_from_user)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [cid, user.id, src.kind, src.content, JSON.stringify(src.media ?? []), origin?.name ?? 'Unknown', origin?.id ?? null],
        );
        await c.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [cid]);
        await c.query('UPDATE conversation_participants SET hidden = false WHERE conversation_id = $1', [cid]);
        await c.query(`UPDATE conversation_participants SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2`, [cid, user.id]);
        return rows[0].id as string;
      });
      const message = (await messageById(id))!;
      emit.users(members, 'dm:message', { conversationId: cid, message, clientId: null });
      sent.push(cid);
    }
    return { forwardedTo: sent };
  },

  /** Pin / unpin a message at the top of the chat (for everyone). */
  async pinMessage(conversationId: string, user: AuthUser, messageId: string | null) {
    await membership(conversationId, user.id);
    if (messageId) {
      const m = await one('SELECT id, unsent_at, kind FROM messages WHERE id = $1 AND conversation_id = $2', [messageId, conversationId]);
      if (!m || m.unsent_at || m.kind === 'system') throw badRequest('CANT_PIN', "This message can't be pinned");
    }
    const me = await one<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [user.id]);
    await tx(async (c) => {
      await c.query('UPDATE conversations SET pinned_message_id = $2 WHERE id = $1', [conversationId, messageId]);
      await systemMessage(c, conversationId, user.id, messageId ? `${me?.display_name} pinned a message` : `${me?.display_name} unpinned a message`);
    });
    emit.users(await participantIds(conversationId), 'dm:conversation', { conversationId });
    return this.get(conversationId, user.id);
  },

  /** Pin a chat to the top of your own list (max 5, like Telegram). */
  async pinChat(conversationId: string, userId: string, pinned: boolean) {
    await membership(conversationId, userId);
    if (pinned) {
      const n = await one<{ n: number }>('SELECT count(*)::int AS n FROM conversation_participants WHERE user_id = $1 AND pinned_at IS NOT NULL', [userId]);
      if ((n?.n ?? 0) >= 5) throw badRequest('PIN_LIMIT', 'You can pin up to 5 chats');
    }
    await query('UPDATE conversation_participants SET pinned_at = $3 WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId, pinned ? new Date() : null]);
    return this.get(conversationId, userId);
  },

  /** Search messages in one chat. */
  async search(conversationId: string, userId: string, q: string) {
    const conv = await membership(conversationId, userId);
    const { rows } = await query(
      `${MESSAGE_SELECT}
        WHERE m.conversation_id = $1 AND m.created_at > coalesce($2::timestamptz, '-infinity')
          AND m.unsent_at IS NULL AND m.removed_by_mod = false AND m.kind IN ('text', 'media')
          AND m.content ILIKE $3
          AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = $4::uuid)
        ORDER BY m.created_at DESC LIMIT 50`,
      [conversationId, conv.cleared_at, `%${q.replace(/[%_\\]/g, '\\$&')}%`, userId],
    );
    return rows.map(serializeMessage);
  },

  /** "Delete for me": hides one message only for this participant (theirs or anyone's). */
  async hideMessageForMe(messageId: string, userId: string) {
    const m = await one('SELECT id, conversation_id FROM messages WHERE id = $1', [messageId]);
    if (!m) throw notFound('Message');
    await membership(m.conversation_id, userId);
    await query('INSERT INTO message_hidden (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [messageId, userId]);
    emit.user(userId, 'dm:hidden', { conversationId: m.conversation_id, messageId });
  },

  /** Unsend for everyone: removes the content (and its files) for all participants. */
  async unsend(messageId: string, userId: string) {
    const m = await one('SELECT id, conversation_id, sender_id, kind, unsent_at FROM messages WHERE id = $1', [messageId]);
    if (!m) throw notFound('Message');
    if (m.sender_id !== userId || m.kind === 'system') throw forbidden('NOT_OWNER', 'You can only unsend your own messages');
    // Gone for everyone right away (reactions, hidden-markers cascade; replies lose the quote; a pinned
    // reference is cleared by FK). A copy and its files stay in the 90-day archive for admin investigations.
    await tx(async (c) => {
      await archiveMessages(c, { messageId }, 'unsent', userId);
      await c.query(`DELETE FROM reports WHERE target_type = 'message' AND target_id = $1`, [messageId]);
      await c.query('DELETE FROM messages WHERE id = $1', [messageId]);
    });
    emit.users(await participantIds(m.conversation_id), 'dm:deleted', { conversationId: m.conversation_id, messageId });
  },

  async report(messageId: string, user: AuthUser, reason: string, details?: string) {
    const m = await one('SELECT id, conversation_id, sender_id FROM messages WHERE id = $1', [messageId]);
    if (!m) throw notFound('Message');
    await membership(m.conversation_id, user.id);
    if (m.sender_id === user.id) throw badRequest('OWN_MESSAGE', "You can't report your own message");
    try {
      await query(
        `INSERT INTO reports (target_id, target_type, reporter_id, reason, details) VALUES ($1, 'message', $2, $3, $4)`,
        [messageId, user.id, reason, details ? cleanText(details) : null],
      );
    } catch (err: any) {
      if (err?.code === '23505') throw new AppError(409, 'ALREADY_REPORTED', 'You already reported this');
      throw err;
    }
    emit.staff('admin:report', { targetType: 'message', targetId: messageId, reason });
    return { reported: true };
  },

  /** Moderator removal of a reported message (keeps the row for the record). */
  async modRemove(messageId: string, actor: AuthUser, reason: string) {
    const m = await one('SELECT id, conversation_id, removed_by_mod FROM messages WHERE id = $1', [messageId]);
    if (!m) throw notFound('Message');
    if (m.removed_by_mod) return;
    await tx(async (c) => {
      await c.query('UPDATE messages SET removed_by_mod = true WHERE id = $1', [messageId]);
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'MESSAGE_REMOVE', targetId: messageId, targetType: 'message', metadata: { reason } }, c);
    });
    emit.users(await participantIds(m.conversation_id), 'dm:unsend', { conversationId: m.conversation_id, messageId, removed: true });
  },

  // ── blocks ──
  async listBlocks(userId: string) {
    const { rows } = await query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, b.created_at FROM user_blocks b JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = $1 ORDER BY b.created_at DESC`,
      [userId],
    );
    return rows.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url, blockedAt: r.created_at }));
  },

  async block(userId: string, targetId: string) {
    if (userId === targetId) throw badRequest('SELF', "You can't block yourself");
    const t = await one('SELECT id FROM users WHERE id = $1', [targetId]);
    if (!t) throw notFound('User');
    await query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, targetId]);
    await friendService.severOnBlock(userId, targetId);
    emit.users([userId, targetId], 'dm:block', { by: userId, target: targetId });
  },

  async unblock(userId: string, targetId: string) {
    await query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [userId, targetId]);
    emit.users([userId, targetId], 'dm:block', { by: userId, target: targetId, unblocked: true });
  },
};
