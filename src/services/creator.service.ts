// Creators: profile, membership tiers, memberships and the creator dashboard.
import { one, query } from '../config/db.js';
import { env } from '../config/env.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { assertAmount, type Currency } from '../lib/money.js';
import { cleanText } from '../lib/text.js';
import type { AuthUser } from '../types/index.js';
import { userBalances } from './ledger.service.js';

const MAX_TIERS = 5;
export const PRICE_MIN_MINOR = 100; // $1
export const PRICE_MAX_MINOR = 1_000_000; // $10,000

function assertPrice(minor: number) {
  assertAmount(minor, 'Price');
  if (minor < PRICE_MIN_MINOR || minor > PRICE_MAX_MINOR) throw badRequest('BAD_PRICE', 'Price is outside the allowed range');
}

const tierOut = (t: any) => ({
  id: t.id, name: t.name, description: t.description, benefits: t.benefits ?? [], priceMinor: Number(t.price_minor), currency: t.currency as Currency,
  isActive: !!t.is_active, memberCount: t.member_count !== undefined ? Number(t.member_count) : undefined,
});

export const creatorService = {
  /** Identity accounts with a verified email can become creators. */
  async become(user: AuthUser, input: { tagline?: string }) {
    if (!user.isVerified) throw forbidden('EMAIL_NOT_VERIFIED', 'Verify your email before turning on creator tools');
    const ageDays = (Date.now() - new Date(user.createdAt).getTime()) / 86_400_000;
    if (ageDays < 1) throw forbidden('ACCOUNT_TOO_NEW', 'Creator tools unlock 24 hours after sign-up');
    await query(
      `INSERT INTO creator_profiles (user_id, tagline) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET is_active = true, tagline = EXCLUDED.tagline`,
      [user.id, cleanText(input.tagline ?? '').slice(0, 140)],
    );
    return this.me(user);
  },

  async updateProfile(user: AuthUser, input: { tagline?: string; tipsEnabled?: boolean; isActive?: boolean }) {
    const r = await query(
      `UPDATE creator_profiles SET tagline = COALESCE($2, tagline), tips_enabled = COALESCE($3, tips_enabled), is_active = COALESCE($4, is_active)
        WHERE user_id = $1`,
      [user.id, input.tagline !== undefined ? cleanText(input.tagline).slice(0, 140) : null, input.tipsEnabled ?? null, input.isActive ?? null],
    );
    if (!r.rowCount) throw notFound('Creator profile');
    return this.me(user);
  },

  async me(user: AuthUser) {
    const cp = await one('SELECT * FROM creator_profiles WHERE user_id = $1', [user.id]);
    if (!cp) return { creator: null, tiers: [] };
    const { rows } = await query(
      `SELECT t.*, (SELECT count(*) FROM memberships m WHERE m.tier_id = t.id AND m.status IN ('active','canceled')) AS member_count
         FROM membership_tiers t WHERE t.creator_id = $1 ORDER BY t.position, t.created_at`,
      [user.id],
    );
    return {
      creator: { isActive: !!cp.is_active, tagline: cp.tagline, tipsEnabled: !!cp.tips_enabled, kycStatus: cp.kyc_status, currency: env.DEFAULT_CURRENCY },
      tiers: rows.map(tierOut),
    };
  },

  /** Public creator info on a profile, plus the viewer's own membership. */
  async publicInfo(username: string, viewer?: AuthUser) {
    const u = await one('SELECT id FROM users WHERE lower(username) = lower($1) AND is_banned = false', [username]);
    if (!u) throw notFound('User');
    const cp = await one('SELECT * FROM creator_profiles WHERE user_id = $1 AND is_active', [u.id]);
    if (!cp) return { isCreator: false, tiers: [], tipsEnabled: false, membership: null };
    const { rows } = await query('SELECT * FROM membership_tiers WHERE creator_id = $1 AND is_active ORDER BY position, price_minor', [u.id]);
    const m = viewer
      ? await one(`SELECT m.id, m.tier_id, m.status, m.current_period_end FROM memberships m WHERE m.creator_id = $1 AND m.member_id = $2 AND m.status IN ('active','canceled')`, [u.id, viewer.id])
      : null;
    return {
      isCreator: true,
      tagline: cp.tagline,
      tipsEnabled: !!cp.tips_enabled,
      currency: env.DEFAULT_CURRENCY,
      tiers: rows.map(tierOut),
      membership: m ? { id: m.id, tierId: m.tier_id, status: m.status, currentPeriodEnd: m.current_period_end } : null,
    };
  },

  async createTier(user: AuthUser, input: { name: string; description?: string; benefits?: string[]; priceMinor: number }) {
    const cp = await one('SELECT 1 FROM creator_profiles WHERE user_id = $1 AND is_active', [user.id]);
    if (!cp) throw forbidden('NOT_CREATOR', 'Turn on creator tools first');
    assertPrice(input.priceMinor);
    const n = await one<{ n: number }>('SELECT count(*)::int AS n FROM membership_tiers WHERE creator_id = $1 AND is_active', [user.id]);
    if ((n?.n ?? 0) >= MAX_TIERS) throw badRequest('TIER_LIMIT', `Up to ${MAX_TIERS} active tiers`);
    const name = cleanText(input.name).slice(0, 40);
    if (name.length < 2) throw badRequest('BAD_NAME', 'Give the tier a name');
    await query(
      `INSERT INTO membership_tiers (creator_id, name, description, benefits, price_minor, currency, position) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [user.id, name, cleanText(input.description ?? '').slice(0, 500), (input.benefits ?? []).map((b) => cleanText(b).slice(0, 80)).filter(Boolean).slice(0, 8), input.priceMinor, env.DEFAULT_CURRENCY, n?.n ?? 0],
    );
    return this.me(user);
  },

  /** Price changes apply to new payments and renewals; current periods are already paid for. */
  async updateTier(user: AuthUser, tierId: string, input: { name?: string; description?: string; benefits?: string[]; priceMinor?: number; isActive?: boolean }) {
    if (input.priceMinor !== undefined) assertPrice(input.priceMinor);
    const r = await query(
      `UPDATE membership_tiers SET name = COALESCE($3, name), description = COALESCE($4, description), benefits = COALESCE($5, benefits),
              price_minor = COALESCE($6, price_minor), is_active = COALESCE($7, is_active)
        WHERE id = $1 AND creator_id = $2`,
      [tierId, user.id,
        input.name !== undefined ? cleanText(input.name).slice(0, 40) : null,
        input.description !== undefined ? cleanText(input.description).slice(0, 500) : null,
        input.benefits !== undefined ? input.benefits.map((b) => cleanText(b).slice(0, 80)).filter(Boolean).slice(0, 8) : null,
        input.priceMinor ?? null, input.isActive ?? null],
    );
    if (!r.rowCount) throw notFound('Tier');
    return this.me(user);
  },

  /** Cancel: no more renewals; access lasts until the paid period ends. */
  async cancelMembership(user: AuthUser, creatorId: string) {
    const r = await query(
      `UPDATE memberships SET status = 'canceled', canceled_at = now() WHERE creator_id = $1 AND member_id = $2 AND status = 'active' RETURNING current_period_end`,
      [creatorId, user.id],
    );
    if (!r.rowCount) throw notFound('Membership');
    return { status: 'canceled', currentPeriodEnd: r.rows[0].current_period_end };
  },

  async myMemberships(user: AuthUser) {
    const { rows } = await query(
      `SELECT m.id, m.status, m.current_period_end, t.name AS tier_name, t.price_minor, t.currency, u.id AS creator_id, u.username, u.display_name, u.avatar_url
         FROM memberships m JOIN membership_tiers t ON t.id = m.tier_id JOIN users u ON u.id = m.creator_id
        WHERE m.member_id = $1 AND m.status IN ('active','canceled') ORDER BY m.current_period_end`,
      [user.id],
    );
    return { memberships: rows.map((r) => ({
      id: r.id, status: r.status, currentPeriodEnd: r.current_period_end, tierName: r.tier_name, priceMinor: Number(r.price_minor), currency: r.currency,
      creator: { id: r.creator_id, username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url },
    })) };
  },

  async dashboard(user: AuthUser) {
    const cp = await one('SELECT 1 FROM creator_profiles WHERE user_id = $1', [user.id]);
    if (!cp) throw forbidden('NOT_CREATOR', 'Turn on creator tools first');
    const { rows: daily } = await query(
      `WITH days AS (SELECT generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') AS d)
       SELECT to_char(d, 'YYYY-MM-DD') AS date,
              COALESCE((SELECT sum(amount_minor - fee_minor) FROM payments p WHERE p.creator_id = $1 AND p.status = 'succeeded' AND p.purpose = 'tip' AND date_trunc('day', p.succeeded_at) = d), 0)::bigint AS tips,
              COALESCE((SELECT sum(amount_minor - fee_minor) FROM payments p WHERE p.creator_id = $1 AND p.status = 'succeeded' AND p.purpose = 'membership' AND date_trunc('day', p.succeeded_at) = d), 0)::bigint AS memberships,
              COALESCE((SELECT sum(amount_minor - fee_minor) FROM payments p WHERE p.creator_id = $1 AND p.status = 'succeeded' AND p.purpose = 'unlock' AND date_trunc('day', p.succeeded_at) = d), 0)::bigint AS unlocks
         FROM days ORDER BY d`,
      [user.id],
    );
    const totals = await one(
      `SELECT (SELECT count(*) FROM memberships WHERE creator_id = $1 AND status IN ('active','canceled'))::int AS members,
              (SELECT count(*) FROM memberships WHERE creator_id = $1 AND status = 'canceled')::int AS canceling,
              (SELECT count(*) FROM memberships WHERE creator_id = $1 AND status = 'expired' AND current_period_end > now() - interval '30 days')::int AS churned_30d,
              (SELECT count(*) FROM payments WHERE creator_id = $1 AND status = 'succeeded' AND purpose = 'tip')::int AS tips,
              COALESCE((SELECT sum(amount_minor - fee_minor) FROM payments WHERE creator_id = $1 AND status = 'succeeded'), 0)::bigint AS lifetime_net`,
      [user.id],
    );
    // Tip leaderboard shows identity tippers only (tips always come from signed-in identity accounts)
    const { rows: topTippers } = await query(
      `SELECT u.username, u.display_name, u.avatar_url, sum(p.amount_minor)::bigint AS total, p.currency
         FROM payments p JOIN users u ON u.id = p.payer_id
        WHERE p.creator_id = $1 AND p.status = 'succeeded' AND p.purpose = 'tip'
        GROUP BY u.username, u.display_name, u.avatar_url, p.currency ORDER BY total DESC LIMIT 10`,
      [user.id],
    );
    const { rows: topPosts } = await query(
      `SELECT p.post_id, left(po.content, 80) AS snippet, sum(p.amount_minor - p.fee_minor)::bigint AS earned, count(*)::int AS payments, p.currency
         FROM payments p JOIN posts po ON po.id = p.post_id
        WHERE p.creator_id = $1 AND p.status = 'succeeded' AND p.post_id IS NOT NULL
        GROUP BY p.post_id, po.content, p.currency ORDER BY earned DESC LIMIT 5`,
      [user.id],
    );
    return {
      balances: await userBalances(user.id),
      daily: daily.map((d) => ({ date: d.date, tips: Number(d.tips), memberships: Number(d.memberships), unlocks: Number(d.unlocks) })),
      totals: { members: totals.members, canceling: totals.canceling, churned30d: totals.churned_30d, tips: totals.tips, lifetimeNet: Number(totals.lifetime_net) },
      topTippers: topTippers.map((t) => ({ username: t.username, displayName: t.display_name, avatarUrl: t.avatar_url, total: Number(t.total), currency: t.currency })),
      topPosts: topPosts.map((t) => ({ postId: t.post_id, snippet: t.snippet, earned: Number(t.earned), payments: t.payments, currency: t.currency })),
      currency: env.DEFAULT_CURRENCY,
    };
  },
};

export async function isActiveCreator(userId: string) {
  return !!(await one('SELECT 1 FROM creator_profiles WHERE user_id = $1 AND is_active', [userId]));
}

