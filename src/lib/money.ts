// Money helpers. Amounts are ALWAYS integer cents (US dollars) as bigint-safe numbers.
import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { aesDecrypt, aesEncrypt, hmacHex } from './crypto.js';
import { badRequest } from './errors.js';

export type Currency = 'USD';
export const CURRENCIES: Currency[] = ['USD'];

/** Largest single amount we accept anywhere ($100,000) — a sanity cap against fat-finger and overflow bugs. */
export const MAX_AMOUNT_MINOR = 10_000_000;

export function assertAmount(minor: number, what = 'Amount') {
  if (!Number.isSafeInteger(minor) || minor <= 0) throw badRequest('BAD_AMOUNT', `${what} must be a positive whole number of minor units`);
  if (minor > MAX_AMOUNT_MINOR) throw badRequest('AMOUNT_TOO_LARGE', `${what} is too large`);
}

/** Platform fee in minor units (rounded down, so creators never lose a fraction). */
export function platformFee(amountMinor: number) {
  return Math.floor((amountMinor * env.PLATFORM_FEE_BPS) / 10_000);
}

export function formatMoney(minor: number, _currency: Currency = 'USD') {
  return `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Encryption for payout details and KYC numbers ──
// Separate key if configured; otherwise a sub-key derived from IDENTITY_ENC_KEY so the two never share raw key material.
const FINANCE_KEY = env.FINANCE_ENC_KEY ?? createHash('sha256').update(hmacHex(env.IDENTITY_ENC_KEY, 'dualsphere/finance/v1')).digest('hex');

export const financeCrypto = {
  encrypt: (plain: string) => aesEncrypt(plain, FINANCE_KEY),
  decrypt: (payload: string) => aesDecrypt(payload, FINANCE_KEY),
};

/** "01712345678" → "••••5678" */
export const maskTail = (s: string, keep = 4) => `••••${s.replace(/\s+/g, '').slice(-keep)}`;
