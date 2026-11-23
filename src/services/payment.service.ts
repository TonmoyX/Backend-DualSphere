// ═══════════════════════════════════════════════════════════════
// Payments in: tips, paid-post unlocks, memberships, advertiser top-ups.
//  • Prices come from OUR records (tier / post price), never from the client — except a tip amount, which is bounded.
//  • A payment is settled at most once: row lock + status check + unique webhook event id + ledger idempotency key.
//  • The verified amount and currency must match the payment exactly, or nothing is booked.
//  • Money and anonymity never touch: anonymous posts can't be tipped or sold.
// ═══════════════════════════════════════════════════════════════
import type { PoolClient } from 'pg';
import { one, query, tx } from '../config/db.js';
import { env } from '../config/env.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { assertAmount, type Currency, formatMoney, platformFee } from '../lib/money.js';
import { assertProvider, configuredProviders, type ProviderName, refundAtProvider, startCheckout, type VerifiedResult } from '../lib/payment-providers.js';
import { emit } from '../lib/realtime.js';
import { cleanText } from '../lib/text.js';
import type { AuthUser } from '../types/index.js';
import { auditService } from './audit.service.js';
import { acct, book, purgeTransactions } from './ledger.service.js';
import { notificationService } from './notification.service.js';

export type Purpose = 'tip' | 'unlock' | 'membership' | 'ad_topup';
export const TIP_MIN_MINOR = 100; // $1 (Stripe's minimum charge is $0.50)
export const TIP_MAX_MINOR = 1_000_000; // $10,000

export interface CreatePaymentInput {
  purpose: Purpose;
  provider: ProviderName;
  creatorId?: string;
  postId?: string;
  tierId?: string;
  businessId?: string;
  amountMinor?: number; // tips and top-ups only
  currency?: Currency;
  note?: string;
  phone?: string; // SSLCommerz requires the buyer's phone; forwarded only, never stored
}

async function assertNotBlocked(a: string, b: string) {
  const r = await one('SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)', [a, b]);
  if (r) throw forbidden('BLOCKED', "You can't pay this account");
}

async function activeCreator(userId: string) {
  const c = await one(`SELECT cp.*, u.display_name FROM creator_profiles cp JOIN users u ON u.id = cp.user_id
                        WHERE cp.user_id = $1 AND cp.is_active AND u.is_banned = false`, [userId]);
  if (!c) throw notFound('Creator');
  return c;
}

export const paymentService = {
  providers(currency: Currency) {
    return { providers: configuredProviders(currency), currency };
  },

  async create(user: AuthUser, input: CreatePaymentInput) {
    if (!user.isVerified) throw forbidden('EMAIL_NOT_VERIFIED', 'Verify your email before paying');
    // One currency for the whole platform
    if (input.currency && input.currency !== env.DEFAULT_CURRENCY) throw badRequest('BAD_CURRENCY', `Payments are in ${env.DEFAULT_CURRENCY}`);
    if (input.provider === 'sslcommerz' && !/^\+?[0-9]{8,15}$/.test((input.phone ?? '').replace(/[\s-]/g, ''))) {
      throw badRequest('PHONE_REQUIRED', 'Enter your phone number to pay with SSLCommerz');
    }
    let amount: number;
    let currency: Currency;
    let creatorId: string | null = null;
    let description: string;
    let fee = 0;

    switch (input.purpose) {
      case 'tip': {
        if (!input.creatorId) throw badRequest('CREATOR_REQUIRED', 'Who are you tipping?');
        if (input.creatorId === user.id) throw badRequest('SELF', "You can't tip yourself");
        const c = await activeCreator(input.creatorId);
        if (!c.tips_enabled) throw forbidden('TIPS_OFF', 'This creator has turned tips off');
        await assertNotBlocked(user.id, input.creatorId);
        if (input.postId) {
          // Tips on a post: identity posts by this creator only (an anonymous post has no one to pay)
          const p = await one(`SELECT 1 FROM posts WHERE id = $1 AND author_id = $2 AND visibility = 'identity' AND is_removed = false AND deleted_at IS NULL`, [input.postId, input.creatorId]);
          if (!p) throw badRequest('BAD_POST', 'This post can\'t receive tips');
        }
        amount = input.amountMinor ?? 0;
        currency = env.DEFAULT_CURRENCY;
        assertAmount(amount, 'Tip');
        if (amount < TIP_MIN_MINOR || amount > TIP_MAX_MINOR) throw badRequest('BAD_AMOUNT', `Tips are between ${formatMoney(TIP_MIN_MINOR, currency)} and ${formatMoney(TIP_MAX_MINOR, currency)}`);
        creatorId = input.creatorId;
        fee = platformFee(amount);
        description = `Tip for ${c.display_name}`;
        break;
      }
      case 'unlock': {
        if (!input.postId) throw badRequest('POST_REQUIRED', 'Which post?');
        const p = await one(
          `SELECT p.id, p.author_id, p.price_minor, p.currency, u.display_name FROM posts p JOIN users u ON u.id = p.author_id
            WHERE p.id = $1 AND p.access = 'paid' AND p.visibility = 'identity' AND p.is_removed = false AND p.deleted_at IS NULL AND u.is_banned = false`,
          [input.postId],
        );
        if (!p) throw notFound('Paid post');
        if (p.author_id === user.id) throw badRequest('SELF', 'This is your own post');
        await activeCreator(p.author_id);
        await assertNotBlocked(user.id, p.author_id);
        if (await one('SELECT 1 FROM post_unlocks WHERE post_id = $1 AND user_id = $2', [p.id, user.id])) throw conflict('ALREADY_UNLOCKED', 'You already unlocked this post');
        amount = Number(p.price_minor);
        currency = p.currency;
        creatorId = p.author_id;
        fee = platformFee(amount);
        description = `Unlock a post by ${p.display_name}`;
        break;
      }
      case 'membership': {
        if (!input.tierId) throw badRequest('TIER_REQUIRED', 'Which membership?');
        const t = await one(
          `SELECT t.*, u.display_name FROM membership_tiers t JOIN users u ON u.id = t.creator_id WHERE t.id = $1 AND t.is_active AND u.is_banned = false`,
          [input.tierId],
        );
        if (!t) throw notFound('Membership');
        if (t.creator_id === user.id) throw badRequest('SELF', "You can't join your own membership");
        await activeCreator(t.creator_id);
        await assertNotBlocked(user.id, t.creator_id);
        amount = Number(t.price_minor);
        currency = t.currency;
        creatorId = t.creator_id;
        fee = platformFee(amount);
        description = `${t.name} membership · ${t.display_name} (1 month)`;
        break;
      }
      case 'ad_topup': {
        if (!input.businessId) throw badRequest('BUSINESS_REQUIRED', 'Which business?');
        const b = await one(
          `SELECT b.id, b.name FROM business_pages b JOIN business_members m ON m.business_id = b.id
            WHERE b.id = $1 AND m.user_id = $2 AND m.role IN ('owner','admin') AND NOT b.is_suspended`,
          [input.businessId, user.id],
        );
        if (!b) throw forbidden('NOT_BUSINESS_ADMIN', 'Only business owners and admins can add funds');
        amount = input.amountMinor ?? 0;
        currency = env.DEFAULT_CURRENCY;
        assertAmount(amount, 'Top-up');
        if (amount < env.ADS_MIN_DAILY_BUDGET_MINOR) throw badRequest('BAD_AMOUNT', `Add at least ${formatMoney(env.ADS_MIN_DAILY_BUDGET_MINOR, currency)}`);
        description = `Ad balance for ${b.name}`;
        break;
      }
      default:
        throw badRequest('BAD_PURPOSE', 'Unknown payment');
    }

    assertProvider(input.provider, currency);
    // Abuse guard: cap open checkouts per user
    const open = await one<{ n: number }>(`SELECT count(*)::int AS n FROM payments WHERE payer_id = $1 AND status = 'created' AND created_at > now() - interval '1 hour'`, [user.id]);
    if ((open?.n ?? 0) >= 10) throw new AppError(429, 'TOO_MANY_CHECKOUTS', 'Finish or cancel your open payments first');

    const { rows } = await query(
      `INSERT INTO payments (payer_id, purpose, creator_id, post_id, tier_id, business_id, amount_minor, fee_minor, currency, provider, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [user.id, input.purpose, creatorId, input.postId ?? null, input.tierId ?? null, input.businessId ?? null, amount, fee, currency, input.provider,
        input.purpose === 'tip' && input.note ? cleanText(input.note).slice(0, 200) : null],
    );
    const paymentId = rows[0].id as string;
    const payer = await one('SELECT display_name, email FROM users WHERE id = $1', [user.id]);
    try {
      const { redirectUrl, providerRef } = await startCheckout(input.provider, {
        paymentId, amountMinor: amount, currency, description,
        customer: { name: payer.display_name, email: payer.email, phone: input.phone?.replace(/[\s-]/g, '') },
      });
      if (providerRef) await query('UPDATE payments SET provider_ref = $2, updated_at = now() WHERE id = $1', [paymentId, providerRef]);
      return { paymentId, redirectUrl, amountMinor: amount, currency };
    } catch (err) {
      await query(`UPDATE payments SET status = 'failed', updated_at = now() WHERE id = $1`, [paymentId]);
      throw err;
    }
  },

  /** The payer checks on their own payment (result page). */
  async status(user: AuthUser, paymentId: string) {
    const p = await one('SELECT id, purpose, status, amount_minor, currency, creator_id, post_id, business_id FROM payments WHERE id = $1 AND payer_id = $2', [paymentId, user.id]);
    if (!p) throw notFound('Payment');
    return { id: p.id, purpose: p.purpose, status: p.status, amountMinor: Number(p.amount_minor), currency: p.currency, postId: p.post_id, businessId: p.business_id };
  },

  /**
   * Apply a VERIFIED provider result. Safe to call any number of times for the same event.
   * Returns the payment status after processing.
   */
  async settle(provider: ProviderName, r: VerifiedResult) {
    return tx(async (c) => {
      // Exactly-once per provider event
      const ev = await c.query('INSERT INTO payment_webhook_events (provider, event_id, payment_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [provider, r.eventId, r.paymentId]);
      if (!ev.rowCount) return 'duplicate';

      const { rows } = await c.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [r.paymentId]);
      const p = rows[0];
      if (!p) { logger.warn({ provider, paymentId: r.paymentId }, 'payment webhook for unknown payment'); return 'unknown'; }
      if (p.provider !== provider) { logger.warn({ provider, paymentId: p.id }, 'payment webhook from the wrong provider'); return 'mismatch'; }
      if (p.status !== 'created') return p.status as string; // already settled / failed / expired

      if (r.outcome === 'failed') {
        await c.query(`UPDATE payments SET status = 'failed', updated_at = now() WHERE id = $1`, [p.id]);
        return 'failed';
      }
      // The money that actually moved must be exactly what we asked for
      if (r.amountMinor !== Number(p.amount_minor) || r.currency !== p.currency) {
        logger.error({ paymentId: p.id, expected: [p.amount_minor, p.currency], got: [r.amountMinor, r.currency] }, 'payment amount mismatch');
        await c.query(`UPDATE payments SET status = 'failed', updated_at = now() WHERE id = $1`, [p.id]);
        await auditService.log({ action: 'PAYMENT_AMOUNT_MISMATCH', targetId: p.id, targetType: 'payment', metadata: { expected: Number(p.amount_minor), got: r.amountMinor, currency: r.currency } }, c);
        return 'failed';
      }

      await c.query(
        `UPDATE payments SET status = 'succeeded', succeeded_at = now(), updated_at = now(), provider_ref = COALESCE($2, provider_ref) WHERE id = $1`,
        [p.id, r.providerRef],
      );
      await applySuccess(c, p, provider);
      return 'succeeded';
    }).then(async (status) => {
      if (status === 'succeeded') await afterSuccess(r.paymentId).catch((err) => logger.error({ err }, 'payment follow-up failed'));
      return status;
    });
  },

  /**
   * Admin: permanently delete a payment and its ledger records, as if it never happened. Not a refund — no money is
   * returned at Stripe / SSLCommerz. Refused when the money was already used (ad budget spent, earnings withdrawn).
   */
  async remove(actor: AuthUser, paymentId: string, reason: string) {
    const why = cleanText(reason).slice(0, 300);
    if (why.length < 3) throw badRequest('REASON_REQUIRED', 'Give a reason');
    await tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
      const p = rows[0];
      if (!p) throw notFound('Payment');
      const amount = Number(p.amount_minor);
      if (p.status === 'succeeded') {
        if (p.purpose === 'ad_topup' && p.business_id) {
          const dec = await c.query('UPDATE business_ad_balances SET available_micro = available_micro - $2 WHERE business_id = $1 AND available_micro >= $2', [p.business_id, amount * 1_000_000]);
          if (!dec.rowCount) throw new AppError(409, 'MONEY_IN_USE', 'This top-up was already spent on ads. Delete the business page permanently to erase it with everything else.');
        }
        if (p.purpose === 'membership') {
          await c.query(`UPDATE memberships SET current_period_end = current_period_end - interval '1 month' WHERE creator_id = $1 AND member_id = $2 AND status IN ('active','canceled')`, [p.creator_id, p.payer_id]);
          await c.query(`UPDATE memberships SET status = 'expired' WHERE creator_id = $1 AND member_id = $2 AND status IN ('active','canceled') AND current_period_end <= now()`, [p.creator_id, p.payer_id]);
        }
      }
      const { rows: txs } = await c.query<{ id: string }>('SELECT id FROM ledger_transactions WHERE reference_id = $1', [p.id]);
      await purgeTransactions(c, txs.map((t) => t.id), 'The creator already withdrew this money, so the payment can\'t be erased.');
      await c.query('DELETE FROM post_unlocks WHERE payment_id = $1', [p.id]);
      await c.query('DELETE FROM payment_webhook_events WHERE payment_id = $1', [p.id]);
      await c.query('DELETE FROM payments WHERE id = $1', [p.id]);
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'PAYMENT_DELETE', targetId: p.id, targetType: 'payment', metadata: { amount, currency: p.currency, purpose: p.purpose, status: p.status, provider: p.provider, ledgerTxs: txs.length, reason: why } }, c);
    });
    return { ok: true };
  },

  /** Staff refund inside the refund window (before earnings are released). Money is returned via the provider's dashboard. */
  async refund(actor: AuthUser, paymentId: string, reason: string) {
    let providerRefundId: string | null = null;
    await tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
      const p = rows[0];
      if (!p) throw notFound('Payment');
      if (p.status !== 'succeeded') throw badRequest('NOT_REFUNDABLE', 'Only successful payments can be refunded');
      if (p.released_at) throw badRequest('ALREADY_RELEASED', 'The refund window has passed — earnings were already released');
      const amount = Number(p.amount_minor);
      const fee = Number(p.fee_minor);
      if (p.purpose === 'ad_topup') {
        const bal = await c.query('SELECT available_micro FROM business_ad_balances WHERE business_id = $1 FOR UPDATE', [p.business_id]);
        if (Number(bal.rows[0]?.available_micro ?? 0) < amount * 1_000_000) throw badRequest('BALANCE_SPENT', 'This top-up has already been spent on ads');
      }
      // Send the money back through Stripe / SSLCommerz. If that fails, nothing is booked.
      providerRefundId = await refundAtProvider(p.provider, { paymentId: p.id, providerRef: p.provider_ref, amountMinor: amount, currency: p.currency, reason });
      if (p.purpose === 'ad_topup') {
        const dec = await c.query('UPDATE business_ad_balances SET available_micro = available_micro - $2 WHERE business_id = $1 AND available_micro >= $2', [p.business_id, amount * 1_000_000]);
        if (!dec.rowCount) throw badRequest('BALANCE_SPENT', 'This top-up has already been spent on ads');
        await book(c, { kind: 'refund', idempotencyKey: `refund:${p.id}`, currency: p.currency, referenceId: p.id, legs: [
          { account: acct.adBalance(p.business_id), amount },
          { account: acct.cash(p.provider), amount: -amount },
        ] });
      } else {
        await book(c, { kind: 'refund', idempotencyKey: `refund:${p.id}`, currency: p.currency, referenceId: p.id, legs: [
          { account: acct.pending(p.creator_id), amount: amount - fee },
          { account: acct.fees, amount: fee },
          { account: acct.cash(p.provider), amount: -amount },
        ] });
        if (p.purpose === 'unlock') await c.query('DELETE FROM post_unlocks WHERE payment_id = $1', [p.id]);
        if (p.purpose === 'membership') {
          await c.query(
            `UPDATE memberships SET current_period_end = current_period_end - interval '1 month'
              WHERE creator_id = $1 AND member_id = $2 AND status IN ('active','canceled')`,
            [p.creator_id, p.payer_id],
          );
          await c.query(`UPDATE memberships SET status = 'expired' WHERE creator_id = $1 AND member_id = $2 AND status IN ('active','canceled') AND current_period_end <= now()`, [p.creator_id, p.payer_id]);
        }
      }
      await c.query(`UPDATE payments SET status = 'refunded', updated_at = now() WHERE id = $1`, [p.id]);
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'PAYMENT_REFUND', targetId: p.id, targetType: 'payment', metadata: { amount, currency: p.currency, purpose: p.purpose, reason, provider: p.provider, providerRefundId } }, c);
    });
    return { ok: true };
  },
};

/** Ledger + side effects of a successful payment (inside the settle transaction). */
async function applySuccess(c: PoolClient, p: any, provider: ProviderName) {
  const amount = Number(p.amount_minor);
  const fee = Number(p.fee_minor);
  if (p.purpose === 'ad_topup') {
    await book(c, { kind: 'ad_topup', idempotencyKey: `pay:${p.id}`, currency: p.currency, referenceId: p.id, legs: [
      { account: acct.cash(provider), amount },
      { account: acct.adBalance(p.business_id), amount: -amount },
    ] });
    // Spendable balance in micro-units (impressions are charged in fractions of a poisha)
    await c.query(
      `INSERT INTO business_ad_balances (business_id, currency, available_micro) VALUES ($1, $2, $3)
       ON CONFLICT (business_id) DO UPDATE SET available_micro = business_ad_balances.available_micro + EXCLUDED.available_micro`,
      [p.business_id, p.currency, amount * 1_000_000],
    );
    return;
  }
  // Creator earnings: net to pending (refund window), fee to the platform
  await book(c, { kind: p.purpose, idempotencyKey: `pay:${p.id}`, currency: p.currency, referenceId: p.id, metadata: p.note ? { note: p.note } : {}, legs: [
    { account: acct.cash(provider), amount },
    { account: acct.pending(p.creator_id), amount: -(amount - fee) },
    { account: acct.fees, amount: -fee },
  ] });
  if (p.purpose === 'unlock') {
    await c.query('INSERT INTO post_unlocks (post_id, user_id, payment_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [p.post_id, p.payer_id, p.id]);
  }
  if (p.purpose === 'membership') {
    // Extend an existing membership (or start one) by one month from whichever is later: now or the current end
    const upd = await c.query(
      `UPDATE memberships SET tier_id = $3, status = 'active', canceled_at = NULL,
              current_period_end = GREATEST(current_period_end, now()) + interval '1 month'
        WHERE creator_id = $1 AND member_id = $2 AND status IN ('active','canceled')`,
      [p.creator_id, p.payer_id, p.tier_id],
    );
    if (!upd.rowCount) {
      await c.query(
        `INSERT INTO memberships (tier_id, creator_id, member_id, current_period_end) VALUES ($1, $2, $3, now() + interval '1 month')`,
        [p.tier_id, p.creator_id, p.payer_id],
      );
    }
  }
}

async function afterSuccess(paymentId: string) {
  const p = await one(
    `SELECT p.*, u.display_name AS payer_name FROM payments p LEFT JOIN users u ON u.id = p.payer_id WHERE p.id = $1`,
    [paymentId],
  );
  if (!p) return;
  if (p.payer_id) emit.user(p.payer_id, 'payment:updated', { id: p.id, status: 'succeeded' });
  if (p.creator_id) {
    const money = formatMoney(Number(p.amount_minor), p.currency);
    const msg = p.purpose === 'tip' ? `${p.payer_name} sent you a ${money} tip${p.note ? `: “${p.note}”` : ''}`
      : p.purpose === 'unlock' ? `${p.payer_name} unlocked your post (${money})`
      : `${p.payer_name} became a member (${money}/month)`;
    await notificationService.create({ userId: p.creator_id, type: 'system', actorId: p.payer_id, postId: p.post_id, message: msg });
    emit.user(p.creator_id, 'wallet:updated', { reason: p.purpose });
    if (p.purpose === 'tip') emit.user(p.creator_id, 'tip:received', { amountMinor: Number(p.amount_minor), currency: p.currency });
  }
}

// ── Background tasks (run by the worker) ──

/** Earnings leave the refund window: pending → available. */
export async function releaseHeldEarnings() {
  const { rows } = await query(
    `SELECT id FROM payments WHERE status = 'succeeded' AND released_at IS NULL AND creator_id IS NOT NULL
        AND succeeded_at < now() - ($1::int || ' days')::interval ORDER BY succeeded_at LIMIT 500`,
    [env.PAYOUT_HOLD_DAYS],
  );
  for (const { id } of rows) {
    await tx(async (c) => {
      const { rows: r } = await c.query(`SELECT * FROM payments WHERE id = $1 AND status = 'succeeded' AND released_at IS NULL FOR UPDATE`, [id]);
      const p = r[0];
      if (!p) return;
      const net = Number(p.amount_minor) - Number(p.fee_minor);
      if (net > 0) {
        await book(c, { kind: 'release', idempotencyKey: `release:${p.id}`, currency: p.currency, referenceId: p.id, legs: [
          { account: acct.pending(p.creator_id), amount: net },
          { account: acct.available(p.creator_id), amount: -net },
        ] });
      }
      await c.query('UPDATE payments SET released_at = now() WHERE id = $1', [p.id]);
    });
  }
  return rows.length;
}

/** Abandoned checkouts. */
export async function expireStaleCheckouts() {
  const r = await query(`UPDATE payments SET status = 'expired', updated_at = now() WHERE status = 'created' AND created_at < now() - interval '3 hours'`);
  return r.rowCount ?? 0;
}

/** Memberships past their paid period end. */
export async function expireMemberships() {
  const { rows } = await query(
    `UPDATE memberships SET status = 'expired' WHERE status IN ('active','canceled') AND current_period_end < now() RETURNING member_id, creator_id`,
  );
  for (const m of rows) {
    await notificationService.create({ userId: m.member_id, type: 'system', actorId: m.creator_id, message: 'Your membership ended. Renew it any time from their profile.' }).catch(() => {});
  }
  return rows.length;
}
