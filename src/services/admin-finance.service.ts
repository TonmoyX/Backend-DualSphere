// Admin Panel → Revenue and Payments (finance.view). Read-only reports straight from the ledger.
import { one, query } from '../config/db.js';

export const adminFinanceService = {
  async revenue() {
    const { rows: byCurrency } = await query(
      `SELECT currency,
              COALESCE(-sum(amount_minor) FILTER (WHERE account = 'platform:fees'), 0)::bigint AS fees,
              COALESCE(-sum(amount_minor) FILTER (WHERE account = 'platform:ad_revenue'), 0)::bigint AS ad_revenue,
              COALESCE(sum(amount_minor) FILTER (WHERE account LIKE 'cash:%'), 0)::bigint AS cash_in,
              COALESCE(-sum(amount_minor) FILTER (WHERE account = 'payouts:sent'), 0)::bigint AS payouts_sent,
              COALESCE(-sum(amount_minor) FILTER (WHERE account LIKE 'user:%'), 0)::bigint AS creator_liability,
              COALESCE(-sum(amount_minor) FILTER (WHERE account LIKE 'business:%'), 0)::bigint AS advertiser_liability,
              sum(amount_minor)::bigint AS imbalance
         FROM ledger_entries GROUP BY currency`,
    );
    const { rows: daily } = await query(
      `WITH days AS (SELECT generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') AS d)
       SELECT to_char(d, 'YYYY-MM-DD') AS date,
              COALESCE((SELECT -sum(e.amount_minor) FROM ledger_entries e WHERE e.account = 'platform:fees' AND date_trunc('day', e.created_at) = d), 0)::bigint AS fees,
              COALESCE((SELECT -sum(e.amount_minor) FROM ledger_entries e WHERE e.account = 'platform:ad_revenue' AND date_trunc('day', e.created_at) = d), 0)::bigint AS ad_revenue,
              COALESCE((SELECT sum(p.amount_minor) FROM payments p WHERE p.status = 'succeeded' AND date_trunc('day', p.succeeded_at) = d), 0)::bigint AS volume
         FROM days ORDER BY d`,
    );
    const ai = await one<{ jobs: number; cost: string }>(`SELECT count(*)::int AS jobs, COALESCE(sum(cost_micro), 0)::bigint AS cost FROM ad_studio_jobs WHERE created_at > now() - interval '30 days'`);
    const pending = await one<{ payouts: number; kyc: number; ads: number }>(
      `SELECT (SELECT count(*) FROM payouts WHERE status IN ('requested','approved'))::int AS payouts,
              (SELECT count(*) FROM kyc_records WHERE status = 'pending')::int AS kyc,
              (SELECT count(*) FROM ad_creatives WHERE status = 'pending_review')::int AS ads`,
    );
    return {
      byCurrency: byCurrency.map((r) => ({
        currency: r.currency, fees: Number(r.fees), adRevenue: Number(r.ad_revenue), cashIn: Number(r.cash_in), payoutsSent: Number(r.payouts_sent),
        creatorLiability: Number(r.creator_liability), advertiserLiability: Number(r.advertiser_liability),
        balanced: Number(r.imbalance) === 0, // double-entry check: every currency must sum to zero
      })),
      daily: daily.map((d) => ({ date: d.date, fees: Number(d.fees), adRevenue: Number(d.ad_revenue), volume: Number(d.volume) })),
      ai: { jobs30d: ai?.jobs ?? 0, costUsd30d: Number(ai?.cost ?? 0) / 1_000_000 },
      pending,
    };
  },

  async payments(f: { status?: string; purpose?: string; page: number; limit: number }) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.status && f.status !== 'all') { params.push(f.status); where.push(`p.status = $${params.length}`); }
    if (f.purpose && f.purpose !== 'all') { params.push(f.purpose); where.push(`p.purpose = $${params.length}`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await one<{ n: number }>(`SELECT count(*)::int AS n FROM payments p ${w}`, params);
    params.push(f.limit, (f.page - 1) * f.limit);
    const { rows } = await query(
      `SELECT p.id, p.purpose, p.status, p.amount_minor, p.fee_minor, p.currency, p.provider, p.provider_ref, p.created_at, p.succeeded_at, p.released_at,
              payer.username AS payer, creator.username AS creator, b.name AS business
         FROM payments p
         LEFT JOIN users payer ON payer.id = p.payer_id
         LEFT JOIN users creator ON creator.id = p.creator_id
         LEFT JOIN business_pages b ON b.id = p.business_id
         ${w} ORDER BY p.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      items: rows.map((r) => ({
        id: r.id, purpose: r.purpose, status: r.status, amountMinor: Number(r.amount_minor), feeMinor: Number(r.fee_minor), currency: r.currency,
        provider: r.provider, providerRef: r.provider_ref, createdAt: r.created_at, succeededAt: r.succeeded_at, releasedAt: r.released_at,
        payer: r.payer, creator: r.creator, business: r.business, refundable: r.status === 'succeeded' && !r.released_at,
      })),
      total: total?.n ?? 0,
    };
  },
};
