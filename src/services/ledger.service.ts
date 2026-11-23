// ═══════════════════════════════════════════════════════════════
// Double-entry ledger. The ONLY code that writes ledger_entries.
//  • Every movement is one transaction; its entries must sum to zero (enforced again by a DB trigger at commit).
//  • Every transaction has an idempotency key (UNIQUE): replaying a webhook or retrying a job can't double-book.
//  • Entries are append-only (DB triggers). Corrections are new, reversing transactions.
//    Single exception: an admin's permanent delete (purgeTransactions) removes whole transactions.
// ═══════════════════════════════════════════════════════════════
import type { PoolClient } from 'pg';
import { one, query } from '../config/db.js';
import { AppError } from '../lib/errors.js';
import type { Currency } from '../lib/money.js';

export interface Leg { account: string; amount: number } // amount > 0 debit, < 0 credit

export const acct = {
  cash: (provider: string) => `cash:${provider}`,
  pending: (userId: string) => `user:${userId}:pending`,
  available: (userId: string) => `user:${userId}:available`,
  payoutHold: (userId: string) => `user:${userId}:payout_hold`,
  adBalance: (businessId: string) => `business:${businessId}:ad_balance`,
  fees: 'platform:fees',
  adRevenue: 'platform:ad_revenue',
  payoutsSent: 'payouts:sent',
};

/**
 * Book a transaction inside the caller's DB transaction. Returns false if this idempotency key was already booked
 * (the caller should treat that as "already done", not as an error).
 */
export async function book(
  c: PoolClient,
  t: { kind: string; idempotencyKey: string; currency: Currency; legs: Leg[]; referenceId?: string | null; metadata?: Record<string, unknown> },
): Promise<boolean> {
  const legs = t.legs.filter((l) => l.amount !== 0);
  if (legs.length < 2) throw new Error('ledger: a transaction needs at least two legs');
  if (legs.some((l) => !Number.isSafeInteger(l.amount))) throw new Error('ledger: amounts must be integers');
  if (legs.reduce((s, l) => s + l.amount, 0) !== 0) throw new Error('ledger: transaction does not balance');

  const ins = await c.query(
    `INSERT INTO ledger_transactions (kind, idempotency_key, reference_id, metadata) VALUES ($1, $2, $3, $4)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [t.kind, t.idempotencyKey, t.referenceId ?? null, JSON.stringify(t.metadata ?? {})],
  );
  if (!ins.rowCount) return false;
  const txId = ins.rows[0].id as string;
  for (const l of legs) {
    await c.query('INSERT INTO ledger_entries (tx_id, account, amount_minor, currency) VALUES ($1, $2, $3, $4)', [txId, l.account, l.amount, t.currency]);
  }
  return true;
}

/**
 * Admin "delete permanently": remove whole ledger transactions (every leg, so the books still balance).
 * Only this function may delete ledger rows (DB trigger allows it only with the purge flag set in this transaction).
 * Refuses if a user's or business's balance would go below zero — i.e. the money was already spent or withdrawn.
 */
export async function purgeTransactions(c: PoolClient, txIds: string[], inUseMessage: string) {
  if (!txIds.length) return 0;
  const { rows: touched } = await c.query<{ account: string }>('SELECT DISTINCT account FROM ledger_entries WHERE tx_id = ANY($1::uuid[])', [txIds]);
  await c.query(`SET LOCAL dualsphere.ledger_purge = 'on'`);
  await c.query('DELETE FROM ledger_entries WHERE tx_id = ANY($1::uuid[])', [txIds]);
  const del = await c.query('DELETE FROM ledger_transactions WHERE id = ANY($1::uuid[])', [txIds]);
  await c.query(`SET LOCAL dualsphere.ledger_purge = 'off'`);
  const wallets = touched.map((t) => t.account).filter((a) => /^(user|business):/.test(a));
  if (wallets.length) {
    const neg = await c.query('SELECT 1 FROM ledger_entries WHERE account = ANY($1::text[]) GROUP BY account, currency HAVING sum(amount_minor) > 0 LIMIT 1', [wallets]);
    if (neg.rowCount) throw new AppError(409, 'MONEY_IN_USE', inUseMessage);
  }
  return del.rowCount ?? 0;
}

/** Balance of a credit-normal (liability) account, e.g. a user's wallet: credits minus debits. */
export async function liabilityBalance(account: string, currency: Currency, c?: PoolClient) {
  const sql = 'SELECT COALESCE(-sum(amount_minor), 0)::bigint AS b FROM ledger_entries WHERE account = $1 AND currency = $2';
  const r = c ? (await c.query(sql, [account, currency])).rows[0] : await one(sql, [account, currency]);
  return Number(r?.b ?? 0);
}

/** Lock-free read of all of a user's creator balances per currency. */
export async function userBalances(userId: string) {
  const { rows } = await query(
    `SELECT currency,
            COALESCE(-sum(amount_minor) FILTER (WHERE account = $1), 0)::bigint AS pending,
            COALESCE(-sum(amount_minor) FILTER (WHERE account = $2), 0)::bigint AS available,
            COALESCE(-sum(amount_minor) FILTER (WHERE account = $3), 0)::bigint AS payout_hold
       FROM ledger_entries WHERE account IN ($1, $2, $3) GROUP BY currency`,
    [acct.pending(userId), acct.available(userId), acct.payoutHold(userId)],
  );
  return rows.map((r) => ({ currency: r.currency as Currency, pending: Number(r.pending), available: Number(r.available), payoutHold: Number(r.payout_hold) }));
}

/** Serialise concurrent money moves on one account (e.g. two payout requests at once). */
export async function lockAccount(c: PoolClient, account: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [account]);
}

/** Entries touching any of these accounts, newest first (wallet history). */
export async function history(accounts: string[], limit = 100) {
  const { rows } = await query(
    `SELECT e.id, e.account, e.amount_minor, e.currency, e.created_at, t.kind, t.reference_id, t.metadata
       FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.tx_id
      WHERE e.account = ANY($1::text[]) ORDER BY e.id DESC LIMIT $2`,
    [accounts, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id), account: r.account as string, amountMinor: -Number(r.amount_minor), currency: r.currency as Currency,
    kind: r.kind as string, referenceId: r.reference_id as string | null, createdAt: r.created_at, note: (r.metadata?.note as string | undefined) ?? null,
  }));
}
