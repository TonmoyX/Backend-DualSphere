// ═══════════════════════════════════════════════════════════════
// Ads Manager (Facebook-style) on top of ads.service.ts:
//  • Advertisers: insights with date ranges and breakdowns (age, gender, placement), edit / duplicate / delete
//    campaigns, several ad sets per campaign (audience, placements, bidding, frequency cap), add / edit / pause ads,
//    audience size estimate, billing history.
//  • People in the feed: "Why am I seeing this ad?", hide an ad / all ads from a business, report an ad
//    (five reports pause the ad automatically until staff look at it).
//  • Staff: ads overview, every campaign with pause / resume / end, the ad reports queue.
// Reports use coarse buckets only (age range, gender, placement) — never user ids.
// ═══════════════════════════════════════════════════════════════
import { one, query, tx } from '../config/db.js';
import { env } from '../config/env.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { assertAmount, formatMoney } from '../lib/money.js';
import { emit } from '../lib/realtime.js';
import { cleanText } from '../lib/text.js';
import type { AuthUser } from '../types/index.js';
import {
  type AdSetInput, adSetOut, adSetValues, adsService, campaignOut, creativeOut, type CreativeInput, insertAdSet, insertCreatives,
  policyCheck, readToken, STAFF_PAUSE, submitForDelivery, type Targeting, viewerHash,
} from './ads.service.js';
import { auditService } from './audit.service.js';
import { requireBusinessRole } from './business.service.js';
import { mediaService } from './media.service.js';
import { notificationService } from './notification.service.js';

export type Range = 'today' | '7d' | '30d' | 'lifetime';
/** SQL for the start of a range (Range is a validated enum, never user text). */
const since = (r: Range) => ({ today: `date_trunc('day', now())`, '7d': `now() - interval '7 days'`, '30d': `now() - interval '30 days'`, lifetime: `'epoch'::timestamptz` })[r];
const REPORTS_TO_AUTOPAUSE = 5;
const AUTO_PAUSE_REASON = 'Paused automatically after several reports — under review by DualSphere';

const METRICS = `count(*) FILTER (WHERE kind = 'impression')::int AS impressions,
  count(DISTINCT viewer_hash) FILTER (WHERE kind = 'impression')::int AS reach,
  count(*) FILTER (WHERE kind = 'click')::int AS clicks,
  COALESCE(sum(cost_micro), 0)::bigint AS spend_micro`;

/** Standard Ads Manager columns from raw counts. Money in minor units (cents), possibly fractional. */
function metric(r: any) {
  const impressions = Number(r?.impressions ?? 0);
  const reach = Number(r?.reach ?? 0);
  const clicks = Number(r?.clicks ?? 0);
  const spend = Number(r?.spend_micro ?? 0) / 1_000_000;
  return {
    impressions, reach, clicks, spendMinor: Math.round(spend * 100) / 100,
    ctr: impressions ? clicks / impressions : 0,
    cpcMinor: clicks ? spend / clicks : null,
    cpmMinor: impressions ? (spend * 1000) / impressions : null,
    frequency: reach ? impressions / reach : 0,
  };
}

/** Time series with empty buckets filled (hourly for today, daily otherwise). */
async function series(filterSql: string, params: unknown[], range: Range, firstAt: Date | string) {
  const unit = range === 'today' ? 'hour' : 'day';
  const { rows } = await query(
    `WITH buckets AS (
       SELECT generate_series(date_trunc('${unit}', GREATEST(${since(range)}, $${params.length + 1}::timestamptz)), date_trunc('${unit}', now()), interval '1 ${unit}') AS b
     ), e AS (
       SELECT date_trunc('${unit}', created_at) AS b, ${METRICS} FROM ad_events WHERE ${filterSql} AND created_at >= ${since(range)} GROUP BY 1
     )
     SELECT buckets.b, e.impressions, e.reach, e.clicks, e.spend_micro FROM buckets LEFT JOIN e USING (b) ORDER BY buckets.b`,
    [...params, firstAt],
  );
  return rows.map((r) => ({ at: r.b, ...metric(r) }));
}

async function loadCampaign(user: AuthUser, id: string, role: 'analyst' | 'admin') {
  const c = await one('SELECT * FROM ad_campaigns WHERE id = $1', [id]);
  if (!c) throw notFound('Campaign');
  const b = await requireBusinessRole(c.business_id, user, role);
  return { c, b };
}
async function loadAdSet(user: AuthUser, id: string) {
  const s = await one('SELECT s.*, k.business_id, k.daily_budget_minor, k.status AS campaign_status, k.archived_at FROM ad_sets s JOIN ad_campaigns k ON k.id = s.campaign_id WHERE s.id = $1', [id]);
  if (!s) throw notFound('Ad set');
  await requireBusinessRole(s.business_id, user, 'admin');
  return s;
}
async function loadCreative(user: AuthUser, id: string) {
  const cr = await one('SELECT cr.*, k.business_id FROM ad_creatives cr JOIN ad_campaigns k ON k.id = cr.campaign_id WHERE cr.id = $1', [id]);
  if (!cr) throw notFound('Ad');
  await requireBusinessRole(cr.business_id, user, 'admin');
  return cr;
}
const editable = (c: { status: string; archived_at: unknown }) => {
  if (c.archived_at || c.status === 'completed') throw badRequest('CAMPAIGN_ENDED', 'This campaign has ended — duplicate it to run it again');
};

/** The viewer this token was served to (the token is bound to the viewer's daily hash). */
async function servedAd(viewer: AuthUser | undefined, ip: string | undefined, token: string) {
  const t = readToken(token, viewerHash(viewer?.id, ip));
  if (!t) throw badRequest('BAD_TOKEN', 'This ad has expired — refresh the page');
  const a = await one(
    `SELECT cr.id, cr.status, cr.review_reason, cr.campaign_id, s.targeting, b.id AS business_id, b.name AS business_name, b.slug AS business_slug, b.owner_id
       FROM ad_creatives cr JOIN ad_sets s ON s.id = cr.ad_set_id JOIN ad_campaigns k ON k.id = cr.campaign_id JOIN business_pages b ON b.id = k.business_id
      WHERE cr.id = $1`,
    [t.creativeId],
  );
  if (!a) throw notFound('Ad');
  return { ...a, placement: t.placement as string };
}

export const adsManager = {
  // ── Insights ──
  async campaignInsights(user: AuthUser, campaignId: string, range: Range) {
    const { c } = await loadCampaign(user, campaignId, 'analyst');
    const f = `campaign_id = $1 AND created_at >= ${since(range)}`;
    const [totals, daily, age, gender, placement, byCreative, byAdSet] = await Promise.all([
      one(`SELECT ${METRICS} FROM ad_events WHERE ${f}`, [campaignId]),
      series('campaign_id = $1', [campaignId], range, c.created_at),
      query(`SELECT age_bucket AS key, ${METRICS} FROM ad_events WHERE ${f} GROUP BY 1 ORDER BY 1`, [campaignId]),
      query(`SELECT gender AS key, ${METRICS} FROM ad_events WHERE ${f} GROUP BY 1 ORDER BY 1`, [campaignId]),
      query(`SELECT placement AS key, ${METRICS} FROM ad_events WHERE ${f} GROUP BY 1 ORDER BY 1`, [campaignId]),
      query(`SELECT creative_id AS key, ${METRICS} FROM ad_events WHERE ${f} GROUP BY 1`, [campaignId]),
      query(`SELECT cr.ad_set_id AS key, ${METRICS.replace(/\b(kind|viewer_hash|cost_micro)\b/g, 'e.$1')} FROM ad_events e JOIN ad_creatives cr ON cr.id = e.creative_id
              WHERE e.campaign_id = $1 AND e.created_at >= ${since(range)} GROUP BY 1`, [campaignId]),
    ]);
    const keyed = (rows: any[]) => rows.map((r) => ({ key: r.key, ...metric(r) }));
    const byId = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.key, metric(r)]));
    return {
      range, totals: metric(totals), series: daily,
      breakdowns: { age: keyed(age.rows), gender: keyed(gender.rows), placement: keyed(placement.rows) },
      byCreative: byId(byCreative.rows), byAdSet: byId(byAdSet.rows),
    };
  },

  /** The Ads Manager table: every campaign of a business with metrics for the range. */
  async businessInsights(user: AuthUser, businessId: string, range: Range) {
    const b = await requireBusinessRole(businessId, user, 'analyst');
    const f = `campaign_id IN (SELECT id FROM ad_campaigns WHERE business_id = $1)`;
    const [campaigns, per, totals, daily, bal] = await Promise.all([
      query(`SELECT k.*, (SELECT count(*) FROM ad_sets s WHERE s.campaign_id = k.id)::int AS ad_sets, (SELECT count(*) FROM ad_creatives cr WHERE cr.campaign_id = k.id)::int AS ads
               FROM ad_campaigns k WHERE k.business_id = $1 AND k.archived_at IS NULL ORDER BY (k.status = 'active') DESC, k.created_at DESC LIMIT 200`, [businessId]),
      query(`SELECT campaign_id AS key, ${METRICS} FROM ad_events WHERE ${f} AND created_at >= ${since(range)} GROUP BY 1`, [businessId]),
      one(`SELECT ${METRICS} FROM ad_events WHERE ${f} AND created_at >= ${since(range)}`, [businessId]),
      series(f, [businessId], range, b.created_at),
      one('SELECT available_micro FROM business_ad_balances WHERE business_id = $1', [businessId]),
    ]);
    const m = new Map(per.rows.map((r) => [r.key as string, metric(r)]));
    return {
      range, totals: metric(totals), series: daily, balanceMinor: Math.floor(Number(bal?.available_micro ?? 0) / 1_000_000),
      campaigns: campaigns.rows.map((k) => ({ ...campaignOut(k), adSets: k.ad_sets, ads: k.ads, metrics: m.get(k.id) ?? metric(null) })),
    };
  },

  async billing(user: AuthUser, businessId: string) {
    await requireBusinessRole(businessId, user, 'admin');
    const [pays, spend, bal] = await Promise.all([
      query(`SELECT id, amount_minor, status, provider, created_at, succeeded_at FROM payments WHERE business_id = $1 AND purpose = 'ad_topup' ORDER BY created_at DESC LIMIT 100`, [businessId]),
      query(`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COALESCE(sum(cost_micro), 0)::bigint AS spend_micro
               FROM ad_events WHERE campaign_id IN (SELECT id FROM ad_campaigns WHERE business_id = $1) AND created_at > now() - interval '30 days' AND cost_micro > 0
              GROUP BY 1 ORDER BY 1 DESC`, [businessId]),
      one('SELECT available_micro, billed_micro FROM business_ad_balances WHERE business_id = $1', [businessId]),
    ]);
    return {
      balanceMinor: Math.floor(Number(bal?.available_micro ?? 0) / 1_000_000),
      payments: pays.rows.map((p) => ({ id: p.id, amountMinor: Number(p.amount_minor), status: p.status, provider: p.provider, createdAt: p.created_at, succeededAt: p.succeeded_at })),
      dailySpend: spend.rows.map((d) => ({ day: d.day, spendMinor: Math.round(Number(d.spend_micro) / 10_000) / 100 })),
    };
  },

  /** How many people match. Rounded, and never below 100 (so targeting can't single anyone out). */
  async audienceEstimate(targeting: Targeting) {
    const t = adSetValues({ targeting }, Number.MAX_SAFE_INTEGER).targeting;
    const geo = (t.geo ?? []).map((g) => `%${g.replace(/[%_\\]/g, '\\$&')}%`);
    const r = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM users u
        WHERE NOT u.is_banned
          AND (cardinality($1::text[]) = 0 OR lower(COALESCE(u.location, '')) LIKE ANY($1::text[]))
          AND (u.birth_date IS NULL OR date_part('year', age(u.birth_date)) BETWEEN $2 AND $3)
          AND (cardinality($4::text[]) = 0 OR u.gender = ANY($4::text[]))
          AND (cardinality($5::text[]) = 0 OR EXISTS (SELECT 1 FROM unnest(u.hobbies) h WHERE lower(h) = ANY($5::text[])))`,
      [geo, t.ageMin, t.ageMax, t.genders ?? [], t.interests ?? []],
    );
    const n = r?.n ?? 0;
    if (n < 100) return { lower: null, upper: 100, label: 'Fewer than 100 people', narrow: true };
    const round = (x: number) => { const p = 10 ** Math.max(0, Math.floor(Math.log10(x)) - 1); return Math.round(x / p) * p; };
    return { lower: round(n * 0.85), upper: round(n * 1.15), label: null, narrow: false };
  },

  // ── Campaigns ──
  async updateCampaign(user: AuthUser, campaignId: string, input: { name?: string; dailyBudgetMinor?: number; totalBudgetMinor?: number | null; startsAt?: string; endsAt?: string | null }) {
    const { c } = await loadCampaign(user, campaignId, 'admin');
    editable(c);
    const daily = input.dailyBudgetMinor ?? Number(c.daily_budget_minor);
    assertAmount(daily, 'Daily budget');
    if (daily < env.ADS_MIN_DAILY_BUDGET_MINOR) throw badRequest('BUDGET_TOO_LOW', `Daily budget must be at least ${formatMoney(env.ADS_MIN_DAILY_BUDGET_MINOR, env.DEFAULT_CURRENCY)}`);
    const total = input.totalBudgetMinor === undefined ? (c.total_budget_minor != null ? Number(c.total_budget_minor) : null) : input.totalBudgetMinor;
    if (total != null) {
      assertAmount(total, 'Total budget');
      if (total < daily || total * 1_000_000 < Number(c.spent_micro)) throw badRequest('BAD_BUDGET', 'Total budget must be at least the daily budget and what was already spent');
    }
    const starts = input.startsAt ? new Date(input.startsAt) : new Date(c.starts_at);
    const ends = input.endsAt === undefined ? (c.ends_at ? new Date(c.ends_at) : null) : input.endsAt ? new Date(input.endsAt) : null;
    if (ends && ends <= starts) throw badRequest('BAD_DATES', 'The end must be after the start');
    const name = input.name !== undefined ? cleanText(input.name).slice(0, 80) || c.name : c.name;
    await query('UPDATE ad_campaigns SET name = $2, daily_budget_minor = $3, total_budget_minor = $4, starts_at = $5, ends_at = $6, updated_at = now() WHERE id = $1',
      [campaignId, name, daily, total, starts, ends]);
    return adsService.getCampaign(user, campaignId);
  },

  /** Copy a campaign (with its ad sets and ads) as a new draft. */
  async duplicateCampaign(user: AuthUser, campaignId: string) {
    const { c } = await loadCampaign(user, campaignId, 'admin');
    const id = await tx(async (cl) => {
      const { rows } = await cl.query(
        `INSERT INTO ad_campaigns (business_id, name, objective, currency, daily_budget_minor, total_budget_minor, starts_at, ends_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, now(), NULL, $7) RETURNING id`,
        [c.business_id, `${c.name} (copy)`.slice(0, 80), c.objective, c.currency, c.daily_budget_minor, c.total_budget_minor, user.id],
      );
      const newId = rows[0].id as string;
      const { rows: sets } = await cl.query('SELECT * FROM ad_sets WHERE campaign_id = $1 ORDER BY created_at', [campaignId]);
      for (const s of sets) {
        const ns = await cl.query(
          `INSERT INTO ad_sets (campaign_id, name, targeting, bid_cpm_minor, placements, billing_event, bid_strategy, bid_cpc_minor, frequency_cap, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [newId, s.name, s.targeting, s.bid_cpm_minor, s.placements, s.billing_event, s.bid_strategy, s.bid_cpc_minor, s.frequency_cap, s.status],
        );
        await cl.query(
          `INSERT INTO ad_creatives (ad_set_id, campaign_id, variant_label, headline, body, cta, link_url, media, hashtags, language, source, policy_flags, claims_to_verify, claims_confirmed, status, reviewed_at)
           SELECT $2, $3, variant_label, headline, body, cta, link_url, media, hashtags, language, source, policy_flags, claims_to_verify, claims_confirmed,
                  CASE WHEN status = 'rejected' THEN 'rejected' ELSE 'approved' END, now()
             FROM ad_creatives WHERE ad_set_id = $1 ORDER BY variant_label`,
          [s.id, ns.rows[0].id, newId],
        );
      }
      return newId;
    });
    return adsService.getCampaign(user, id);
  },

  /** A campaign that never spent is deleted; one with delivery history is archived (its numbers stay on record). */
  async deleteCampaign(user: AuthUser, campaignId: string) {
    const { c } = await loadCampaign(user, campaignId, 'admin');
    const delivered = Number(c.spent_micro) > 0 || !!(await one('SELECT 1 FROM ad_events WHERE campaign_id = $1 LIMIT 1', [campaignId]));
    if (delivered) {
      await query(`UPDATE ad_campaigns SET status = 'completed', archived_at = now(), pause_reason = COALESCE(pause_reason, 'Deleted by you'), updated_at = now() WHERE id = $1`, [campaignId]);
      return { deleted: false, archived: true };
    }
    const { rows } = await query('SELECT media FROM ad_creatives WHERE campaign_id = $1', [campaignId]);
    await query('DELETE FROM ad_campaigns WHERE id = $1', [campaignId]);
    for (const r of rows) for (const m of (r.media ?? []) as { url: string }[]) await mediaService.releaseIfUnused(m.url).catch(() => {});
    return { deleted: true, archived: false };
  },

  // ── Ad sets ──
  async addAdSet(user: AuthUser, campaignId: string, input: AdSetInput & { creatives?: CreativeInput[] }) {
    const { c } = await loadCampaign(user, campaignId, 'admin');
    editable(c);
    const count = await one<{ n: number }>('SELECT count(*)::int AS n FROM ad_sets WHERE campaign_id = $1', [campaignId]);
    if ((count?.n ?? 0) >= 10) throw badRequest('TOO_MANY', 'A campaign can have up to 10 ad sets');
    const v = adSetValues(input, Number(c.daily_budget_minor));
    await tx(async (cl) => {
      const setId = await insertAdSet(cl, campaignId, v);
      if (input.creatives?.length) await insertCreatives(cl, campaignId, setId, user.id, input.creatives, { source: 'manual' });
    });
    return adsService.getCampaign(user, campaignId);
  },

  async updateAdSet(user: AuthUser, adSetId: string, input: AdSetInput) {
    const s = await loadAdSet(user, adSetId);
    editable({ status: s.campaign_status, archived_at: s.archived_at });
    const cur = adSetOut(s);
    const v = adSetValues({
      name: input.name ?? cur.name, targeting: input.targeting ?? cur.targeting, placements: input.placements ?? cur.placements,
      billingEvent: input.billingEvent ?? cur.billingEvent, bidStrategy: input.bidStrategy ?? cur.bidStrategy,
      bidCpmMinor: input.bidCpmMinor ?? cur.bidCpmMinor, bidCpcMinor: input.bidCpcMinor ?? cur.bidCpcMinor ?? undefined, frequencyCap: input.frequencyCap ?? cur.frequencyCap,
    }, Number(s.daily_budget_minor));
    await query(
      `UPDATE ad_sets SET name = $2, targeting = $3, placements = $4, billing_event = $5, bid_strategy = $6, bid_cpm_minor = $7, bid_cpc_minor = $8, frequency_cap = $9, updated_at = now() WHERE id = $1`,
      [adSetId, v.name, JSON.stringify(v.targeting), v.placements, v.billingEvent, v.bidStrategy, v.bidCpmMinor, v.bidCpcMinor, v.frequencyCap],
    );
    return adsService.getCampaign(user, s.campaign_id);
  },

  async setAdSetStatus(user: AuthUser, adSetId: string, action: 'pause' | 'resume') {
    const s = await loadAdSet(user, adSetId);
    await query(`UPDATE ad_sets SET status = $2, updated_at = now() WHERE id = $1`, [adSetId, action === 'pause' ? 'paused' : 'active']);
    return adsService.getCampaign(user, s.campaign_id);
  },

  async deleteAdSet(user: AuthUser, adSetId: string) {
    const s = await loadAdSet(user, adSetId);
    const sets = await one<{ n: number }>('SELECT count(*)::int AS n FROM ad_sets WHERE campaign_id = $1', [s.campaign_id]);
    if ((sets?.n ?? 0) <= 1) throw badRequest('LAST_AD_SET', 'A campaign needs at least one ad set');
    if (await one('SELECT 1 FROM ad_events e JOIN ad_creatives cr ON cr.id = e.creative_id WHERE cr.ad_set_id = $1 LIMIT 1', [adSetId])) {
      throw conflict('HAS_DELIVERY', 'This ad set has already been shown to people — pause it instead so its numbers stay in your reports');
    }
    const { rows } = await query('SELECT media FROM ad_creatives WHERE ad_set_id = $1', [adSetId]);
    await query('DELETE FROM ad_sets WHERE id = $1', [adSetId]);
    for (const r of rows) for (const m of (r.media ?? []) as { url: string }[]) await mediaService.releaseIfUnused(m.url).catch(() => {});
    return adsService.getCampaign(user, s.campaign_id);
  },

  // ── Ads (creatives) ──
  async addCreatives(user: AuthUser, adSetId: string, creatives: CreativeInput[]) {
    const s = await loadAdSet(user, adSetId);
    editable({ status: s.campaign_status, archived_at: s.archived_at });
    const have = await one<{ n: number }>('SELECT count(*)::int AS n FROM ad_creatives WHERE ad_set_id = $1', [adSetId]);
    const n = have?.n ?? 0;
    if (n + creatives.length > 10) throw badRequest('TOO_MANY', 'An ad set can have up to 10 ads');
    await tx(async (cl) => {
      await insertCreatives(cl, s.campaign_id, adSetId, user.id, creatives.map((cr, k) => ({ ...cr, label: String.fromCharCode(65 + ((n + k) % 26)) })), { source: 'manual' });
    });
    return adsService.getCampaign(user, s.campaign_id);
  },

  async updateCreative(user: AuthUser, creativeId: string, input: CreativeInput) {
    const cr = await loadCreative(user, creativeId);
    const headline = cleanText(input.headline).slice(0, 90);
    if (!headline) throw badRequest('HEADLINE_REQUIRED', 'Every ad needs a headline');
    const body = cleanText(input.body ?? '').slice(0, 600);
    const p = policyCheck(`${headline}\n${body}`);
    if (p.flags.length) throw badRequest('AD_POLICY', `This ad can't run on DualSphere (${p.flags.map((f) => f.replace(/_/g, ' ')).join(', ')}). See the advertising policy.`);
    // Keep files that were already on the ad; claim only newly uploaded ones
    const current = (cr.media ?? []) as { id: string; url: string }[];
    const ids = (input.mediaIds ?? current.map((m) => m.id)).slice(0, 5);
    const fresh = await mediaService.claimableForAd(ids.filter((id) => !current.some((m) => m.id === id)), user.id);
    const media = ids.map((id) => current.find((m) => m.id === id) ?? fresh.find((m) => m.id === id)).filter(Boolean);
    let link: string | null = null;
    if (input.linkUrl) {
      try { const u = new URL(input.linkUrl); if (u.protocol !== 'https:' || u.username || u.password) throw new Error(); link = u.toString().slice(0, 500); } catch { throw badRequest('BAD_URL', 'Use a plain https:// link'); }
    }
    const hashtags = (input.hashtags ?? cr.hashtags ?? []).map((h: string) => `#${cleanText(h).replace(/^#+/, '').replace(/\s+/g, '')}`.slice(0, 30)).filter((h: string) => h.length > 1).slice(0, 6);
    await query(
      `UPDATE ad_creatives SET headline = $2, body = $3, cta = $4, link_url = $5, media = $6, hashtags = $7, claims_to_verify = $8, claims_confirmed = $9 WHERE id = $1`,
      [creativeId, headline, body, input.cta, link, JSON.stringify(media), hashtags, p.claims, !!input.claimsConfirmed],
    );
    for (const m of current) if (!media.some((x: any) => x.id === m.id)) await mediaService.releaseIfUnused(m.url).catch(() => {});
    return adsService.getCampaign(user, cr.campaign_id);
  },

  async setCreativeStatus(user: AuthUser, creativeId: string, action: 'pause' | 'resume') {
    const cr = await loadCreative(user, creativeId);
    if (action === 'pause') {
      if (cr.status !== 'approved') throw badRequest('BAD_STATE', 'Only running ads can be paused');
      await query(`UPDATE ad_creatives SET status = 'paused', review_reason = 'Paused by you' WHERE id = $1`, [creativeId]);
    } else {
      if (cr.status !== 'paused') throw badRequest('BAD_STATE', 'Only paused ads can be turned back on');
      if (cr.review_reason === AUTO_PAUSE_REASON) throw forbidden('UNDER_REVIEW', 'This ad is under review after reports — DualSphere will turn it back on if it follows the rules');
      await query(`UPDATE ad_creatives SET status = 'approved', review_reason = NULL WHERE id = $1`, [creativeId]);
    }
    return adsService.getCampaign(user, cr.campaign_id);
  },

  async deleteCreative(user: AuthUser, creativeId: string) {
    const cr = await loadCreative(user, creativeId);
    if (Number(cr.impressions) > 0 || Number(cr.clicks) > 0) throw conflict('HAS_DELIVERY', 'This ad has already been shown to people — pause it instead so its numbers stay in your reports');
    const left = await one<{ n: number }>('SELECT count(*)::int AS n FROM ad_creatives WHERE campaign_id = $1', [cr.campaign_id]);
    if ((left?.n ?? 0) <= 1) throw badRequest('LAST_AD', 'A campaign needs at least one ad');
    await query('DELETE FROM ad_creatives WHERE id = $1', [creativeId]);
    for (const m of (cr.media ?? []) as { url: string }[]) await mediaService.releaseIfUnused(m.url).catch(() => {});
    return adsService.getCampaign(user, cr.campaign_id);
  },

  // ── People in the feed ──
  /** "Why am I seeing this ad?" — only the advertiser's targeting that matches this viewer; nothing about others. */
  async why(viewer: AuthUser | undefined, ip: string | undefined, token: string) {
    const a = await servedAd(viewer, ip, token);
    const t = (a.targeting ?? {}) as Targeting;
    const me = viewer ? await one('SELECT location, hobbies, birth_date FROM users WHERE id = $1', [viewer.id]) : null;
    const reasons: string[] = [];
    const where = ({ feed: 'your feed', sidebar: 'the sidebar', reels: 'Reels' } as Record<string, string>)[a.placement as string] ?? 'your feed';
    reasons.push(`${a.business_name} is paying to show this ad in ${where}.`);
    if (t.ageMin || t.ageMax) reasons.push(`They want to reach people aged ${t.ageMin ?? 18}–${t.ageMax ?? 65}${me?.birth_date ? ', and the birthday on your profile fits' : ''}.`);
    if (t.genders?.length === 1) reasons.push(`They chose to show it to ${t.genders[0] === 'male' ? 'men' : 'women'}.`);
    const loc = String(me?.location ?? '').toLowerCase();
    const places = (t.geo ?? []).filter((g) => loc.includes(g));
    if (places.length) reasons.push(`They want to reach people in ${places.join(', ')} — your profile's location matches.`);
    else if (!t.geo?.length) reasons.push('They want to reach people in any location.');
    const hobbies = ((me?.hobbies ?? []) as string[]).map((h) => h.toLowerCase());
    const interests = (t.interests ?? []).filter((i) => hobbies.includes(i));
    if (interests.length) reasons.push(`They want to reach people interested in ${interests.join(', ')} (from the hobbies on your profile).`);
    reasons.push('DualSphere never uses your messages or your anonymous posts to choose ads.');
    return { business: { name: a.business_name, slug: a.business_slug }, reasons };
  },

  async hide(viewer: AuthUser, ip: string | undefined, token: string, scope: 'ad' | 'business') {
    const a = await servedAd(viewer, ip, token);
    await query('INSERT INTO ad_hides (user_id, kind, target_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [viewer.id, scope, scope === 'ad' ? a.id : a.business_id]);
    return { ok: true };
  },

  async report(viewer: AuthUser, ip: string | undefined, token: string, reason: string, details?: string) {
    const a = await servedAd(viewer, ip, token);
    const text = details ? cleanText(details).slice(0, 500) : null;
    const paused = await tx(async (c) => {
      await c.query('INSERT INTO ad_reports (creative_id, reporter_id, reason, details) VALUES ($1, $2, $3, $4) ON CONFLICT (creative_id, reporter_id) DO NOTHING', [a.id, viewer.id, reason, text]);
      await c.query(`INSERT INTO ad_hides (user_id, kind, target_id) VALUES ($1, 'ad', $2) ON CONFLICT DO NOTHING`, [viewer.id, a.id]);
      const n = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ad_reports WHERE creative_id = $1 AND status = 'open'`, [a.id]);
      if ((n.rows[0]?.n ?? 0) >= REPORTS_TO_AUTOPAUSE) {
        const r = await c.query(`UPDATE ad_creatives SET status = 'paused', review_reason = $2 WHERE id = $1 AND status = 'approved'`, [a.id, AUTO_PAUSE_REASON]);
        return !!r.rowCount;
      }
      return false;
    });
    emit.staff('admin:ad-report', { creativeId: a.id });
    if (paused && a.owner_id) await notificationService.create({ userId: a.owner_id, type: 'system', message: `An ad from ${a.business_name} was paused after several reports. DualSphere is reviewing it.` }).catch(() => {});
    return { ok: true };
  },

  // ── Staff (Admin Panel) ──
  async staffOverview(range: Range) {
    const [totals, daily, counts, top, reports, balances] = await Promise.all([
      one(`SELECT ${METRICS} FROM ad_events WHERE created_at >= ${since(range)}`),
      series('TRUE', [], range, new Date(Date.now() - 30 * 86_400_000)),
      one(`SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'paused')::int AS paused,
                  count(*) FILTER (WHERE status = 'pending_review')::int AS waiting, count(DISTINCT business_id) FILTER (WHERE status = 'active')::int AS advertisers
             FROM ad_campaigns WHERE archived_at IS NULL`),
      query(`SELECT b.id, b.name, b.slug, ${METRICS.replace(/\b(kind|viewer_hash|cost_micro)\b/g, 'e.$1')}
               FROM ad_events e JOIN ad_campaigns k ON k.id = e.campaign_id JOIN business_pages b ON b.id = k.business_id
              WHERE e.created_at >= ${since(range)} GROUP BY b.id ORDER BY sum(e.cost_micro) DESC NULLS LAST LIMIT 8`),
      one<{ n: number }>(`SELECT count(DISTINCT creative_id)::int AS n FROM ad_reports WHERE status = 'open'`),
      one(`SELECT COALESCE(sum(available_micro), 0)::bigint AS m FROM business_ad_balances`),
    ]);
    return {
      range, totals: metric(totals), series: daily, campaigns: counts, openReports: reports?.n ?? 0,
      prepaidBalanceMinor: Math.floor(Number(balances?.m ?? 0) / 1_000_000),
      topAdvertisers: top.rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, ...metric(r) })),
    };
  },

  async staffCampaigns(f: { status?: string; q?: string }) {
    const params: unknown[] = [];
    const where = ['k.archived_at IS NULL'];
    if (f.status && f.status !== 'all') {
      if (f.status === 'staff_paused') { params.push(`${STAFF_PAUSE}%`); where.push(`k.pause_reason LIKE $${params.length}`); }
      else { params.push(f.status); where.push(`k.status = $${params.length}`); }
    }
    if (f.q) { params.push(`%${f.q.replace(/[%_\\]/g, '\\$&')}%`); where.push(`(k.name ILIKE $${params.length} OR b.name ILIKE $${params.length})`); }
    const { rows } = await query(
      `SELECT k.*, b.name AS business_name, b.slug AS business_slug, b.verification,
              (SELECT COALESCE(sum(impressions), 0) FROM ad_creatives WHERE campaign_id = k.id)::bigint AS impressions,
              (SELECT COALESCE(sum(clicks), 0) FROM ad_creatives WHERE campaign_id = k.id)::bigint AS clicks,
              (SELECT count(*) FROM ad_creatives WHERE campaign_id = k.id)::int AS ads
         FROM ad_campaigns k JOIN business_pages b ON b.id = k.business_id
        WHERE ${where.join(' AND ')} ORDER BY (k.status = 'active') DESC, k.updated_at DESC LIMIT 200`,
      params,
    );
    return { items: rows.map((k) => ({ ...campaignOut(k), ads: k.ads, business: { name: k.business_name, slug: k.business_slug, verification: k.verification } })) };
  },

  async staffCampaignStatus(actor: AuthUser, campaignId: string, action: 'pause' | 'resume' | 'end', reason?: string) {
    const why = cleanText(reason ?? '').slice(0, 300);
    if (action !== 'resume' && why.length < 3) throw badRequest('REASON_REQUIRED', 'Give a reason — the advertiser sees it');
    const k = await one('SELECT k.*, b.owner_id, b.name AS business_name FROM ad_campaigns k JOIN business_pages b ON b.id = k.business_id WHERE k.id = $1', [campaignId]);
    if (!k) throw notFound('Campaign');
    await tx(async (c) => {
      if (action === 'pause') {
        const r = await c.query(`UPDATE ad_campaigns SET status = 'paused', pause_reason = $2, updated_at = now() WHERE id = $1 AND status IN ('active','pending_review','paused')`, [campaignId, `${STAFF_PAUSE}: ${why}`]);
        if (!r.rowCount) throw badRequest('BAD_STATE', 'This campaign has ended');
      } else if (action === 'resume') {
        if (!String(k.pause_reason ?? '').startsWith(STAFF_PAUSE)) throw badRequest('BAD_STATE', 'Only campaigns paused by staff can be resumed here');
        await c.query(`UPDATE ad_campaigns SET status = 'paused', pause_reason = 'Paused by you', updated_at = now() WHERE id = $1`, [campaignId]);
        await submitForDelivery(c, campaignId, k.business_id);
      } else {
        await c.query(`UPDATE ad_campaigns SET status = 'completed', pause_reason = $2, updated_at = now() WHERE id = $1`, [campaignId, `Ended by DualSphere staff: ${why}`]);
      }
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: `AD_CAMPAIGN_STAFF_${action.toUpperCase()}`, targetId: campaignId, targetType: 'ad_campaign', metadata: { business: k.business_name, name: k.name, reason: why || null } }, c);
    });
    if (k.owner_id) {
      const msg = action === 'pause' ? `Your campaign “${k.name}” was paused by DualSphere staff: ${why}`
        : action === 'resume' ? `Your campaign “${k.name}” can run again` : `Your campaign “${k.name}” was ended by DualSphere staff: ${why}`;
      await notificationService.create({ userId: k.owner_id, type: 'system', message: msg }).catch(() => {});
    }
    return { ok: true };
  },

  async staffReports(status: 'open' | 'dismissed' | 'actioned') {
    const { rows } = await query(
      `SELECT r.creative_id, count(*)::int AS n, array_agg(DISTINCT r.reason) AS reasons, max(r.created_at) AS last_at,
              (array_remove(array_agg(r.details ORDER BY r.created_at DESC), NULL))[1:3] AS details,
              cr.headline, cr.body, cr.media, cr.status, cr.review_reason, cr.link_url, k.id AS campaign_id, k.name AS campaign_name, b.name AS business_name, b.slug AS business_slug
         FROM ad_reports r JOIN ad_creatives cr ON cr.id = r.creative_id JOIN ad_campaigns k ON k.id = cr.campaign_id JOIN business_pages b ON b.id = k.business_id
        WHERE r.status = $1
        GROUP BY r.creative_id, cr.id, k.id, b.id ORDER BY n DESC, last_at DESC LIMIT 100`,
      [status],
    );
    return { items: rows.map((r) => ({
      creativeId: r.creative_id, reports: r.n, reasons: r.reasons, details: r.details ?? [], lastAt: r.last_at,
      ad: { headline: r.headline, body: r.body, media: r.media ?? [], status: r.status, reviewReason: r.review_reason, linkUrl: r.link_url },
      campaign: { id: r.campaign_id, name: r.campaign_name }, business: { name: r.business_name, slug: r.business_slug },
    })) };
  },

  async resolveReports(actor: AuthUser, creativeId: string, action: 'dismiss' | 'takedown', reason?: string) {
    const cr = await one('SELECT id, status, review_reason FROM ad_creatives WHERE id = $1', [creativeId]);
    if (!cr) throw notFound('Ad');
    if (action === 'takedown') {
      await adsService.review(actor, creativeId, false, reason);
    } else if (cr.status === 'paused' && cr.review_reason === AUTO_PAUSE_REASON) {
      await query(`UPDATE ad_creatives SET status = 'approved', review_reason = NULL WHERE id = $1`, [creativeId]);
    }
    await tx(async (c) => {
      await c.query(`UPDATE ad_reports SET status = $2, reviewed_by = $3, reviewed_at = now() WHERE creative_id = $1 AND status = 'open'`, [creativeId, action === 'takedown' ? 'actioned' : 'dismissed', actor.id]);
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: action === 'takedown' ? 'AD_REPORTS_ACTIONED' : 'AD_REPORTS_DISMISSED', targetId: creativeId, targetType: 'ad', metadata: { reason: reason ?? null } }, c);
    });
    return { ok: true };
  },
};
