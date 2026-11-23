// ═══════════════════════════════════════════════════════════════
// Payment providers. A provider only (1) starts a checkout and (2) turns a provider callback into a VERIFIED result.
// Nothing the browser sends is trusted: Stripe events are signature-checked; SSLCommerz IPNs are re-validated
// server-to-server with the validation API. The payment service then checks amount + currency against our record.
//
// Providers: Stripe (cards) and SSLCommerz (cards, mobile banking, net banking). "test" works locally only, never in
// production. Each switches on when its keys are set. Everything is charged in US dollars.
// ═══════════════════════════════════════════════════════════════
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env, paymentsTestMode } from '../config/env.js';
import { AppError, badRequest } from './errors.js';
import type { Currency } from './money.js';

export type ProviderName = 'test' | 'stripe' | 'sslcommerz';

export interface CheckoutInput {
  paymentId: string;
  amountMinor: number;
  currency: Currency;
  description: string;
  customer: { name: string; email: string; phone?: string };
}

export interface VerifiedResult {
  paymentId: string;
  eventId: string; // unique per provider event → exactly-once processing
  providerRef: string | null;
  outcome: 'succeeded' | 'failed';
  amountMinor: number;
  currency: Currency;
}

const API = () => env.PUBLIC_API_URL.replace(/\/$/, '');
const WEB = () => env.FRONTEND_URL.replace(/\/$/, '');
const resultUrl = (paymentId: string, outcome: string) => `${WEB()}/checkout/result?payment=${paymentId}&outcome=${outcome}`;

export function configuredProviders(currency: Currency): ProviderName[] {
  const list: ProviderName[] = [];
  if (env.SSLCOMMERZ_STORE_ID && env.SSLCOMMERZ_STORE_PASSWORD && currency === 'USD') list.push('sslcommerz');
  if (env.STRIPE_SECRET_KEY) list.push('stripe'); // webhook secret optional: confirmSession() asks Stripe directly
  if (paymentsTestMode) list.push('test');
  return list;
}

export function assertProvider(p: ProviderName, currency: Currency) {
  if (!configuredProviders(currency).includes(p)) {
    throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'This payment method isn\'t available right now');
  }
}

// ── Start checkout ──

export async function startCheckout(provider: ProviderName, input: CheckoutInput): Promise<{ redirectUrl: string; providerRef: string | null }> {
  if (provider === 'test') {
    if (!paymentsTestMode) throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'Test payments are off');
    return { redirectUrl: `${WEB()}/checkout/test/${input.paymentId}`, providerRef: `test_${input.paymentId}` };
  }
  if (provider === 'stripe') return stripeCheckout(input);
  if (provider === 'sslcommerz') return sslcommerzCheckout(input);
  throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'This payment method isn\'t connected yet');
}

async function stripeCheckout(i: CheckoutInput) {
  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][price_data][currency]': i.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(i.amountMinor),
    'line_items[0][price_data][product_data][name]': i.description.slice(0, 120),
    'line_items[0][quantity]': '1',
    client_reference_id: i.paymentId,
    'metadata[payment_id]': i.paymentId,
    customer_email: i.customer.email,
    success_url: `${resultUrl(i.paymentId, 'processing')}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: resultUrl(i.paymentId, 'canceled'),
    expires_at: String(Math.floor(Date.now() / 1000) + 60 * 60),
  });
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `checkout-${i.paymentId}` },
    body: form,
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json?.url) throw new AppError(502, 'PROVIDER_ERROR', 'Could not start the payment. Try again.');
  return { redirectUrl: json.url as string, providerRef: json.id as string };
}

const SSL_BASE = () => (env.SSLCOMMERZ_SANDBOX === 'true' ? 'https://sandbox.sslcommerz.com' : 'https://securepay.sslcommerz.com');

async function sslcommerzCheckout(i: CheckoutInput) {
  const form = new URLSearchParams({
    store_id: env.SSLCOMMERZ_STORE_ID!,
    store_passwd: env.SSLCOMMERZ_STORE_PASSWORD!,
    total_amount: (i.amountMinor / 100).toFixed(2),
    currency: i.currency,
    tran_id: i.paymentId,
    success_url: `${API()}/api/v1/payments/return/sslcommerz`,
    fail_url: `${API()}/api/v1/payments/return/sslcommerz`,
    cancel_url: `${API()}/api/v1/payments/return/sslcommerz`,
    ipn_url: `${API()}/api/v1/payments/webhooks/sslcommerz`,
    cus_name: i.customer.name.slice(0, 50) || 'DualSphere user',
    cus_email: i.customer.email,
    // SSLCommerz requires these; the phone comes from the buyer at checkout and is not stored by us
    cus_add1: 'Online purchase', cus_city: 'N/A', cus_country: 'N/A', cus_phone: i.customer.phone ?? '',
    shipping_method: 'NO', num_of_item: '1',
    product_name: i.description.slice(0, 100), product_category: 'digital', product_profile: 'non-physical-goods',
  });
  const res = await fetch(`${SSL_BASE()}/gwprocess/v4/api.php`, { method: 'POST', body: form });
  const json: any = await res.json().catch(() => null);
  if (!res.ok || json?.status !== 'SUCCESS' || !json?.GatewayPageURL) throw new AppError(502, 'PROVIDER_ERROR', 'Could not start the payment. Try again.');
  return { redirectUrl: json.GatewayPageURL as string, providerRef: (json.sessionkey as string) ?? null };
}

// ── Verify callbacks ──

/** Stripe: verify the Stripe-Signature header over the RAW body (5-minute tolerance), then read the event. */
export function verifyStripe(raw: Buffer, header: string | undefined): VerifiedResult | null {
  if (!env.STRIPE_WEBHOOK_SECRET || !header) throw badRequest('BAD_SIGNATURE', 'Missing signature');
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  const t = Number(parts.t);
  const sigs = header.split(',').filter((kv) => kv.startsWith('v1=')).map((kv) => kv.slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > 300) throw badRequest('BAD_SIGNATURE', 'Stale or malformed signature');
  const expected = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${t}.${raw.toString('utf8')}`).digest('hex');
  const ok = sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) throw badRequest('BAD_SIGNATURE', 'Signature mismatch');

  const event = JSON.parse(raw.toString('utf8'));
  const s = event?.data?.object;
  const paymentId = s?.metadata?.payment_id ?? s?.client_reference_id;
  if (!paymentId) return null;
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    if (s.payment_status !== 'paid') return null;
    return { paymentId, eventId: event.id, providerRef: s.id, outcome: 'succeeded', amountMinor: Number(s.amount_total), currency: String(s.currency).toUpperCase() as Currency };
  }
  if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
    return { paymentId, eventId: event.id, providerRef: s.id, outcome: 'failed', amountMinor: Number(s.amount_total ?? 0), currency: String(s.currency ?? 'usd').toUpperCase() as Currency };
  }
  return null; // other events are ignored
}

/**
 * Stripe without webhooks (e.g. on localhost): retrieve the Checkout Session from Stripe's API with our secret key.
 * The answer comes straight from Stripe over TLS, so it's as trustworthy as a signed webhook.
 */
export async function confirmStripeSession(paymentId: string, sessionId: string): Promise<VerifiedResult | null> {
  if (!env.STRIPE_SECRET_KEY || !/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) return null;
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!res.ok) return null;
  const s: any = await res.json();
  const pid = s?.metadata?.payment_id ?? s?.client_reference_id;
  if (pid !== paymentId) return null; // a session for some other payment can't settle this one
  if (s.payment_status === 'paid') {
    return { paymentId, eventId: `session:${s.id}`, providerRef: s.id, outcome: 'succeeded', amountMinor: Number(s.amount_total), currency: String(s.currency).toUpperCase() as Currency };
  }
  if (s.status === 'expired') {
    return { paymentId, eventId: `session-expired:${s.id}`, providerRef: s.id, outcome: 'failed', amountMinor: 0, currency: String(s.currency).toUpperCase() as Currency };
  }
  return null; // still open / processing
}

/** SSLCommerz: never trust the posted fields — re-validate val_id with SSLCommerz's validation API. */
export async function verifySslcommerz(fields: Record<string, string>): Promise<VerifiedResult | null> {
  const tranId = fields.tran_id;
  if (!tranId || !/^[0-9a-f-]{36}$/i.test(tranId)) return null;
  if (!fields.val_id) {
    // FAILED / CANCELLED callbacks carry no val_id
    return { paymentId: tranId, eventId: `nv:${tranId}:${fields.status ?? 'failed'}`, providerRef: null, outcome: 'failed', amountMinor: 0, currency: 'USD' };
  }
  const url = new URL(`${SSL_BASE()}/validator/api/validationserverAPI.php`);
  url.search = new URLSearchParams({ val_id: fields.val_id, store_id: env.SSLCOMMERZ_STORE_ID!, store_passwd: env.SSLCOMMERZ_STORE_PASSWORD!, format: 'json' }).toString();
  const res = await fetch(url);
  const v: any = await res.json().catch(() => null);
  if (!v || !['VALID', 'VALIDATED'].includes(v.status) || v.tran_id !== tranId) {
    return { paymentId: tranId, eventId: `val:${fields.val_id}`, providerRef: fields.val_id, outcome: 'failed', amountMinor: 0, currency: 'USD' };
  }
  return {
    paymentId: tranId, eventId: `val:${fields.val_id}`, providerRef: v.bank_tran_id ?? fields.val_id, outcome: 'succeeded',
    amountMinor: Math.round(Number(v.currency_amount ?? v.amount) * 100), currency: String(v.currency_type ?? v.currency).toUpperCase() as Currency,
  };
}

// ── Refunds through the provider (called inside the locked refund transaction; nothing is booked if this throws) ──

export async function refundAtProvider(
  provider: string,
  r: { paymentId: string; providerRef: string | null; amountMinor: number; currency: string; reason: string },
): Promise<string | null> {
  if (provider === 'test') return `test_refund_${r.paymentId}`;
  if (!r.providerRef) throw new AppError(409, 'NO_PROVIDER_REF', 'This payment has no provider reference — refund it in the provider dashboard');

  if (provider === 'stripe') {
    if (!env.STRIPE_SECRET_KEY) throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'Stripe is not configured');
    // provider_ref is the Checkout Session; the refund goes against its PaymentIntent
    const s = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(r.providerRef)}`, { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
    const session: any = await s.json().catch(() => null);
    const pi = typeof session?.payment_intent === 'string' ? session.payment_intent : session?.payment_intent?.id;
    if (!s.ok || !pi) throw new AppError(502, 'PROVIDER_ERROR', 'Could not find the Stripe payment to refund');
    const res = await fetch('https://api.stripe.com/v1/refunds', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `refund-${r.paymentId}` },
      body: new URLSearchParams({ payment_intent: pi, amount: String(r.amountMinor), reason: 'requested_by_customer', 'metadata[payment_id]': r.paymentId }),
    });
    const refund: any = await res.json().catch(() => null);
    if (!res.ok || !refund?.id || refund.status === 'failed' || refund.status === 'canceled') {
      throw new AppError(502, 'PROVIDER_ERROR', refund?.error?.message ? `Stripe: ${refund.error.message}` : 'Stripe refused the refund');
    }
    return refund.id as string;
  }

  if (provider === 'sslcommerz') {
    if (!env.SSLCOMMERZ_STORE_ID || !env.SSLCOMMERZ_STORE_PASSWORD) throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'SSLCommerz is not configured');
    // provider_ref is SSLCommerz's bank_tran_id (stored when the payment was validated)
    const url = new URL(`${SSL_BASE()}/validator/api/merchantTransIDvalidationAPI.php`);
    url.search = new URLSearchParams({
      bank_tran_id: r.providerRef, refund_amount: (r.amountMinor / 100).toFixed(2), refund_remarks: r.reason.slice(0, 100),
      refe_id: r.paymentId, store_id: env.SSLCOMMERZ_STORE_ID, store_passwd: env.SSLCOMMERZ_STORE_PASSWORD, v: '1', format: 'json',
    }).toString();
    const res = await fetch(url);
    const j: any = await res.json().catch(() => null);
    if (!res.ok || !j || !['success', 'processing'].includes(String(j.status).toLowerCase())) {
      throw new AppError(502, 'PROVIDER_ERROR', `SSLCommerz refused the refund${j?.errorReason ? `: ${j.errorReason}` : ''}`);
    }
    return (j.refund_ref_id as string) ?? null;
  }
  throw new AppError(400, 'UNKNOWN_PROVIDER', 'Unknown payment provider');
}
