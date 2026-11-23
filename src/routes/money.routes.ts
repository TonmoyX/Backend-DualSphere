// /creators, /wallet, /payments — Creator Economy (Phase 2).
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { env, paymentsTestMode } from '../config/env.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { confirmStripeSession, verifySslcommerz, verifyStripe } from '../lib/payment-providers.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { paymentLimiter } from '../middleware/rateLimit.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { one } from '../config/db.js';
import { creatorService } from '../services/creator.service.js';
import { acct, history, userBalances } from '../services/ledger.service.js';
import { paymentService } from '../services/payment.service.js';
import { payoutService } from '../services/payout.service.js';
import * as v from '../validators/index.js';

const uuid = z.string().uuid();
const currency = z.literal('USD');

// ── /creators ──
export const creatorRoutes = Router();
creatorRoutes.get('/me', requireAuth, async (req, res) => res.json(await creatorService.me(req.user!)));
creatorRoutes.post('/me', requireAuth, validate({ body: z.object({ tagline: z.string().trim().max(140).optional() }) }), async (req, res) => {
  res.json(await creatorService.become(req.user!, req.body));
});
creatorRoutes.patch('/me', requireAuth, validate({ body: z.object({ tagline: z.string().trim().max(140).optional(), tipsEnabled: z.boolean().optional(), isActive: z.boolean().optional() }).strict() }), async (req, res) => {
  res.json(await creatorService.updateProfile(req.user!, req.body));
});
creatorRoutes.get('/me/dashboard', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json(await creatorService.dashboard(req.user!));
});
const tierBody = z.object({
  name: z.string().trim().min(2).max(40),
  description: z.string().trim().max(500).default(''),
  benefits: z.array(z.string().trim().min(1).max(80)).max(8).default([]),
  priceMinor: z.number().int().positive().max(100_000_000),
}).strict();
creatorRoutes.post('/me/tiers', requireAuth, validate({ body: tierBody }), async (req, res) => res.status(201).json(await creatorService.createTier(req.user!, req.body)));
creatorRoutes.patch('/me/tiers/:id', requireAuth, validate({ params: v.idParam, body: tierBody.partial().extend({ isActive: z.boolean().optional() }).strict() }), async (req, res) => {
  res.json(await creatorService.updateTier(req.user!, req.validated!.params.id, req.body));
});
creatorRoutes.get('/memberships', requireAuth, async (req, res) => res.json(await creatorService.myMemberships(req.user!)));
creatorRoutes.post('/memberships/:id/cancel', requireAuth, validate({ params: v.idParam }), async (req, res) => {
  res.json(await creatorService.cancelMembership(req.user!, req.validated!.params.id));
});
creatorRoutes.get('/:username', validate({ params: z.object({ username: v.username }) }), async (req, res) => {
  res.json(await creatorService.publicInfo(req.validated!.params.username, req.user));
});

// ── /wallet ──
export const walletRoutes = Router();
walletRoutes.use(requireAuth, (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
walletRoutes.get('/', async (req, res) => {
  const u = req.user!;
  const businesses = (await import('../services/business.service.js')).businessService;
  res.json({
    balances: await userBalances(u.id),
    history: await history([acct.pending(u.id), acct.available(u.id), acct.payoutHold(u.id)], 100),
    adAccounts: await businesses.myAdBalances(u),
    holdDays: env.PAYOUT_HOLD_DAYS,
    feeBps: env.PLATFORM_FEE_BPS,
  });
});
walletRoutes.get('/methods', async (req, res) => res.json(await payoutService.methods(req.user!)));
walletRoutes.post('/methods', paymentLimiter, validate({ body: z.object({
  type: z.literal('bank').default('bank'),
  accountNumber: z.string().trim().min(6).max(40),
  accountName: z.string().trim().min(2).max(80),
  bankName: z.string().trim().min(2).max(80),
  branch: z.string().trim().max(80).optional(),
  swift: z.string().trim().max(15).optional(),
  routingNumber: z.string().trim().max(12).optional(),
  country: z.string().trim().max(60).optional(),
}).strict() }), async (req, res) => res.status(201).json(await payoutService.addMethod(req.user!, req.body)));
walletRoutes.delete('/methods/:id', validate({ params: v.idParam }), async (req, res) => res.json(await payoutService.removeMethod(req.user!, req.validated!.params.id)));
walletRoutes.get('/kyc', async (req, res) => res.json(await payoutService.kyc(req.user!)));
walletRoutes.post('/kyc', paymentLimiter, validate({ body: z.object({
  legalName: z.string().trim().min(3).max(100),
  idType: z.enum(['nid', 'passport', 'driving_license']),
  idNumber: z.string().trim().min(6).max(30),
}).strict() }), async (req, res) => res.json(await payoutService.submitKyc(req.user!, req.body)));
walletRoutes.get('/payouts', async (req, res) => res.json(await payoutService.list(req.user!)));
walletRoutes.post('/payouts', paymentLimiter, validate({ body: z.object({ methodId: uuid, amountMinor: z.number().int().positive(), currency }).strict() }), async (req, res) => {
  res.status(201).json(await payoutService.request(req.user!, req.body));
});

// ── /payments ──
export const paymentRoutes = Router();
paymentRoutes.get('/providers', validate({ query: z.object({ currency: currency.default(env.DEFAULT_CURRENCY) }) }), (req, res) => {
  res.json(paymentService.providers(req.validated!.query.currency));
});
paymentRoutes.post('/', requireAuth, paymentLimiter, validate({ body: z.object({
  purpose: z.enum(['tip', 'unlock', 'membership', 'ad_topup']),
  provider: z.enum(['test', 'stripe', 'sslcommerz']),
  creatorId: uuid.optional(),
  postId: uuid.optional(),
  tierId: uuid.optional(),
  businessId: uuid.optional(),
  amountMinor: z.number().int().positive().max(100_000_000).optional(),
  currency: currency.optional(),
  note: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(20).optional(),
}).strict() }), async (req, res) => {
  res.status(201).json(await paymentService.create(req.user!, req.body));
});
paymentRoutes.get('/:id', requireAuth, validate({ params: v.idParam }), async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json(await paymentService.status(req.user!, req.validated!.params.id));
});

// Back from Stripe Checkout: confirm with Stripe's API (works without webhooks). Only the payer, only their own payment.
paymentRoutes.post('/:id/confirm', requireAuth, paymentLimiter, validate({ params: v.idParam }), async (req, res) => {
  const p = await one(`SELECT id, payer_id, provider, provider_ref, status FROM payments WHERE id = $1`, [req.validated!.params.id]);
  if (!p || p.payer_id !== req.user!.id) throw notFound('Payment');
  if (p.status !== 'created') return res.json({ status: p.status });
  if (p.provider !== 'stripe' || !p.provider_ref) return res.json({ status: p.status });
  const r = await confirmStripeSession(p.id, p.provider_ref); // the session id WE stored, not one from the URL
  if (!r) return res.json({ status: 'created' });
  res.json({ status: await paymentService.settle('stripe', r) });
});

// Local test checkout: the payer confirms or cancels. Same settlement path as a real provider. Never in production.
paymentRoutes.post('/test/:id/complete', requireAuth, validate({ params: v.idParam, body: z.object({ outcome: z.enum(['succeeded', 'failed']) }) }), async (req, res) => {
  if (!paymentsTestMode) throw notFound('Route');
  const p = await one(`SELECT id, payer_id, amount_minor, currency, provider FROM payments WHERE id = $1`, [req.validated!.params.id]);
  if (!p || p.payer_id !== req.user!.id) throw notFound('Payment');
  if (p.provider !== 'test') throw forbidden('NOT_TEST', 'Not a test payment');
  const status = await paymentService.settle('test', {
    paymentId: p.id, eventId: `test:${p.id}`, providerRef: `test_${p.id}`, outcome: req.body.outcome,
    amountMinor: Number(p.amount_minor), currency: p.currency,
  });
  res.json({ status });
});

// SSLCommerz sends the shopper's browser back here (form POST); we re-validate, then redirect to the site
paymentRoutes.post('/return/sslcommerz', express.urlencoded({ extended: false, limit: '20kb' }), async (req: Request, res: Response) => {
  const fields = req.body as Record<string, string>;
  let outcome = 'failed';
  try {
    const r = await verifySslcommerz(fields);
    if (r) outcome = await paymentService.settle('sslcommerz', r);
  } catch (err) {
    logger.error({ err }, 'sslcommerz return failed');
  }
  const id = /^[0-9a-f-]{36}$/i.test(fields.tran_id ?? '') ? fields.tran_id : '';
  res.redirect(303, `${env.FRONTEND_URL}/checkout/result?payment=${id}&outcome=${outcome === 'succeeded' || outcome === 'duplicate' ? 'processing' : 'failed'}`);
});

/** Provider webhooks. Mounted in app.ts BEFORE express.json so the raw body is available for signature checks. */
export async function paymentWebhook(req: Request, res: Response) {
  const provider = req.params.provider;
  try {
    if (provider === 'stripe') {
      const r = verifyStripe(req.body as Buffer, req.headers['stripe-signature'] as string | undefined);
      if (r) await paymentService.settle('stripe', r);
      return res.json({ received: true });
    }
    if (provider === 'sslcommerz') {
      const fields = Object.fromEntries(new URLSearchParams((req.body as Buffer).toString('utf8')));
      const r = await verifySslcommerz(fields);
      if (r) await paymentService.settle('sslcommerz', r);
      return res.json({ received: true });
    }
    throw badRequest('UNKNOWN_PROVIDER', 'Unknown provider');
  } catch (err: any) {
    logger.warn({ provider, err: err?.message }, 'payment webhook rejected');
    return res.status(err?.status ?? 400).json({ error: { code: err?.code ?? 'WEBHOOK_REJECTED' } });
  }
}
