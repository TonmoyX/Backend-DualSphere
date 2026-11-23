// Business pages: the identity every ad runs under. Staff verify a business before its ads can be delivered.
import { one, query, tx } from '../config/db.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { cleanText } from '../lib/text.js';
import type { AuthUser } from '../types/index.js';
import { auditService } from './audit.service.js';
import { mediaService } from './media.service.js';
import { notificationService } from './notification.service.js';
import { syncCampaignsWithPage } from './ads.service.js';
import { acct, purgeTransactions } from './ledger.service.js';

export type BusinessRole = 'owner' | 'admin' | 'analyst';
export type Badge = 'none' | 'verified' | 'official' | 'partner' | 'trusted';
export const BADGES: Badge[] = ['none', 'verified', 'official', 'partner', 'trusted'];
const RANK: Record<BusinessRole, number> = { analyst: 1, admin: 2, owner: 3 };
const MAX_OWNED = 3;
const RESERVED = new Set(['admin', 'api', 'dualsphere', 'official', 'support', 'staff', 'ads', 'business', 'new', 'create', 'settings']);
export const CATEGORIES = ['retail', 'food', 'fashion', 'electronics', 'education', 'services', 'health_beauty', 'travel', 'real_estate', 'entertainment', 'nonprofit', 'other'] as const;

const out = (b: any, role?: BusinessRole | null) => ({
  id: b.id, slug: b.slug, name: b.name, description: b.description, category: b.category, website: b.website, logoUrl: b.logo_url ?? null,
  verification: b.verification, badge: (b.badge ?? 'none') as Badge, verificationNote: role ? b.verification_note : undefined, isSuspended: !!b.is_suspended,
  suspendedReason: role ? b.suspended_reason : undefined, createdAt: b.created_at, role: role ?? null,
});

/** Throws unless the user has at least `min` role on the business. Returns the business row + role. */
export async function requireBusinessRole(businessId: string, user: AuthUser, min: BusinessRole) {
  const r = await one(
    `SELECT b.*, m.role FROM business_pages b JOIN business_members m ON m.business_id = b.id WHERE b.id = $1 AND m.user_id = $2 AND b.deleted_at IS NULL`,
    [businessId, user.id],
  );
  if (!r) throw notFound('Business');
  if (RANK[r.role as BusinessRole] < RANK[min]) throw forbidden('BUSINESS_FORBIDDEN', min === 'owner' ? 'Only the business owner can do this' : 'You need admin access to this business');
  return r;
}

function cleanUrl(u: string | undefined | null) {
  if (!u) return null;
  try {
    const url = new URL(u.trim());
    if (url.protocol !== 'https:') throw new Error();
    return url.toString().slice(0, 300);
  } catch {
    throw badRequest('BAD_URL', 'Use a full https:// link');
  }
}

export const businessService = {
  async create(user: AuthUser, input: { name: string; slug: string; description?: string; category: string; website?: string }) {
    if (!user.isVerified) throw forbidden('EMAIL_NOT_VERIFIED', 'Verify your email first');
    const slug = input.slug.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(slug) || slug.includes('--') || RESERVED.has(slug)) throw badRequest('BAD_SLUG', 'Pick a different link name');
    const owned = await one<{ n: number }>(`SELECT count(*)::int AS n FROM business_members m JOIN business_pages b ON b.id = m.business_id WHERE m.user_id = $1 AND m.role = 'owner' AND b.deleted_at IS NULL`, [user.id]);
    if ((owned?.n ?? 0) >= MAX_OWNED) throw forbidden('BUSINESS_LIMIT', `You can own up to ${MAX_OWNED} business pages`);
    try {
      const id = await tx(async (c) => {
        const { rows } = await c.query(
          `INSERT INTO business_pages (slug, name, description, category, website, owner_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [slug, cleanText(input.name).slice(0, 60), cleanText(input.description ?? '').slice(0, 1000), input.category, cleanUrl(input.website), user.id],
        );
        await c.query(`INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'owner')`, [rows[0].id, user.id]);
        return rows[0].id as string;
      });
      return this.get(id, user);
    } catch (err: any) {
      if (err?.code === '23505') throw conflict('SLUG_TAKEN', 'That link name is taken');
      throw err;
    }
  },

  async mine(user: AuthUser) {
    const { rows } = await query(
      `SELECT b.*, m.role, COALESCE(bal.available_micro, 0) AS available_micro, bal.currency AS bal_currency
         FROM business_members m JOIN business_pages b ON b.id = m.business_id
         LEFT JOIN business_ad_balances bal ON bal.business_id = b.id
        WHERE m.user_id = $1 AND b.deleted_at IS NULL ORDER BY m.added_at`,
      [user.id],
    );
    return { businesses: rows.map((b) => ({ ...out(b, b.role), adBalanceMinor: Math.floor(Number(b.available_micro) / 1_000_000), currency: b.bal_currency ?? null })) };
  },

  async myAdBalances(user: AuthUser) {
    const { businesses } = await this.mine(user);
    return businesses.filter((b) => b.role !== 'analyst').map((b) => ({ businessId: b.id, name: b.name, slug: b.slug, balanceMinor: b.adBalanceMinor, currency: b.currency }));
  },

  /** Public page (by id or slug). Members also see moderation notes and the ad balance. */
  async get(idOrSlug: string, viewer?: AuthUser) {
    const isId = /^[0-9a-f-]{36}$/i.test(idOrSlug);
    const b = await one(`SELECT * FROM business_pages WHERE ${isId ? 'id = $1' : 'slug = lower($1)'} AND deleted_at IS NULL`, [idOrSlug]);
    if (!b) throw notFound('Business');
    const m = viewer ? await one('SELECT role FROM business_members WHERE business_id = $1 AND user_id = $2', [b.id, viewer.id]) : null;
    if (b.is_suspended && !m) throw notFound('Business');
    const role = (m?.role ?? null) as BusinessRole | null;
    const extra: Record<string, unknown> = {};
    if (role) {
      const bal = await one('SELECT available_micro, currency FROM business_ad_balances WHERE business_id = $1', [b.id]);
      const { rows: members } = await query(
        `SELECT u.id, u.username, u.display_name, u.avatar_url, m.role FROM business_members m JOIN users u ON u.id = m.user_id WHERE m.business_id = $1 ORDER BY m.added_at`,
        [b.id],
      );
      extra.adBalanceMinor = Math.floor(Number(bal?.available_micro ?? 0) / 1_000_000);
      extra.currency = bal?.currency ?? null;
      extra.members = members.map((x) => ({ id: x.id, username: x.username, displayName: x.display_name, avatarUrl: x.avatar_url, role: x.role }));
    }
    return { business: { ...out(b, role), ...extra } };
  },

  async update(businessId: string, user: AuthUser, input: { name?: string; description?: string; category?: string; website?: string | null; logoMediaId?: string | null }) {
    const b = await requireBusinessRole(businessId, user, 'admin');
    const sets: string[] = [];
    const params: unknown[] = [businessId];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (input.name !== undefined) set('name', cleanText(input.name).slice(0, 60));
    if (input.description !== undefined) set('description', cleanText(input.description).slice(0, 1000));
    if (input.category !== undefined) set('category', input.category);
    if (input.website !== undefined) set('website', cleanUrl(input.website));
    if (input.logoMediaId !== undefined) set('logo_url', input.logoMediaId ? await mediaService.useForAd(user.id, input.logoMediaId) : null);
    // Changing the name of a verified business sends it back to verification (prevents bait-and-switch)
    if (input.name !== undefined && b.verification === 'verified' && cleanText(input.name) !== b.name) sets.push(`verification = 'pending'`);
    if (sets.length) await query(`UPDATE business_pages SET ${sets.join(', ')} WHERE id = $1`, params);
    if (input.logoMediaId !== undefined) await mediaService.releaseIfUnused(b.logo_url);
    return this.get(businessId, user);
  },

  async requestVerification(businessId: string, user: AuthUser) {
    const b = await requireBusinessRole(businessId, user, 'owner');
    if (b.verification === 'verified') throw conflict('ALREADY_VERIFIED', 'Already verified');
    if (!b.website && b.description.length < 20) throw badRequest('MORE_INFO', 'Add a website or a description (20+ characters) so staff can verify you');
    await query(`UPDATE business_pages SET verification = 'pending', verification_note = NULL WHERE id = $1`, [businessId]);
    return this.get(businessId, user);
  },

  /**
   * Owner deletes the page: it disappears, its campaigns end, nothing more is spent. The remaining ad balance stays
   * on record (not lost) so DualSphere support can refund it.
   */
  async remove(businessId: string, user: AuthUser, confirmName: string) {
    const b = await requireBusinessRole(businessId, user, 'owner');
    if (cleanText(confirmName) !== b.name) throw badRequest('CONFIRM_MISMATCH', 'Type the business name exactly to confirm');
    await tx(async (c) => {
      await c.query(`UPDATE ad_campaigns SET status = 'completed', pause_reason = 'Business page deleted', updated_at = now() WHERE business_id = $1 AND status <> 'completed'`, [businessId]);
      await c.query('UPDATE business_pages SET deleted_at = now() WHERE id = $1', [businessId]);
      await auditService.log({ actorId: user.id, actorRole: user.role, action: 'BUSINESS_DELETE_BY_OWNER', targetId: businessId, targetType: 'business', metadata: { slug: b.slug } }, c);
    });
    return { ok: true };
  },

  async addMember(businessId: string, user: AuthUser, username: string, role: 'admin' | 'analyst') {
    await requireBusinessRole(businessId, user, 'owner');
    const u = await one('SELECT id FROM users WHERE lower(username) = lower($1) AND is_banned = false', [username]);
    if (!u) throw notFound('User');
    await query(
      `INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (business_id, user_id) DO UPDATE SET role = EXCLUDED.role WHERE business_members.role <> 'owner'`,
      [businessId, u.id, role],
    );
    return this.get(businessId, user);
  },

  async removeMember(businessId: string, user: AuthUser, memberId: string) {
    await requireBusinessRole(businessId, user, 'owner');
    if (memberId === user.id) throw badRequest('SELF', "The owner can't be removed");
    await query(`DELETE FROM business_members WHERE business_id = $1 AND user_id = $2 AND role <> 'owner'`, [businessId, memberId]);
    return this.get(businessId, user);
  },

  // ── Staff (Admin Panel → Advertisers) ──
  async staffList(status: string | undefined, q: string | undefined) {
    const params: unknown[] = [];
    const where: string[] = [];
    if (status === 'deleted') where.push('b.deleted_at IS NOT NULL');
    else {
      where.push('b.deleted_at IS NULL');
      if (status && status !== 'all') {
        if (status === 'suspended') where.push('b.is_suspended');
        else { params.push(status); where.push(`b.verification = $${params.length}`); }
      }
    }
    if (q) { params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`); where.push(`(b.name ILIKE $${params.length} OR b.slug ILIKE $${params.length})`); }
    const { rows } = await query(
      `SELECT b.*, u.username AS owner_username, COALESCE(bal.available_micro, 0) AS available_micro, bal.currency AS bal_currency,
              (SELECT count(*) FROM ad_campaigns c WHERE c.business_id = b.id)::int AS campaigns,
              (SELECT COALESCE(sum(spent_micro), 0) FROM ad_campaigns c WHERE c.business_id = b.id)::bigint AS spent_micro
         FROM business_pages b LEFT JOIN users u ON u.id = b.owner_id LEFT JOIN business_ad_balances bal ON bal.business_id = b.id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY (b.verification = 'pending') DESC, b.created_at DESC LIMIT 200`,
      params,
    );
    return { items: rows.map((b) => ({
      ...out(b, 'owner'), ownerUsername: b.owner_username, approvedAds: b.approved_ads, campaigns: b.campaigns, deletedAt: b.deleted_at,
      balanceMinor: Math.floor(Number(b.available_micro) / 1_000_000), spentMinor: Math.floor(Number(b.spent_micro) / 1_000_000), currency: b.bal_currency,
    })) };
  },

  /** Staff set the page's approval status and badge. Approving starts its waiting campaigns; anything else pauses them. */
  async staffSetStatus(actor: AuthUser, businessId: string, input: { verification: 'unverified' | 'pending' | 'verified' | 'rejected'; badge: Badge; note?: string }) {
    const why = cleanText(input.note ?? '').slice(0, 300);
    if (input.verification === 'rejected' && why.length < 3) throw badRequest('REASON_REQUIRED', 'Tell the business what to fix');
    const before = await one('SELECT verification, badge, owner_id, name FROM business_pages WHERE id = $1 AND deleted_at IS NULL', [businessId]);
    if (!before) throw notFound('Business');
    await tx(async (c) => {
      await c.query('UPDATE business_pages SET verification = $2, badge = $3, verification_note = $4 WHERE id = $1', [businessId, input.verification, input.badge, why || null]);
      await syncCampaignsWithPage(c, businessId);
      await auditService.log({
        actorId: actor.id, actorRole: actor.role, action: 'BUSINESS_STATUS', targetId: businessId, targetType: 'business',
        metadata: { from: { verification: before.verification, badge: before.badge }, to: { verification: input.verification, badge: input.badge }, note: why || null },
      }, c);
    });
    if (before.owner_id && before.verification !== input.verification) {
      const msg = input.verification === 'verified' ? `${before.name} is approved — your ads are running`
        : input.verification === 'rejected' ? `${before.name} wasn't approved: ${why}`
        : `${before.name} is no longer approved to run ads${why ? `: ${why}` : ''}`;
      await notificationService.create({ userId: before.owner_id, type: 'system', message: msg }).catch(() => {});
    }
    return { ok: true };
  },

  async staffVerify(actor: AuthUser, businessId: string, approve: boolean, note?: string) {
    const why = cleanText(note ?? '').slice(0, 300);
    if (!approve && why.length < 3) throw badRequest('REASON_REQUIRED', 'Tell the business what to fix');
    const b = await tx(async (c) => {
      const r = await c.query(
        `UPDATE business_pages SET verification = $2, verification_note = $3, badge = CASE WHEN $2 = 'verified' AND badge = 'none' THEN 'verified' ELSE badge END WHERE id = $1 RETURNING owner_id, name`,
        [businessId, approve ? 'verified' : 'rejected', why || null],
      );
      if (!r.rowCount) throw notFound('Business');
      await syncCampaignsWithPage(c, businessId);
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: approve ? 'BUSINESS_VERIFY' : 'BUSINESS_VERIFY_REJECT', targetId: businessId, targetType: 'business', metadata: { note: why || null } }, c);
      return r.rows[0];
    });
    if (b.owner_id) await notificationService.create({ userId: b.owner_id, type: 'system', message: approve ? `${b.name} is verified — your ads can run now` : `${b.name} wasn't verified: ${why}` }).catch(() => {});
    return { ok: true };
  },

  /**
   * Admin: erase a business page and everything it owns — campaigns, ads, stats, AI jobs, balance, its payments and
   * their ledger records. Not a refund: money charged at Stripe / SSLCommerz stays there (refund first if needed).
   */
  async staffPurge(actor: AuthUser, businessId: string, confirmName: string) {
    const media: string[] = [];
    const b = await tx(async (c) => {
      const { rows } = await c.query('SELECT id, name, slug, logo_url, owner_id FROM business_pages WHERE id = $1 FOR UPDATE', [businessId]);
      const x = rows[0];
      if (!x) throw notFound('Business');
      if (cleanText(confirmName) !== x.name) throw badRequest('CONFIRM_MISMATCH', 'Type the business name exactly to confirm');
      const { rows: pays } = await c.query<{ id: string; amount_minor: string; status: string }>('SELECT id, amount_minor, status FROM payments WHERE business_id = $1', [businessId]);
      const payIds = pays.map((p) => p.id);
      const { rows: txs } = await c.query<{ id: string }>('SELECT id FROM ledger_transactions WHERE reference_id = $1 OR reference_id = ANY($2::uuid[])', [businessId, payIds]);
      await purgeTransactions(c, txs.map((t) => t.id), 'Ledger records of this page are still in use');
      const left = await c.query('SELECT 1 FROM ledger_entries WHERE account = $1 LIMIT 1', [acct.adBalance(businessId)]);
      if (left.rowCount) throw conflict('LEDGER_LEFT', 'Some money records of this page could not be erased');
      const { rows: creatives } = await c.query<{ media: { url: string }[] }>('SELECT cr.media FROM ad_creatives cr JOIN ad_campaigns k ON k.id = cr.campaign_id WHERE k.business_id = $1', [businessId]);
      for (const cr of creatives) for (const m of cr.media ?? []) media.push(m.url);
      if (x.logo_url) media.push(x.logo_url);
      await c.query(`DELETE FROM jobs WHERE queue = 'ad-studio' AND payload->>'jobId' IN (SELECT id::text FROM ad_studio_jobs WHERE business_id = $1)`, [businessId]);
      await c.query('DELETE FROM payment_webhook_events WHERE payment_id = ANY($1::uuid[])', [payIds]);
      await c.query('DELETE FROM payments WHERE id = ANY($1::uuid[])', [payIds]);
      await c.query('DELETE FROM business_pages WHERE id = $1', [businessId]); // campaigns, ads, stats, balance, members, AI jobs cascade
      await auditService.log({
        actorId: actor.id, actorRole: actor.role, action: 'BUSINESS_PURGE', targetId: businessId, targetType: 'business',
        metadata: { name: x.name, slug: x.slug, payments: pays.length, paidMinor: pays.filter((p) => p.status === 'succeeded').reduce((s, p) => s + Number(p.amount_minor), 0), ledgerTxs: txs.length },
      }, c);
      return x;
    });
    for (const url of media) await mediaService.releaseIfUnused(url).catch(() => {});
    return { ok: true, name: b.name };
  },

  /** Suspending a business stops all its campaigns at once. */
  async staffSuspend(actor: AuthUser, businessId: string, suspended: boolean, reason?: string) {
    const why = cleanText(reason ?? '').slice(0, 300);
    if (suspended && why.length < 3) throw badRequest('REASON_REQUIRED', 'Give a reason');
    await tx(async (c) => {
      const r = await c.query('UPDATE business_pages SET is_suspended = $2, suspended_reason = $3 WHERE id = $1', [businessId, suspended, suspended ? why : null]);
      if (!r.rowCount) throw notFound('Business');
      await syncCampaignsWithPage(c, businessId); // suspend → pause live campaigns; unsuspend → resume them
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: suspended ? 'BUSINESS_SUSPEND' : 'BUSINESS_UNSUSPEND', targetId: businessId, targetType: 'business', metadata: { reason: why || null } }, c);
    });
    return { ok: true };
  },
};
