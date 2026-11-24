import { one, query } from '../config/db.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { emit } from '../lib/realtime.js';
import { cleanText } from '../lib/text.js';
import type { AuthUser } from '../types/index.js';
import type { SuspendedUser } from '../middleware/auth.middleware.js';
import { auditService } from './audit.service.js';
import { identityService } from './identity.service.js';
import { moderationService } from './moderation.service.js';

/** After a rejected review, how long before the person may ask again. */
const APPEAL_COOLDOWN_DAYS = 7;

const publicAppeal = (r: any) =>
  r
    ? {
        id: r.id as string,
        message: r.message as string,
        status: r.status as 'pending' | 'approved' | 'rejected',
        response: (r.response ?? null) as string | null,
        createdAt: new Date(r.created_at).toISOString(),
        reviewedAt: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null,
      }
    : null;

export const suspensionService = {
  /** What the suspension page shows. */
  async status(s: SuspendedUser) {
    const u = await one('SELECT username, display_name, avatar_url FROM users WHERE id = $1', [s.id]);
    const last = await one('SELECT * FROM ban_appeals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [s.id]);
    const nextAppealAt =
      last?.status === 'rejected' ? new Date(new Date(last.reviewed_at ?? last.created_at).getTime() + APPEAL_COOLDOWN_DAYS * 86_400_000) : null;
    return {
      suspended: true as const,
      user: { username: u?.username ?? s.username, displayName: u?.display_name ?? s.username, avatarUrl: u?.avatar_url ?? null },
      reason: s.reason,
      until: s.until ? s.until.toISOString() : null, // null = permanent
      appeal: publicAppeal(last),
      canAppeal: !last || (last.status === 'rejected' && nextAppealAt!.getTime() <= Date.now()) || last.status === 'approved',
      nextAppealAt: nextAppealAt && nextAppealAt.getTime() > Date.now() ? nextAppealAt.toISOString() : null,
    };
  },

  async appeal(s: SuspendedUser, raw: string) {
    const message = cleanText(raw);
    if (message.length < 10) throw badRequest('TOO_SHORT', 'Tell us a little more (at least 10 characters)');
    const st = await this.status(s);
    if (st.appeal?.status === 'pending') throw new AppError(409, 'APPEAL_PENDING', 'Your request is already being reviewed');
    if (!st.canAppeal) throw new AppError(429, 'APPEAL_COOLDOWN', 'You can request another review later');
    try {
      await query('INSERT INTO ban_appeals (user_id, message, ban_reason, banned_until) VALUES ($1, $2, $3, $4)', [s.id, message, s.reason, s.until]);
    } catch (err: any) {
      if (err?.code === '23505') throw new AppError(409, 'APPEAL_PENDING', 'Your request is already being reviewed');
      throw err;
    }
    emit.staff('admin:appeal', { username: s.username });
    return this.status(s);
  },

  /**
   * "Download your information": profile + every post you made — identity AND your anonymous ones
   * (found with the HMAC ownership check, the same way the private Anonymous tab works). Only ever sent to you.
   */
  async export(userId: string) {
    const u = await one(
      'SELECT username, display_name, email, bio, avatar_url, cover_url, created_at, is_banned, ban_reason, banned_until FROM users WHERE id = $1',
      [userId],
    );
    if (!u) throw notFound('User');

    const cols = `id, content, media, visibility, post_type, is_share, shared_post_id, community_id, access, price_minor, currency,
                  likes_count, comments_count, shares_count, views_count, is_removed, removed_reason, created_at, edited_at`;
    const { rows: identity } = await query(`SELECT ${cols} FROM posts WHERE author_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`, [userId]);

    // Anonymous posts carry no author: found with the HMAC ownership check
    const anonymous = await identityService.anonymousPostsOf(userId, cols);

    const all = [...identity, ...anonymous].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
    const ids = all.map((p) => p.id);
    const { rows: tags } = ids.length
      ? await query<{ post_id: string; username: string }>(
          'SELECT t.post_id, u.username FROM post_tags t JOIN users u ON u.id = t.user_id WHERE t.post_id = ANY($1::uuid[])',
          [ids],
        )
      : { rows: [] as { post_id: string; username: string }[] };

    return {
      exportedAt: new Date().toISOString(),
      account: {
        username: u.username,
        displayName: u.display_name,
        email: u.email,
        bio: u.bio ?? '',
        avatarUrl: u.avatar_url ?? null,
        coverUrl: u.cover_url ?? null,
        joinedAt: new Date(u.created_at).toISOString(),
        suspended: !!u.is_banned,
        suspensionReason: u.is_banned ? (u.ban_reason ?? null) : null,
        suspendedUntil: u.is_banned && u.banned_until ? new Date(u.banned_until).toISOString() : null,
      },
      summary: { totalPosts: all.length, identityPosts: identity.length, anonymousPosts: anonymous.length },
      posts: all.map((p) => ({
        id: p.id,
        postedAs: p.visibility === 'anonymous' ? 'anonymous' : 'you',
        type: p.is_share ? 'share' : (p.post_type ?? 'regular'),
        text: p.content,
        media: (Array.isArray(p.media) ? p.media : []).map((m: any) => ({ type: m.type, url: m.url })),
        sharedPostId: p.shared_post_id ?? null,
        inCommunity: !!p.community_id,
        access: p.access ?? 'public',
        price: p.price_minor != null ? { amountMinor: Number(p.price_minor), currency: p.currency } : null,
        taggedPeople: tags.filter((t) => t.post_id === p.id).map((t) => `@${t.username}`),
        likes: p.likes_count,
        comments: p.comments_count,
        shares: p.shares_count,
        views: p.views_count ?? 0,
        removedByModerators: !!p.is_removed,
        removalReason: p.is_removed ? (p.removed_reason ?? null) : null,
        postedAt: new Date(p.created_at).toISOString(),
        editedAt: p.edited_at ? new Date(p.edited_at).toISOString() : null,
      })),
    };
  },

  // ── staff ──
  async list(status: string | undefined, page: number, limit: number) {
    const st = ['pending', 'approved', 'rejected'].includes(status ?? '') ? status : status === 'all' ? null : 'pending';
    const { rows } = await query(
      `SELECT a.*, u.username, u.display_name, u.avatar_url, u.is_banned, u.ban_reason AS current_reason, u.banned_until AS current_until,
              u.created_at AS joined_at, u.post_count, u.abuse_score, r.username AS reviewer_username, count(*) OVER() AS total
         FROM ban_appeals a JOIN users u ON u.id = a.user_id LEFT JOIN users r ON r.id = a.reviewed_by
        WHERE ($1::text IS NULL OR a.status = $1)
        ORDER BY (a.status = 'pending') DESC, a.created_at DESC LIMIT $2 OFFSET $3`,
      [st, limit, (page - 1) * limit],
    );
    return {
      total: rows[0] ? Number(rows[0].total) : 0,
      items: rows.map((r) => ({
        ...publicAppeal(r)!,
        banReason: r.ban_reason ?? null,
        bannedUntil: r.banned_until ? new Date(r.banned_until).toISOString() : null,
        stillBanned: !!r.is_banned,
        reviewer: r.reviewer_username ?? null,
        user: {
          id: r.user_id, username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url ?? null,
          joinedAt: new Date(r.joined_at).toISOString(), postCount: r.post_count ?? 0, abuseScore: r.abuse_score ?? 0,
        },
      })),
    };
  },

  async decide(appealId: string, actor: AuthUser, decision: 'approve' | 'reject', response?: string) {
    const a = await one(`SELECT id, user_id, status FROM ban_appeals WHERE id = $1`, [appealId]);
    if (!a) throw notFound('Appeal');
    if (a.status !== 'pending') throw new AppError(409, 'ALREADY_DECIDED', 'This request was already reviewed');
    const note = response ? cleanText(response) : null;
    if (decision === 'approve') {
      // Re-checks rank; also marks this (pending) appeal approved
      await query('UPDATE ban_appeals SET response = $2 WHERE id = $1', [appealId, note || 'Your account has been restored.']);
      await moderationService.unbanUser(a.user_id, actor);
    } else {
      await moderationService.assertOutranks(actor, a.user_id);
      await query(
        `UPDATE ban_appeals SET status = 'rejected', response = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1`,
        [appealId, note || 'After review, the suspension stays in place.', actor.id],
      );
    }
    await auditService.log({
      actorId: actor.id, actorRole: actor.role, action: decision === 'approve' ? 'APPEAL_APPROVE' : 'APPEAL_REJECT',
      targetId: a.user_id, targetType: 'user', metadata: { appealId },
    });
    return { ok: true };
  },
};
