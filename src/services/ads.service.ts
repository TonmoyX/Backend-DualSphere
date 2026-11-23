// ═══════════════════════════════════════════════════════════════
// Ads Manager: campaigns → ad sets → creatives, review, delivery, events, billing.
//  • Ads always run from a VERIFIED business page in Identity mode, labelled "Sponsored" — never anonymous.
//  • No per-ad approval: a business page applies once, staff approve the PAGE, and its funded campaigns run.
//    Banned categories (weapons, drugs, gambling, adult, tobacco/alcohol, money promises, health claims) are refused
//    at creation. Staff can still take any live ad down (Admin Panel → Live ads).
//  • Budget is enforced atomically per impression: a conditional UPDATE on the prepaid balance (CHECK >= 0)
//    and on the campaign's daily/total spend. Runaway spend is impossible.
//  • Viewers are identified only by a keyed daily hash; no raw user ids or IPs are stored with ad events.
// ═══════════════════════════════════════════════════════════════
import { createHmac } from 'node:crypto';
import type { PoolClient } from 'pg';
import { one, query, tx } from '../config/db.js';
import { env } from '../config/env.js';
import { safeEqual } from '../lib/crypto.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { assertAmount, type Currency, formatMoney } from '../lib/money.js';
import { cleanText } from '../lib/text.js';
import type { AuthUser } from '../types/index.js';
import { auditService } from './audit.service.js';
import { requireBusinessRole } from './business.service.js';
import { acct, book } from './ledger.service.js';
import { mediaService } from './media.service.js';
import { notificationService } from './notification.service.js';
import { getSettings } from './settings.service.js';

export type Cta = 'learn_more' | 'shop_now' | 'message' | 'sign_up' | 'book_now';
export interface Targeting { geo?: string[]; ageMin?: number; ageMax?: number; interests?: string[]; genders?: ('male' | 'female')[] }
export type Objective = 'awareness' | 'traffic' | 'engagement' | 'messages' | 'leads' | 'sales';
export type Placement = 'feed' | 'sidebar' | 'reels';
export const PLACEMENTS: Placement[] = ['feed', 'sidebar', 'reels'];
/** Ad set = who sees it, where, and how you pay (like Facebook's ad set level). */
export interface AdSetInput {
  name?: string; targeting?: Targeting; placements?: Placement[];
  billingEvent?: 'impression' | 'click'; bidStrategy?: 'lowest_cost' | 'bid_cap';
  bidCpmMinor?: number; bidCpcMinor?: number; frequencyCap?: number;
}
export interface CreativeInput { headline: string; body?: string; cta: Cta; linkUrl?: string | null; mediaIds?: string[]; hashtags?: string[]; language?: string; claimsConfirmed?: boolean; label?: string }

const MIN_BID_CPM_MINOR = 50;        // $0.50 per 1000 impressions
const DEFAULT_BID_CPM_MINOR = 200;    // $2.00 per 1000 impressions (lowest-cost price)
const MIN_BID_CPC_MINOR = 5;          // $0.05 per click
const DEFAULT_BID_CPC_MINOR = 20;     // $0.20 per click (lowest-cost price)

// ── Ad policy ──
const BANNED: { flag: string; re: RegExp }[] = [
  { flag: 'weapons', re: /\b(gun|guns|pistol|rifle|ammo|ammunition|firearm|explosive|grenade)\b|বন্দুক|অস্ত্র/i },
  { flag: 'drugs', re: /\b(cocaine|heroin|meth|weed|marijuana|cannabis|yaba|lsd|mdma|opioid)\b|ইয়াবা|গাঁজা/i },
  { flag: 'gambling', re: /\b(casino|betting|bet now|jackpot|lottery|poker|slot machine|1xbet)\b|জুয়া|বাজি/i },
  { flag: 'adult', re: /\b(porn|xxx|escort|nude|sex chat|adult content)\b/i },
  { flag: 'tobacco_alcohol', re: /\b(cigarette|vape|e-cig|tobacco|beer|whisky|vodka|alcohol)\b|সিগারেট|মদ/i },
  { flag: 'financial_promise', re: /\b(guaranteed (returns?|profit|income)|double your money|risk[- ]free investment|get rich|crypto signals?)\b/i },
  { flag: 'health_claim', re: /\b(cures?|miracle|100% (safe|effective)|lose \d+ ?kg in|no side effects)\b/i },
];
const CLAIM = /(\d+(?:[.,]\d+)?\s?(?:%|percent|h\b|hours?|days?|years?|mah|gb|tb|kg|km|৳|tk|taka|\$|x\b)|#1|number one|best in (bangladesh|the world)|cheapest)/gi;

export function policyCheck(text: string) {
  const flags = BANNED.filter((b) => b.re.test(text)).map((b) => b.flag);
  for (const w of getSettings().moderation.bannedWords ?? []) if (w && text.toLowerCase().includes(String(w).toLowerCase())) flags.push('banned_word');
  const claims = [...new Set((text.match(CLAIM) ?? []).map((c) => c.trim().toLowerCase()))].slice(0, 10);
  return { flags: [...new Set(flags)], claims };
}

function cleanLink(u: string | null | undefined) {
  if (!u) return null;
  let url: URL;
  try { url = new URL(u.trim()); } catch { throw badRequest('BAD_URL', 'Use a full https:// link'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw badRequest('BAD_URL', 'Use a plain https:// link');
  return url.toString().slice(0, 500);
}

function cleanTargeting(t: Targeting | undefined): Targeting {
  const list = (a: string[] | undefined, n: number) => [...new Set((a ?? []).map((x) => cleanText(x).toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, n);
  const ageMin = Math.max(13, Math.min(100, Math.round(t?.ageMin ?? 18)));
  const ageMax = Math.max(ageMin, Math.min(100, Math.round(t?.ageMax ?? 65)));
  const genders = [...new Set((t?.genders ?? []).filter((g) => g === 'male' || g === 'female'))];
  return { geo: list(t?.geo, 10), ageMin, ageMax, interests: list(t?.interests, 15), genders: genders.length === 2 ? [] : genders };
}

/** Validate an ad set and turn it into column values. Lowest cost uses DualSphere's standard price; bid cap uses yours. */
export function adSetValues(input: AdSetInput, dailyBudgetMinor: number) {
  const placements = [...new Set((input.placements?.length ? input.placements : PLACEMENTS).filter((p) => PLACEMENTS.includes(p)))];
  if (!placements.length) throw badRequest('PLACEMENTS', 'Pick at least one placement');
  const billing = input.billingEvent === 'click' ? 'click' : 'impression';
  const strategy = input.bidStrategy === 'bid_cap' ? 'bid_cap' : 'lowest_cost';
  let cpm = DEFAULT_BID_CPM_MINOR;
  let cpc: number | null = billing === 'click' ? DEFAULT_BID_CPC_MINOR : null;
  if (strategy === 'bid_cap') {
    if (billing === 'impression') {
      cpm = input.bidCpmMinor ?? DEFAULT_BID_CPM_MINOR;
      if (!Number.isSafeInteger(cpm) || cpm < MIN_BID_CPM_MINOR || cpm > dailyBudgetMinor) throw badRequest('BAD_BID', `Price per 1000 views must be at least ${formatMoney(MIN_BID_CPM_MINOR, env.DEFAULT_CURRENCY)} and at most your daily budget`);
    } else {
      cpc = input.bidCpcMinor ?? DEFAULT_BID_CPC_MINOR;
      if (!Number.isSafeInteger(cpc) || cpc < MIN_BID_CPC_MINOR || cpc > dailyBudgetMinor) throw badRequest('BAD_BID', `Price per click must be at least ${formatMoney(MIN_BID_CPC_MINOR, env.DEFAULT_CURRENCY)} and at most your daily budget`);
    }
  } else if (input.bidCpmMinor && billing === 'impression') {
    // Legacy callers (AI studio) pass a CPM bid
    cpm = Math.max(MIN_BID_CPM_MINOR, Math.min(dailyBudgetMinor, Math.round(input.bidCpmMinor)));
  }
  const cap = Math.max(1, Math.min(20, Math.round(input.frequencyCap ?? 3)));
  return {
    name: cleanText(input.name ?? '').slice(0, 80) || 'Ad set', targeting: cleanTargeting(input.targeting), placements,
    billingEvent: billing, bidStrategy: strategy, bidCpmMinor: cpm, bidCpcMinor: cpc, frequencyCap: cap,
  };
}

export async function insertAdSet(c: PoolClient, campaignId: string, v: ReturnType<typeof adSetValues>) {
  const { rows } = await c.query(
    `INSERT INTO ad_sets (campaign_id, name, targeting, bid_cpm_minor, placements, billing_event, bid_strategy, bid_cpc_minor, frequency_cap)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [campaignId, v.name, JSON.stringify(v.targeting), v.bidCpmMinor, v.placements, v.billingEvent, v.bidStrategy, v.bidCpcMinor, v.frequencyCap],
  );
  return rows[0].id as string;
}

export const adSetOut = (s: any) => ({
  id: s.id, name: s.name, status: s.status, targeting: s.targeting, placements: s.placements ?? PLACEMENTS,
  billingEvent: s.billing_event ?? 'impression', bidStrategy: s.bid_strategy ?? 'lowest_cost',
  bidCpmMinor: Number(s.bid_cpm_minor), bidCpcMinor: s.bid_cpc_minor != null ? Number(s.bid_cpc_minor) : null, frequencyCap: s.frequency_cap ?? 3,
});

/** Coarse age bucket for reports (never the exact age). */
export function ageBucket(birth: Date | string | null | undefined) {
  if (!birth) return 'unknown';
  const age = Math.floor((Date.now() - new Date(birth).getTime()) / (365.25 * 86_400_000));
  if (age < 18) return '13-17';
  if (age < 25) return '18-24';
  if (age < 35) return '25-34';
  if (age < 45) return '35-44';
  if (age < 55) return '45-54';
  if (age < 65) return '55-64';
  return '65+';
}

export const creativeOut = (c: any) => ({
  id: c.id, adSetId: c.ad_set_id, createdAt: c.created_at, label: c.variant_label, headline: c.headline, body: c.body, cta: c.cta, linkUrl: c.link_url, media: c.media ?? [], hashtags: c.hashtags ?? [],
  language: c.language, source: c.source, status: c.status, reviewReason: c.review_reason, policyFlags: c.policy_flags ?? [],
  claimsToVerify: c.claims_to_verify ?? [], claimsConfirmed: !!c.claims_confirmed, impressions: Number(c.impressions), clicks: Number(c.clicks),
  ctr: Number(c.impressions) ? Number(c.clicks) / Number(c.impressions) : 0,
});

export const campaignOut = (c: any) => ({
  id: c.id, businessId: c.business_id, name: c.name, objective: c.objective, status: c.status, currency: c.currency as Currency,
  dailyBudgetMinor: Number(c.daily_budget_minor), totalBudgetMinor: c.total_budget_minor != null ? Number(c.total_budget_minor) : null,
  spentMinor: Math.floor(Number(c.spent_micro) / 1_000_000), todaySpentMinor: c.spend_day && new Date(c.spend_day).toDateString() === new Date().toDateString() ? Math.floor(Number(c.day_spent_micro) / 1_000_000) : 0,
  startsAt: c.starts_at, endsAt: c.ends_at, pauseReason: c.pause_reason, createdAt: c.created_at, updatedAt: c.updated_at, archivedAt: c.archived_at ?? null,
  staffPaused: typeof c.pause_reason === 'string' && c.pause_reason.startsWith(STAFF_PAUSE),
  impressions: c.impressions != null ? Number(c.impressions) : undefined, clicks: c.clicks != null ? Number(c.clicks) : undefined,
});

export const STAFF_PAUSE = 'Paused by DualSphere staff';

/** Insert creatives (policy-checked) for an ad set. Returns ids + whether any needs human review. */
export async function insertCreatives(
  c: PoolClient, campaignId: string, adSetId: string, userId: string, items: CreativeInput[], opts: { source: 'manual' | 'ai'; jobId?: string; extraFlags?: string[]; extraClaims?: string[] },
) {
  let needsReview = false;
  const ids: string[] = [];
  for (const [k, it] of items.entries()) {
    const headline = cleanText(it.headline).slice(0, 90);
    if (!headline) throw badRequest('HEADLINE_REQUIRED', 'Every ad needs a headline');
    const body = cleanText(it.body ?? '').slice(0, 600);
    const media = it.mediaIds?.length ? await mediaService.claimableForAd(it.mediaIds.slice(0, 5), userId) : [];
    const p = policyCheck(`${headline}\n${body}`);
    const flags = [...new Set([...p.flags, ...(opts.extraFlags ?? [])])];
    const claims = [...new Set([...p.claims, ...(opts.extraClaims ?? [])])].slice(0, 10);
    // Restricted categories are refused outright (there is no human review step any more)
    if (flags.length) throw badRequest('AD_POLICY', `This ad can't run on DualSphere (${flags.map((f) => f.replace(/_/g, ' ')).join(', ')}). See the advertising policy.`);
    const { rows } = await c.query(
      `INSERT INTO ad_creatives (ad_set_id, campaign_id, variant_label, headline, body, cta, link_url, media, hashtags, language, source, job_id, policy_flags, claims_to_verify, claims_confirmed, status, reviewed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'approved', now()) RETURNING id`,
      [adSetId, campaignId, (it.label ?? String.fromCharCode(65 + k)).slice(0, 3), headline, body, it.cta, cleanLink(it.linkUrl), JSON.stringify(media),
        (it.hashtags ?? []).map((h) => `#${cleanText(h).replace(/^#+/, '').replace(/\s+/g, '')}`.slice(0, 30)).filter((h) => h.length > 1).slice(0, 6),
        (it.language ?? 'en').slice(0, 10), opts.source, opts.jobId ?? null, flags, claims, !!it.claimsConfirmed],
    );
    ids.push(rows[0].id);
  }
  return { ids, needsReview };
}

/**
 * A submitted campaign goes live at once if its business page is approved (verified, not suspended, not deleted).
 * Otherwise it waits ("pending_review" = waiting for the page approval) and starts automatically when staff approve the page.
 */
export async function submitForDelivery(c: PoolClient, campaignId: string, businessId: string, _needsReview = false) {
  const b = (await c.query('SELECT verification, is_suspended, deleted_at FROM business_pages WHERE id = $1', [businessId])).rows[0];
  await c.query(`UPDATE ad_creatives SET status = 'approved', reviewed_at = COALESCE(reviewed_at, now()) WHERE campaign_id = $1 AND status = 'pending_review'`, [campaignId]);
  if (b.verification === 'verified' && !b.is_suspended && !b.deleted_at) {
    await c.query(`UPDATE ad_campaigns SET status = 'active', pause_reason = NULL, updated_at = now() WHERE id = $1`, [campaignId]);
    return 'active' as const;
  }
  await c.query(`UPDATE ad_campaigns SET status = 'pending_review', pause_reason = 'Waiting for your business page to be approved', updated_at = now() WHERE id = $1`, [campaignId]);
  return 'pending_review' as const;
}

/** Page approved → its waiting / page-paused campaigns start. Page not approved → its live campaigns pause. */
export async function syncCampaignsWithPage(c: PoolClient, businessId: string) {
  const b = (await c.query('SELECT verification, is_suspended, deleted_at FROM business_pages WHERE id = $1', [businessId])).rows[0];
  if (!b) return;
  if (b.verification === 'verified' && !b.is_suspended && !b.deleted_at) {
    await c.query(
      `UPDATE ad_campaigns k SET status = 'active', pause_reason = NULL, updated_at = now()
        WHERE k.business_id = $1 AND (k.status = 'pending_review' OR (k.status = 'paused' AND k.pause_reason IN ('Business suspended by staff', 'Your business page is not approved to run ads')))
          AND EXISTS (SELECT 1 FROM ad_creatives cr WHERE cr.campaign_id = k.id AND cr.status = 'approved')`,
      [businessId],
    );
  } else if (!b.deleted_at) {
    const reason = b.is_suspended ? 'Business suspended by staff' : 'Your business page is not approved to run ads';
    await c.query(`UPDATE ad_campaigns SET status = 'paused', pause_reason = $2, updated_at = now() WHERE business_id = $1 AND status = 'active'`, [businessId, reason]);
  }
}

// ── Delivery tokens & viewer hashing ──
const SIGN_KEY = createHmac('sha256', env.IP_HASH_SALT).update('dualsphere/ads/v1').digest('hex');
const day = () => new Date().toISOString().slice(0, 10);
export const viewerHash = (userId: string | undefined, ip: string | undefined) => createHmac('sha256', SIGN_KEY).update(`${userId ? `u:${userId}` : `ip:${ip ?? '?'}`}:${day()}`).digest('hex').slice(0, 32);

function signToken(creativeId: string, vh: string, placement: Placement) {
  const exp = Math.floor(Date.now() / 1000) + 30 * 60;
  const body = `${creativeId}.${vh}.${exp}.${placement}`;
  return `${body}.${createHmac('sha256', SIGN_KEY).update(body).digest('base64url')}`;
}
/** A token proves this viewer was served this ad (in this placement) in the last 30 minutes. */
export function readToken(token: string, vh: string): { creativeId: string; placement: Placement } | null {
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [creativeId, tvh, exp, placement, sig] = parts as [string, string, string, string, string];
  const expected = createHmac('sha256', SIGN_KEY).update(`${creativeId}.${tvh}.${exp}.${placement}`).digest('base64url');
  if (!safeEqual(sig, expected) || tvh !== vh || Number(exp) < Date.now() / 1000 || !/^[0-9a-f-]{36}$/i.test(creativeId) || !PLACEMENTS.includes(placement as Placement)) return null;
  return { creativeId, placement: placement as Placement };
}

export const adsService = {
  async createCampaign(user: AuthUser, input: {
    businessId: string; name: string; objective: Objective; dailyBudgetMinor: number; totalBudgetMinor?: number | null;
    startsAt?: string; endsAt?: string | null; targeting?: Targeting; bidCpmMinor?: number; adSet?: AdSetInput; creatives: CreativeInput[]; submit?: boolean;
  }) {
    const b = await requireBusinessRole(input.businessId, user, 'admin');
    if (b.is_suspended) throw forbidden('BUSINESS_SUSPENDED', 'This business is suspended');
    assertAmount(input.dailyBudgetMinor, 'Daily budget');
    if (input.dailyBudgetMinor < env.ADS_MIN_DAILY_BUDGET_MINOR) throw badRequest('BUDGET_TOO_LOW', `Daily budget must be at least ${formatMoney(env.ADS_MIN_DAILY_BUDGET_MINOR, env.DEFAULT_CURRENCY)}`);
    if (input.totalBudgetMinor != null) { assertAmount(input.totalBudgetMinor, 'Total budget'); if (input.totalBudgetMinor < input.dailyBudgetMinor) throw badRequest('BAD_BUDGET', 'Total budget must be at least the daily budget'); }
    const setValues = adSetValues(input.adSet ?? { targeting: input.targeting, bidStrategy: input.bidCpmMinor ? 'bid_cap' : 'lowest_cost', bidCpmMinor: input.bidCpmMinor }, input.dailyBudgetMinor);
    if (!input.creatives.length || input.creatives.length > 5) throw badRequest('CREATIVES', 'Add 1–5 ad variants');
    const starts = input.startsAt ? new Date(input.startsAt) : new Date();
    const ends = input.endsAt ? new Date(input.endsAt) : null;
    if (Number.isNaN(starts.getTime()) || (ends && (Number.isNaN(ends.getTime()) || ends <= starts))) throw badRequest('BAD_DATES', 'Check the start and end dates');

    const result = await tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO ad_campaigns (business_id, name, objective, currency, daily_budget_minor, total_budget_minor, starts_at, ends_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [input.businessId, cleanText(input.name).slice(0, 80) || 'Campaign', input.objective, env.DEFAULT_CURRENCY, input.dailyBudgetMinor, input.totalBudgetMinor ?? null, starts, ends, user.id],
      );
      const campaignId = rows[0].id as string;
      const setId = await insertAdSet(c, campaignId, setValues);
      const { needsReview } = await insertCreatives(c, campaignId, setId, user.id, input.creatives, { source: 'manual' });
      const status = input.submit === false ? 'draft' : await submitForDelivery(c, campaignId, input.businessId, needsReview);
      return { campaignId, status };
    });
    return this.getCampaign(user, result.campaignId);
  },

  async listCampaigns(user: AuthUser, businessId: string, includeArchived = false) {
    await requireBusinessRole(businessId, user, 'analyst');
    const { rows } = await query(
      `SELECT c.*, (SELECT COALESCE(sum(impressions), 0) FROM ad_creatives WHERE campaign_id = c.id) AS impressions,
              (SELECT COALESCE(sum(clicks), 0) FROM ad_creatives WHERE campaign_id = c.id) AS clicks
         FROM ad_campaigns c WHERE c.business_id = $1 AND ($2 OR c.archived_at IS NULL) ORDER BY c.created_at DESC LIMIT 200`,
      [businessId, includeArchived],
    );
    return { campaigns: rows.map(campaignOut) };
  },

  async getCampaign(user: AuthUser, campaignId: string) {
    const c = await one('SELECT * FROM ad_campaigns WHERE id = $1', [campaignId]);
    if (!c) throw notFound('Campaign');
    const b = await requireBusinessRole(c.business_id, user, 'analyst');
    const { rows: sets } = await query('SELECT * FROM ad_sets WHERE campaign_id = $1 ORDER BY created_at', [campaignId]);
    const { rows: creatives } = await query('SELECT * FROM ad_creatives WHERE campaign_id = $1 ORDER BY variant_label, created_at', [campaignId]);
    const { rows: hourly } = await query(
      `SELECT hour, sum(impressions)::int AS impressions, sum(clicks)::int AS clicks, sum(spend_micro)::bigint AS spend_micro
         FROM ad_metrics_hourly WHERE campaign_id = $1 AND hour > now() - interval '7 days' GROUP BY hour ORDER BY hour`,
      [campaignId],
    );
    const totals = creatives.reduce((a, x) => ({ impressions: a.impressions + Number(x.impressions), clicks: a.clicks + Number(x.clicks) }), { impressions: 0, clicks: 0 });
    const spentMinor = Math.floor(Number(c.spent_micro) / 1_000_000);
    return {
      campaign: { ...campaignOut(c), ...totals, ctr: totals.impressions ? totals.clicks / totals.impressions : 0, cpcMinor: totals.clicks ? Math.round(spentMinor / totals.clicks) : null },
      business: { id: b.id, name: b.name, slug: b.slug, logoUrl: b.logo_url, verification: b.verification, role: b.role },
      adSets: sets.map(adSetOut),
      creatives: creatives.map(creativeOut),
      hourly: hourly.map((h) => ({ hour: h.hour, impressions: h.impressions, clicks: h.clicks, spendMinor: Math.floor(Number(h.spend_micro) / 1_000_000) })),
    };
  },

  async setCampaignStatus(user: AuthUser, campaignId: string, action: 'pause' | 'resume' | 'submit' | 'end') {
    const c = await one('SELECT * FROM ad_campaigns WHERE id = $1', [campaignId]);
    if (!c) throw notFound('Campaign');
    const b = await requireBusinessRole(c.business_id, user, 'admin');
    await tx(async (cl) => {
      if (action === 'pause') {
        if (c.status !== 'active') throw badRequest('BAD_STATE', 'Only active campaigns can be paused');
        await cl.query(`UPDATE ad_campaigns SET status = 'paused', pause_reason = 'Paused by you', updated_at = now() WHERE id = $1`, [campaignId]);
      } else if (action === 'resume') {
        if (c.status !== 'paused') throw badRequest('BAD_STATE', 'Only paused campaigns can be resumed');
        if (String(c.pause_reason ?? '').startsWith(STAFF_PAUSE)) throw forbidden('STAFF_PAUSED', `${c.pause_reason}. Contact DualSphere support.`);
        if (b.is_suspended) throw forbidden('BUSINESS_SUSPENDED', 'This business is suspended');
        const ok = await cl.query(`SELECT 1 FROM ad_creatives WHERE campaign_id = $1 AND status = 'approved'`, [campaignId]);
        if (!ok.rowCount) throw badRequest('NO_APPROVED_ADS', 'No live ads left in this campaign');
        await submitForDelivery(cl, campaignId, c.business_id);
      } else if (action === 'submit') {
        if (c.status !== 'draft' && c.status !== 'rejected') throw badRequest('BAD_STATE', 'Already submitted');
        await cl.query(`UPDATE ad_creatives SET status = 'pending_review', review_reason = NULL WHERE campaign_id = $1 AND status IN ('rejected','pending_review')`, [campaignId]);
        const flagged = await cl.query(`SELECT 1 FROM ad_creatives WHERE campaign_id = $1 AND (cardinality(policy_flags) > 0 OR (cardinality(claims_to_verify) > 0 AND NOT claims_confirmed))`, [campaignId]);
        await submitForDelivery(cl, campaignId, c.business_id, !!flagged.rowCount);
      } else {
        await cl.query(`UPDATE ad_campaigns SET status = 'completed', updated_at = now() WHERE id = $1 AND status <> 'completed'`, [campaignId]);
      }
    });
    return this.getCampaign(user, campaignId);
  },

  /** Advertiser confirms the factual claims in a creative (needed before it can skip review). */
  async confirmClaims(user: AuthUser, creativeId: string) {
    const cr = await one('SELECT c.id, k.business_id FROM ad_creatives c JOIN ad_campaigns k ON k.id = c.campaign_id WHERE c.id = $1', [creativeId]);
    if (!cr) throw notFound('Ad');
    await requireBusinessRole(cr.business_id, user, 'admin');
    await query('UPDATE ad_creatives SET claims_confirmed = true WHERE id = $1', [creativeId]);
    return { ok: true };
  },

  async updateBudget(user: AuthUser, campaignId: string, input: { dailyBudgetMinor?: number; totalBudgetMinor?: number | null; endsAt?: string | null }) {
    const c = await one('SELECT * FROM ad_campaigns WHERE id = $1', [campaignId]);
    if (!c) throw notFound('Campaign');
    await requireBusinessRole(c.business_id, user, 'admin');
    const daily = input.dailyBudgetMinor ?? Number(c.daily_budget_minor);
    assertAmount(daily, 'Daily budget');
    if (daily < env.ADS_MIN_DAILY_BUDGET_MINOR) throw badRequest('BUDGET_TOO_LOW', 'Daily budget is below the minimum');
    const total = input.totalBudgetMinor === undefined ? c.total_budget_minor : input.totalBudgetMinor;
    if (total != null && (Number(total) < daily || Number(total) * 1_000_000 < Number(c.spent_micro))) throw badRequest('BAD_BUDGET', 'Total budget is below the daily budget or what was already spent');
    await query('UPDATE ad_campaigns SET daily_budget_minor = $2, total_budget_minor = $3, ends_at = COALESCE($4, ends_at), updated_at = now() WHERE id = $1',
      [campaignId, daily, total, input.endsAt ? new Date(input.endsAt) : null]);
    return this.getCampaign(user, campaignId);
  },

  // ── Delivery ──

  /** Pick one sponsored ad for this viewer. Only verified, funded, in-budget, approved, matching ads are eligible. */
  async slot(viewer: AuthUser | undefined, ip: string | undefined, placement: Placement = 'feed', exclude: string[] = []) {
    let profile: { location: string; age: number | null; interests: string[]; gender: string | null } | null = null;
    if (viewer) {
      const u = await one(`SELECT location, birth_date, hobbies, gender FROM users WHERE id = $1`, [viewer.id]);
      const age = u?.birth_date ? Math.floor((Date.now() - new Date(u.birth_date).getTime()) / (365.25 * 86_400_000)) : null;
      profile = { location: (u?.location ?? '').toLowerCase(), age, interests: (u?.hobbies ?? []).map((h: string) => h.toLowerCase()), gender: u?.gender ?? null };
    }
    const vh = viewerHash(viewer?.id, ip);
    const params: unknown[] = [];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const genderOk = profile?.gender
      ? `(jsonb_array_length(COALESCE(s.targeting->'genders','[]')) = 0 OR s.targeting->'genders' ? ${add(profile.gender)})`
      : `jsonb_array_length(COALESCE(s.targeting->'genders','[]')) = 0`;
    const hidden = viewer
      ? `AND NOT EXISTS (SELECT 1 FROM ad_hides h WHERE h.user_id = ${add(viewer.id)} AND ((h.kind = 'ad' AND h.target_id = cr.id) OR (h.kind = 'business' AND h.target_id = b.id)))`
      : '';
    const cost = `(CASE WHEN s.billing_event = 'click' THEN COALESCE(s.bid_cpc_minor, ${DEFAULT_BID_CPC_MINOR}) * 1000000 ELSE s.bid_cpm_minor * 1000 END)`;
    // Smoothed click-through rate: new ads start at ~1% and learn from real clicks
    const ctr = `((cr.clicks + 1.0) / (cr.impressions + 100.0))`;
    // Targeting: empty lists match everyone; signed-out viewers only see untargeted ads
    const geoOk = profile
      ? `(jsonb_array_length(COALESCE(s.targeting->'geo','[]')) = 0 OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.targeting->'geo') g WHERE ${add(profile.location)} LIKE '%' || g || '%'))`
      : `jsonb_array_length(COALESCE(s.targeting->'geo','[]')) = 0`;
    const interestOk = profile
      ? `(jsonb_array_length(COALESCE(s.targeting->'interests','[]')) = 0 OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.targeting->'interests') i WHERE i = ANY(${add(profile.interests)}::text[])))`
      : `jsonb_array_length(COALESCE(s.targeting->'interests','[]')) = 0`;
    const ageOk = profile?.age != null
      ? `${add(profile.age)} BETWEEN COALESCE((s.targeting->>'ageMin')::int, 0) AND COALESCE((s.targeting->>'ageMax')::int, 200)`
      : 'true';
    const { rows } = await query(
      `SELECT cr.*, s.bid_cpm_minor, b.id AS business_id, b.name AS business_name, b.slug AS business_slug, b.logo_url, b.badge
         FROM ad_creatives cr
         JOIN ad_sets s ON s.id = cr.ad_set_id
         JOIN ad_campaigns k ON k.id = cr.campaign_id
         JOIN business_pages b ON b.id = k.business_id
         JOIN business_ad_balances bal ON bal.business_id = b.id
        WHERE cr.status = 'approved' AND k.status = 'active' AND k.starts_at <= now() AND (k.ends_at IS NULL OR k.ends_at > now())
          AND b.verification = 'verified' AND NOT b.is_suspended AND b.deleted_at IS NULL
          AND s.status = 'active' AND ${add(placement)} = ANY(s.placements)
          AND bal.available_micro >= ${cost}
          AND (k.spend_day <> current_date OR k.day_spent_micro + ${cost} <= k.daily_budget_minor * 1000000)
          AND (k.total_budget_minor IS NULL OR k.spent_micro + ${cost} <= k.total_budget_minor * 1000000)
          AND ${geoOk} AND ${interestOk} AND ${ageOk} AND ${genderOk} ${hidden}
          AND NOT (cr.id = ANY(${add(exclude)}::uuid[]))
          -- Frequency cap: at most N views of this campaign per person per day
          AND (SELECT count(*) FROM ad_events e WHERE e.campaign_id = k.id AND e.viewer_hash = ${add(vh)} AND e.kind = 'impression'
                AND e.created_at > now() - interval '24 hours') < s.frequency_cap
        -- Auction: expected value per 1000 views (bid × expected clicks for CPC) × ad quality, with randomness
        ORDER BY random() * (CASE WHEN s.billing_event = 'click' THEN COALESCE(s.bid_cpc_minor, ${DEFAULT_BID_CPC_MINOR}) * 1000.0 * ${ctr} ELSE s.bid_cpm_minor END)
                 * LEAST(2.0, GREATEST(0.5, ${ctr} / 0.01)) DESC
        LIMIT 1`,
      params,
    );
    const a = rows[0];
    if (!a) return { ad: null };
    return {
      ad: {
        creativeId: a.id,
        token: signToken(a.id, vh, placement), placement,
        sponsored: true,
        business: { name: a.business_name, slug: a.business_slug, logoUrl: a.logo_url, isVerified: true, badge: a.badge },
        headline: a.headline, body: a.body, cta: a.cta, linkUrl: a.link_url, media: a.media ?? [], hashtags: a.hashtags ?? [],
      },
    };
  },

  /**
   * Impression / click beacon. The token proves this viewer was served this ad; each counts once per viewer per hour.
   * An impression charges bid/1000 atomically against the prepaid balance and the daily/total budget — or isn't counted.
   */
  async event(viewer: AuthUser | undefined, ip: string | undefined, token: string, kind: 'impression' | 'click') {
    const vh = viewerHash(viewer?.id, ip);
    const t = readToken(token, vh);
    if (!t) throw badRequest('BAD_TOKEN', 'Invalid ad token');
    const creativeId = t.creativeId;
    const who = viewer ? await one(`SELECT birth_date, gender FROM users WHERE id = $1`, [viewer.id]) : null;
    const age = ageBucket(who?.birth_date);
    const gender = who?.gender === 'male' || who?.gender === 'female' ? who.gender : who?.gender ? 'other' : 'unknown';
    return tx(async (c) => {
      const { rows } = await c.query(
        `SELECT cr.id, cr.campaign_id, cr.link_url, cr.status, s.bid_cpm_minor, s.bid_cpc_minor, s.billing_event, k.business_id, k.status AS campaign_status
           FROM ad_creatives cr JOIN ad_sets s ON s.id = cr.ad_set_id JOIN ad_campaigns k ON k.id = cr.campaign_id WHERE cr.id = $1`,
        [creativeId],
      );
      const a = rows[0];
      if (!a || a.status !== 'approved' || a.campaign_status !== 'active') return { counted: false, linkUrl: a?.link_url ?? null };
      // Pay per 1000 views (charged per view) or per click — whichever the ad set chose
      const cost = kind === 'impression'
        ? (a.billing_event === 'click' ? 0 : Number(a.bid_cpm_minor) * 1000)
        : (a.billing_event === 'click' ? Number(a.bid_cpc_minor ?? DEFAULT_BID_CPC_MINOR) * 1_000_000 : 0);
      const ins = await c.query(
        `INSERT INTO ad_events (creative_id, campaign_id, kind, viewer_hash, cost_micro, placement, age_bucket, gender) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING RETURNING id`,
        [a.id, a.campaign_id, kind, vh, cost, t.placement, age, gender],
      );
      if (!ins.rowCount) return { counted: false, linkUrl: a.link_url };
      if (cost > 0) {
        const bal = await c.query('UPDATE business_ad_balances SET available_micro = available_micro - $2 WHERE business_id = $1 AND available_micro >= $2', [a.business_id, cost]);
        const spend = await c.query(
          `UPDATE ad_campaigns SET
              day_spent_micro = CASE WHEN spend_day = current_date THEN day_spent_micro + $2 ELSE $2 END,
              spend_day = current_date, spent_micro = spent_micro + $2
            WHERE id = $1
              AND (spend_day <> current_date OR day_spent_micro + $2 <= daily_budget_minor * 1000000)
              AND (total_budget_minor IS NULL OR spent_micro + $2 <= total_budget_minor * 1000000)`,
          [a.campaign_id, cost],
        );
        if (!bal.rowCount || !spend.rowCount) {
          // Out of money or budget: don't count it, and stop serving until topped up / tomorrow
          await c.query('DELETE FROM ad_events WHERE id = $1', [ins.rows[0].id]);
          if (!bal.rowCount) await c.query(`UPDATE ad_campaigns SET status = 'paused', pause_reason = 'Ad balance is empty — add funds to resume', updated_at = now() WHERE business_id = $1 AND status = 'active'`, [a.business_id]);
          return { counted: false, linkUrl: a.link_url };
        }
      }
      await c.query(`UPDATE ad_creatives SET ${kind === 'impression' ? 'impressions = impressions + 1' : 'clicks = clicks + 1'} WHERE id = $1`, [a.id]);
      return { counted: true, linkUrl: a.link_url };
    });
  },

  // ── Staff review (Admin Panel → Ad review, ads.review) ──
  async reviewQueue(status: 'pending_review' | 'approved' | 'rejected' | 'live' | 'all') {
    const live = status === 'live';
    if (live) status = 'approved';
    const all = status === 'all';
    const { rows } = await query(
      `SELECT cr.*, k.name AS campaign_name, k.objective, k.daily_budget_minor, k.currency, k.status AS campaign_status,
              b.id AS business_id, b.name AS business_name, b.slug AS business_slug, b.verification, b.approved_ads,
              j.brief, j.engine
         FROM ad_creatives cr JOIN ad_campaigns k ON k.id = cr.campaign_id JOIN business_pages b ON b.id = k.business_id
         LEFT JOIN ad_studio_jobs j ON j.id = cr.job_id
        WHERE ${all ? 'TRUE' : 'cr.status = $1'} ${live ? `AND k.status = 'active'` : ''} ORDER BY ${status === 'pending_review' ? 'cr.created_at ASC' : all ? 'cr.created_at DESC' : 'cr.reviewed_at DESC'} LIMIT 100`,
      all ? [] : [status],
    );
    return { items: rows.map((r) => ({
      ...creativeOut(r), reviewedAt: r.reviewed_at,
      campaign: { id: r.campaign_id, name: r.campaign_name, objective: r.objective, status: r.campaign_status, dailyBudgetMinor: Number(r.daily_budget_minor), currency: r.currency },
      business: { id: r.business_id, name: r.business_name, slug: r.business_slug, verification: r.verification, approvedAds: r.approved_ads },
      brief: r.brief ?? null, engine: r.engine ?? null,
    })) };
  },

  async review(actor: AuthUser, creativeId: string, approve: boolean, reason?: string) {
    const why = cleanText(reason ?? '').slice(0, 300);
    if (!approve && why.length < 3) throw badRequest('REASON_REQUIRED', 'Tell the advertiser why');
    const r = await tx(async (c) => {
      const { rows } = await c.query(
        `SELECT cr.id, cr.campaign_id, cr.status, k.business_id, k.status AS campaign_status, b.verification, b.owner_id, k.name
           FROM ad_creatives cr JOIN ad_campaigns k ON k.id = cr.campaign_id JOIN business_pages b ON b.id = k.business_id WHERE cr.id = $1 FOR UPDATE OF cr`,
        [creativeId],
      );
      const x = rows[0];
      if (!x) throw notFound('Ad');
      if (approve ? x.status !== 'pending_review' : !['pending_review', 'approved', 'paused'].includes(x.status)) throw badRequest('BAD_STATE', 'This ad was already handled');
      await c.query(`UPDATE ad_creatives SET status = $2, review_reason = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1`, [creativeId, approve ? 'approved' : 'rejected', why || null, actor.id]);
      if (approve) {
        await c.query('UPDATE business_pages SET approved_ads = approved_ads + 1 WHERE id = $1', [x.business_id]);
        // The campaign goes live once it has an approved ad and the business is verified
        if (x.campaign_status === 'pending_review' && x.verification === 'verified') {
          await c.query(`UPDATE ad_campaigns SET status = 'active', pause_reason = NULL, updated_at = now() WHERE id = $1`, [x.campaign_id]);
        }
      } else {
        const left = await c.query(`SELECT 1 FROM ad_creatives WHERE campaign_id = $1 AND status IN ('pending_review','approved')`, [x.campaign_id]);
        if (!left.rowCount) await c.query(`UPDATE ad_campaigns SET status = 'rejected', pause_reason = 'Ad removed by DualSphere staff', updated_at = now() WHERE id = $1`, [x.campaign_id]);
      }
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: approve ? 'AD_APPROVE' : 'AD_REJECT', targetId: creativeId, targetType: 'ad', metadata: { campaignId: x.campaign_id, reason: why || null } }, c);
      return x;
    });
    if (r.owner_id) {
      await notificationService.create({
        userId: r.owner_id, type: 'system',
        message: approve ? `An ad in “${r.name}” was approved` : `An ad in “${r.name}” was taken down by DualSphere staff: ${why}`,
      }).catch(() => {});
    }
    return { ok: true };
  },
};

/**
 * Staff permanently delete an ad (creative). Its events/metrics go with it; spend already charged stays on the
 * campaign so billing and the ledger are unaffected. A campaign left with no ads ends.
 */
export async function deleteCreative(actor: AuthUser, creativeId: string, reason: string) {
  const why = cleanText(reason).slice(0, 300);
  if (why.length < 3) throw badRequest('REASON_REQUIRED', 'Give a reason (at least 3 characters)');
  const r = await tx(async (c) => {
    const { rows } = await c.query(
      `SELECT cr.id, cr.campaign_id, cr.headline, cr.media, k.name AS campaign_name, b.owner_id, b.name AS business_name
         FROM ad_creatives cr JOIN ad_campaigns k ON k.id = cr.campaign_id JOIN business_pages b ON b.id = k.business_id
        WHERE cr.id = $1 FOR UPDATE OF cr`,
      [creativeId],
    );
    const x = rows[0];
    if (!x) throw notFound('Ad');
    await c.query('DELETE FROM ad_creatives WHERE id = $1', [creativeId]);
    const left = await c.query('SELECT 1 FROM ad_creatives WHERE campaign_id = $1', [x.campaign_id]);
    if (!left.rowCount) {
      await c.query(`UPDATE ad_campaigns SET status = 'completed', pause_reason = 'Ad deleted by DualSphere staff', updated_at = now() WHERE id = $1`, [x.campaign_id]);
    }
    await auditService.log({
      actorId: actor.id, actorRole: actor.role, action: 'AD_DELETE', targetId: creativeId, targetType: 'ad',
      metadata: { campaignId: x.campaign_id, business: x.business_name, headline: x.headline, reason: why },
    }, c);
    return x;
  });
  // Files that nothing else uses any more are removed from storage
  for (const m of (r.media ?? []) as { url: string }[]) await mediaService.releaseIfUnused(m.url).catch(() => {});
  if (r.owner_id) {
    await notificationService.create({ userId: r.owner_id, type: 'system', message: `An ad in “${r.campaign_name}” was removed by DualSphere staff: ${why}` }).catch(() => {});
  }
  return { ok: true };
}

// ── Background tasks (worker) ──

/** Move whole-unit ad spend from each advertiser's prepaid balance to platform revenue in the ledger. */
export async function billAdSpend() {
  const { rows } = await query(
    `SELECT bal.business_id, bal.currency, bal.billed_micro, COALESCE(sum(k.spent_micro), 0)::bigint AS spent
       FROM business_ad_balances bal LEFT JOIN ad_campaigns k ON k.business_id = bal.business_id
      GROUP BY bal.business_id, bal.currency, bal.billed_micro`,
  );
  let n = 0;
  for (const r of rows) {
    const unbilledMinor = Math.floor((Number(r.spent) - Number(r.billed_micro)) / 1_000_000);
    if (unbilledMinor <= 0) continue;
    const newBilled = Number(r.billed_micro) + unbilledMinor * 1_000_000;
    await tx(async (c) => {
      const ok = await book(c, { kind: 'ad_spend', idempotencyKey: `adbill:${r.business_id}:${newBilled}`, currency: r.currency, referenceId: r.business_id, legs: [
        { account: acct.adBalance(r.business_id), amount: unbilledMinor },
        { account: acct.adRevenue, amount: -unbilledMinor },
      ] });
      if (ok) await c.query('UPDATE business_ad_balances SET billed_micro = $2 WHERE business_id = $1 AND billed_micro = $3', [r.business_id, newBilled, r.billed_micro]);
    });
    n++;
  }
  return n;
}

/** Hourly rollup of the last few hours of events (idempotent: recomputes those hours). */
export async function rollupAdMetrics() {
  await query(
    `INSERT INTO ad_metrics_hourly (creative_id, campaign_id, hour, impressions, clicks, spend_micro)
     SELECT creative_id, campaign_id, date_trunc('hour', created_at),
            count(*) FILTER (WHERE kind = 'impression'), count(*) FILTER (WHERE kind = 'click'), COALESCE(sum(cost_micro), 0)
       FROM ad_events WHERE created_at >= date_trunc('hour', now()) - interval '3 hours'
      GROUP BY 1, 2, 3
     ON CONFLICT (creative_id, hour) DO UPDATE SET impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks, spend_micro = EXCLUDED.spend_micro`,
  );
}

/** Auto A/B: in each ad set, pause variants whose CTR is under half the best one (once each has 200+ views). */
export async function optimizeCreatives() {
  const { rows } = await query(
    `SELECT ad_set_id, id, impressions, clicks FROM ad_creatives WHERE status = 'approved' AND impressions >= 200 ORDER BY ad_set_id`,
  );
  const bySet = new Map<string, { id: string; ctr: number }[]>();
  for (const r of rows) {
    const list = bySet.get(r.ad_set_id) ?? [];
    list.push({ id: r.id, ctr: Number(r.clicks) / Number(r.impressions) });
    bySet.set(r.ad_set_id, list);
  }
  let paused = 0;
  for (const list of bySet.values()) {
    if (list.length < 2) continue;
    const best = Math.max(...list.map((x) => x.ctr));
    if (best <= 0) continue;
    for (const x of list) {
      if (x.ctr < best * 0.5) {
        await query(`UPDATE ad_creatives SET status = 'paused', review_reason = 'Paused automatically: lower click rate than the winning variant' WHERE id = $1 AND status = 'approved'`, [x.id]);
        paused++;
      }
    }
  }
  return paused;
}

/** Campaigns past their end date or total budget. */
export async function completeCampaigns() {
  const r = await query(
    `UPDATE ad_campaigns SET status = 'completed', updated_at = now()
      WHERE status IN ('active','paused') AND ((ends_at IS NOT NULL AND ends_at < now())
         OR (total_budget_minor IS NOT NULL AND spent_micro + 1000000 > total_budget_minor * 1000000))`,
  );
  if (r.rowCount) logger.info({ n: r.rowCount }, 'campaigns completed');
  return r.rowCount ?? 0;
}
