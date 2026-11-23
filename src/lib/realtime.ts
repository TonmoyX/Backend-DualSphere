import type { Server as HttpServer } from 'http';
import { Server, type Socket } from 'socket.io';
import { corsOrigins } from '../config/env.js';
import { one, query } from '../config/db.js';
import { verifyAccessToken } from './jwt.js';
import { ROLE_RANK, type Role } from '../types/index.js';
import { logger } from './logger.js';
import { randomUUID } from 'crypto';

let io: Server | null = null;

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  header?.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

// ── Presence (who is online) ─────────────────────────────────────
const connections = new Map<string, number>(); // userId → open sockets

export function isOnline(userId: string) {
  return (connections.get(userId) ?? 0) > 0;
}

/** Users who share a conversation with `userId` (they're the only ones who see presence). */
async function chatPartners(userId: string): Promise<string[]> {
  const { rows } = await query<{ user_id: string }>(
    `SELECT DISTINCT p2.user_id FROM conversation_participants p1
       JOIN conversation_participants p2 ON p2.conversation_id = p1.conversation_id
      WHERE p1.user_id = $1 AND p2.user_id <> $1`,
    [userId],
  );
  return rows.map((r) => r.user_id);
}

async function broadcastPresence(userId: string, online: boolean) {
  try {
    const u = await one<{ show_activity: boolean; last_active_at: Date | null }>(
      'SELECT show_activity, last_active_at FROM users WHERE id = $1',
      [userId],
    );
    if (!u?.show_activity) return; // activity status turned off → never broadcast
    for (const partner of await chatPartners(userId)) {
      io?.to(`user:${partner}`).emit('user:presence', { userId, online, lastActiveAt: u.last_active_at });
    }
  } catch (err) {
    logger.error({ err }, 'presence broadcast failed');
  }
}

// ── Conversation membership cache (for typing events) ────────────
const memberCache = new Map<string, { ok: boolean; at: number }>();
async function isMember(conversationId: string, userId: string): Promise<boolean> {
  const key = `${conversationId}:${userId}`;
  const hit = memberCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.ok;
  const row = await one('SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId]).catch(() => undefined);
  memberCache.set(key, { ok: !!row, at: Date.now() });
  return !!row;
}
export function forgetMembership(conversationId: string, userId: string) {
  memberCache.delete(`${conversationId}:${userId}`);
}

async function participantIds(conversationId: string): Promise<string[]> {
  const { rows } = await query<{ user_id: string }>('SELECT user_id FROM conversation_participants WHERE conversation_id = $1', [conversationId]);
  return rows.map((r) => r.user_id);
}

/**
 * Rooms:
 *  feed          — everyone: new posts, counters, removals, settings changes
 *  post:<id>     — viewers of a post: new comments
 *  user:<id>     — private: notifications, DMs, presence, session revocation
 *  staff         — moderators/admins: new reports, live stats
 */
export function initRealtime(server: HttpServer) {
  io = new Server(server, {
    cors: { origin: corsOrigins, credentials: true },
    path: '/socket.io',
  });

  io.use(async (socket, next) => {
    const cookies = parseCookies(socket.handshake.headers.cookie);
    const token = cookies['ds_access'] ?? (socket.handshake.auth?.token as string | undefined);
    if (token) {
      const v = verifyAccessToken(token);
      if (v.ok) {
        const row = await one<{ is_banned: boolean }>(
          `SELECT u.is_banned FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
          [v.claims.sid],
        ).catch(() => undefined);
        if (row && !row.is_banned) socket.data.user = { id: v.claims.sub, role: v.claims.role };
      }
    }
    next(); // anonymous viewers may still watch the public feed
  });

  io.on('connection', (socket: Socket) => {
    socket.join('feed');
    const u = socket.data.user as { id: string; role: Role } | undefined;
    if (u) {
      socket.join(`user:${u.id}`);
      if (ROLE_RANK[u.role] >= ROLE_RANK.moderator) socket.join('staff');
      const n = (connections.get(u.id) ?? 0) + 1;
      connections.set(u.id, n);
      if (n === 1) void broadcastPresence(u.id, true);
      void joinOwnAnonRooms(socket, u.id);
    }

    // Live comments for a post. Community posts are checked first, so private-community comments never reach outsiders.
    socket.on('post:watch', async (postId: unknown) => {
      if (typeof postId !== 'string' || !/^[0-9a-f-]{36}$/i.test(postId)) return;
      try {
        const { canWatchPost } = await import('../services/community.service.js'); // lazy: avoids an import cycle
        if (await canWatchPost(postId, await socketViewer(socket))) socket.join(`post:${postId}`);
      } catch { /* best-effort */ }
    });
    // Live posts for a community page — members only for private / invite-only communities
    socket.on('community:watch', async (communityId: unknown) => {
      if (typeof communityId !== 'string' || !/^[0-9a-f-]{36}$/i.test(communityId)) return;
      try {
        const { canWatchCommunity } = await import('../services/community.service.js');
        if (await canWatchCommunity(communityId, await socketViewer(socket))) socket.join(`community:${communityId}`);
      } catch { /* best-effort */ }
    });
    socket.on('community:unwatch', (communityId: unknown) => {
      if (typeof communityId === 'string') socket.leave(`community:${communityId}`);
    });
    socket.on('post:unwatch', (postId: unknown) => {
      if (typeof postId === 'string') socket.leave(`post:${postId}`);
    });

    // Typing indicator — relayed only to other participants of that conversation
    socket.on('dm:typing', async (p: unknown) => {
      if (!u || !p || typeof p !== 'object') return;
      const { conversationId, typing } = p as { conversationId?: unknown; typing?: unknown };
      if (typeof conversationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(conversationId)) return;
      if (!(await isMember(conversationId, u.id))) return;
      for (const id of await participantIds(conversationId)) {
        if (id !== u.id) io?.to(`user:${id}`).emit('dm:typing', { conversationId, userId: u.id, typing: !!typing });
      }
    });

    if (u) registerCallHandlers(socket, u.id);

    broadcastStaffPresence();
    socket.on('disconnect', async () => {
      broadcastStaffPresence();
      if (!u) return;
      const n = (connections.get(u.id) ?? 1) - 1;
      if (n > 0) return void connections.set(u.id, n);
      connections.delete(u.id);
      endCallsFor(u.id, 'ended'); // last tab closed → hang up
      await query('UPDATE users SET last_active_at = now() WHERE id = $1', [u.id]).catch(() => {});
      void broadcastPresence(u.id, false);
    });
  });

  logger.info('Socket.io realtime ready');
  return io;
}

let presenceTimer: NodeJS.Timeout | null = null;
function broadcastStaffPresence() {
  if (presenceTimer) return;
  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    if (!io) return;
    emit.staff('presence', { online: io.engine.clientsCount });
  }, 1000);
}

/**
 * The signed-in user behind a socket, in the AuthUser shape the access checks expect.
 * Re-read from the database on each check so role/permission/ban changes apply immediately.
 */
async function socketViewer(socket: Socket): Promise<import('../types/index.js').AuthUser | undefined> {
  const u = socket.data.user as { id: string } | undefined;
  if (!u) return undefined;
  const row = await one<any>('SELECT id, role, username, is_verified, mfa_enabled, created_at, permissions, is_banned FROM users WHERE id = $1', [u.id]);
  if (!row || row.is_banned) return undefined;
  const { effectivePermissions } = await import('./permissions.js');
  return {
    id: row.id, sessionId: '', role: row.role, username: row.username, isVerified: !!row.is_verified, mfaEnabled: !!row.mfa_enabled,
    createdAt: row.created_at, permissions: effectivePermissions(row.role, row.permissions),
  };
}

export function onlineCount() {
  return io?.engine.clientsCount ?? 0;
}

export const emit = {
  feed: (event: string, payload: unknown) => io?.to('feed').emit(event, payload),
  post: (postId: string, event: string, payload: unknown) => io?.to(`post:${postId}`).emit(event, payload),
  community: (communityId: string, event: string, payload: unknown) => io?.to(`community:${communityId}`).emit(event, payload),
  user: (userId: string, event: string, payload: unknown) => io?.to(`user:${userId}`).emit(event, payload),
  users: (userIds: string[], event: string, payload: unknown) => {
    if (io && userIds.length) io.to(userIds.map((id) => `user:${id}`)).emit(event, payload);
  },
  staff: (event: string, payload: unknown) => io?.to('staff').emit(event, payload),
  all: (event: string, payload: unknown) => io?.emit(event, payload),
  /** Live alerts for the hidden author of an anonymous post (room membership is in memory only). */
  anonPost: (postId: string, event: string, payload: unknown) => io?.to(`anonpost:${postId}`).emit(event, payload),
  /**
   * Session ended (ban, role change, revoke, delete): tell the user's tabs, then drop their sockets so
   * nothing keeps the old identity/role — e.g. a demoted moderator staying in the staff room.
   */
  revoke: (userId: string, payload: unknown) => {
    io?.to(`user:${userId}`).emit('session:revoked', payload);
    setTimeout(() => io?.in(`user:${userId}`).disconnectSockets(true), 500).unref();
  },
};

/** Put a user's open tabs in the room of an anonymous post they just created (ownership already known). */
export function joinAnonPostRoom(userId: string, postId: string) {
  io?.in(`user:${userId}`).socketsJoin(`anonpost:${postId}`);
}

/**
 * On connect: find the signed-in user's recent anonymous posts by recomputing HMAC(postId:userId)
 * and join their rooms. Nothing is written anywhere — it lives only as long as the socket.
 */
async function joinOwnAnonRooms(socket: Socket, userId: string) {
  try {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM posts WHERE visibility = 'anonymous' AND deleted_at IS NULL AND created_at > now() - interval '180 days'
        ORDER BY created_at DESC LIMIT 3000`,
    );
    if (!rows.length) return;
    const { identityService } = await import('../services/identity.service.js'); // lazy: avoids an import cycle
    const mine = await identityService.ownedBy(rows.map((r) => r.id), userId);
    for (const id of mine) socket.join(`anonpost:${id}`);
  } catch {
    /* live anon alerts are best-effort; the notifications list still shows everything */
  }
}


// ═══════════════════════════════════════════════════════════════
// 1:1 voice/video calls — WebRTC signalling relay.
// Media flows peer-to-peer; the server only relays SDP/ICE between the two
// participants of a call and writes the call record into the chat.
// ═══════════════════════════════════════════════════════════════
interface Call {
  id: string;
  conversationId: string;
  callerId: string;
  calleeId: string;
  kind: 'audio' | 'video';
  acceptedAt?: number;
  timer?: NodeJS.Timeout;
}
const calls = new Map<string, Call>();
const RING_TIMEOUT_MS = 45_000;

const inCall = (userId: string) => [...calls.values()].some((c) => c.callerId === userId || c.calleeId === userId);
const peerOf = (c: Call, userId: string) => (c.callerId === userId ? c.calleeId : c.callerId);
const isParty = (c: Call | undefined, userId: string): c is Call => !!c && (c.callerId === userId || c.calleeId === userId);

async function finishCall(c: Call, status: 'ended' | 'missed' | 'declined' | 'busy') {
  if (!calls.has(c.id)) return;
  calls.delete(c.id);
  if (c.timer) clearTimeout(c.timer);
  const duration = c.acceptedAt ? Math.round((Date.now() - c.acceptedAt) / 1000) : 0;
  const final = status === 'ended' && !c.acceptedAt ? 'missed' : status;
  emit.users([c.callerId, c.calleeId], 'call:ended', { callId: c.id, reason: final, duration });
  try {
    const { messageService } = await import('../services/message.service.js');
    await messageService.recordCall(c.conversationId, c.callerId, { kind: c.kind, status: final, duration });
  } catch (err) {
    logger.error({ err }, 'failed to record call');
  }
}

function endCallsFor(userId: string, status: 'ended') {
  for (const c of calls.values()) if (isParty(c, userId)) void finishCall(c, status);
}

function registerCallHandlers(socket: Socket, userId: string) {
  socket.on('call:invite', async (p: unknown, ack?: (r: unknown) => void) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const { conversationId, kind } = (p ?? {}) as { conversationId?: string; kind?: string };
      if (typeof conversationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(conversationId)) return reply({ error: 'Invalid conversation' });
      const callKind = kind === 'video' ? 'video' : 'audio';
      const { messageService } = await import('../services/message.service.js');
      const peer = await messageService.callPeer(conversationId, userId);
      if (inCall(userId)) return reply({ error: "You're already in a call" });

      const call: Call = { id: randomUUID(), conversationId, callerId: userId, calleeId: peer, kind: callKind };
      calls.set(call.id, call);
      if (inCall(peer) && [...calls.values()].filter((c) => isParty(c, peer)).length > 1) {
        reply({ callId: call.id });
        return void finishCall(call, 'busy');
      }
      if (!isOnline(peer)) {
        // Nobody to ring — log a missed call straight away
        reply({ callId: call.id });
        return void finishCall(call, 'missed');
      }
      const me = await one<{ username: string; display_name: string; avatar_url: string | null }>('SELECT username, display_name, avatar_url FROM users WHERE id = $1', [userId]);
      call.timer = setTimeout(() => void finishCall(call, 'missed'), RING_TIMEOUT_MS);
      emit.user(peer, 'call:incoming', {
        callId: call.id, conversationId, kind: callKind,
        from: { id: userId, username: me?.username, displayName: me?.display_name, avatarUrl: me?.avatar_url },
      });
      reply({ callId: call.id });
    } catch (err) {
      reply({ error: err instanceof Error ? err.message : 'Call failed' });
    }
  });

  socket.on('call:accept', (p: unknown) => {
    const c = calls.get(String((p as { callId?: string })?.callId));
    if (!isParty(c, userId) || c.calleeId !== userId || c.acceptedAt) return;
    c.acceptedAt = Date.now();
    if (c.timer) clearTimeout(c.timer);
    emit.user(c.callerId, 'call:accepted', { callId: c.id });
    emit.user(c.calleeId, 'call:handled', { callId: c.id, by: socket.id }); // stop ringing on the callee's other tabs
  });

  socket.on('call:reject', (p: unknown) => {
    const c = calls.get(String((p as { callId?: string })?.callId));
    if (isParty(c, userId) && c.calleeId === userId && !c.acceptedAt) void finishCall(c, 'declined');
  });

  socket.on('call:end', (p: unknown) => {
    const c = calls.get(String((p as { callId?: string })?.callId));
    if (isParty(c, userId)) void finishCall(c, 'ended');
  });

  // SDP offers/answers, ICE candidates, and in-call state (mute/camera/upgrade)
  socket.on('call:signal', (p: unknown) => {
    const { callId, data } = (p ?? {}) as { callId?: string; data?: unknown };
    const c = calls.get(String(callId));
    if (!isParty(c, userId) || !data || JSON.stringify(data).length > 64_000) return;
    emit.user(peerOf(c, userId), 'call:signal', { callId: c.id, data });
  });
}
