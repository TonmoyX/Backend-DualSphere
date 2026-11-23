// ═══════════════════════════════════════════════════════════════
// Payouts out of the platform + KYC + payout methods.
//  • Account numbers and ID numbers are encrypted at rest; owners only ever see a masked label.
//  • KYC must be verified before any payout. One open payout request at a time.
//  • Requesting moves money available → payout_hold under an advisory lock (no double-spend from parallel requests).
//  • Staff approve and mark paid (payouts.approve); above the threshold only an admin can. Every step is audited.
//  • Transfers are bank transfers made by staff; the transfer reference is recorded here.
// ═══════════════════════════════════════════════════════════════
import { one, query, tx } from '../config/db.js';
import { env } from '../config/env.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { assertAmount, type Currency, financeCrypto, formatMoney, maskTail } from '../lib/money.js';
import { cleanText } from '../lib/text.js';
import type { AuthUser } from '../types/index.js';
import { auditService } from './audit.service.js';
import { acct, book, liabilityBalance, lockAccount, purgeTransactions } from './ledger.service.js';
import { notificationService } from './notification.service.js';

type MethodType = 'bank';
const MAX_METHODS = 5;
const TYPE_LABEL: Record<MethodType, string> = { bank: 'Bank' };

const payoutOut = (p: any) => ({
  id: p.id, amountMinor: Number(p.amount_minor), currency: p.currency, status: p.status, createdAt: p.created_at,
  reviewedAt: p.reviewed_at, providerRef: p.provider_ref, rejectReason: p.reject_reason, methodLabel: p.method_label, holdReason: p.hold_reason ?? null,
});

const OPEN = `('requested','approved','on_hold')`;

export const payoutService = {
  // ── Methods ──
  async methods(user: AuthUser) {
    const { rows } = await query('SELECT id, type, label, is_default, created_at FROM payout_methods WHERE user_id = $1 ORDER BY created_at', [user.id]);
    return { methods: rows.map((m) => ({ id: m.id, type: m.type, label: m.label, isDefault: m.is_default, createdAt: m.created_at })) };
  },

  async addMethod(user: AuthUser, input: { type: MethodType; accountNumber: string; accountName: string; bankName?: string; branch?: string; swift?: string; routingNumber?: string; country?: string }) {
    const n = await one<{ n: number }>('SELECT count(*)::int AS n FROM payout_methods WHERE user_id = $1', [user.id]);
    if ((n?.n ?? 0) >= MAX_METHODS) throw badRequest('METHOD_LIMIT', `Up to ${MAX_METHODS} payout methods`);
    const number = input.accountNumber.replace(/[\s-]/g, '');
    if (!/^[A-Za-z0-9]{6,34}$/.test(number)) throw badRequest('BAD_NUMBER', 'Enter a valid account number or IBAN');
    if (!input.bankName) throw badRequest('BANK_REQUIRED', 'Enter the bank name');
    const swift = input.swift?.replace(/\s/g, '').toUpperCase();
    if (swift && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(swift)) throw badRequest('BAD_SWIFT', 'Enter a valid SWIFT/BIC code (8 or 11 characters)');
    const routing = input.routingNumber?.replace(/\s/g, '');
    if (routing && !/^\d{9}$/.test(routing)) throw badRequest('BAD_ROUTING', 'A US routing number has 9 digits');
    const details = {
      accountNumber: number, accountName: cleanText(input.accountName).slice(0, 80), bankName: cleanText(input.bankName).slice(0, 80),
      branch: input.branch ? cleanText(input.branch).slice(0, 80) : undefined, swift: swift || undefined, routingNumber: routing || undefined,
      country: input.country ? cleanText(input.country).slice(0, 60) : undefined,
    };
    const label = `${TYPE_LABEL[input.type]}${input.bankName ? ` · ${details.bankName}` : ''} ${maskTail(number)}`;
    await query(
      `INSERT INTO payout_methods (user_id, type, details_enc, label, is_default) VALUES ($1, $2, $3, $4, $5)`,
      [user.id, input.type, financeCrypto.encrypt(JSON.stringify(details)), label, (n?.n ?? 0) === 0],
    );
    return this.methods(user);
  },

  async removeMethod(user: AuthUser, methodId: string) {
    const open = await one(`SELECT 1 FROM payouts WHERE method_id = $1 AND status IN ${OPEN}`, [methodId]);
    if (open) throw badRequest('METHOD_IN_USE', 'This method has a payout in progress');
    const used = await one('SELECT 1 FROM payouts WHERE method_id = $1', [methodId]);
    // Methods used by past payouts are kept for the record (FK), only unlinked from the owner's list by masking
    if (used) throw badRequest('METHOD_HAS_HISTORY', 'This method was used for past payouts and is kept for your records');
    const r = await query('DELETE FROM payout_methods WHERE id = $1 AND user_id = $2', [methodId, user.id]);
    if (!r.rowCount) throw notFound('Payout method');
    return this.methods(user);
  },

  // ── KYC ──
  async kyc(user: AuthUser) {
    const k = await one('SELECT legal_name, id_type, id_last4, status, notes, submitted_at, reviewed_at FROM kyc_records WHERE user_id = $1', [user.id]);
    return { kyc: k ? { legalName: k.legal_name, idType: k.id_type, idLast4: k.id_last4, status: k.status, notes: ['rejected', 'on_hold', 'suspended'].includes(k.status) ? k.notes : null, submittedAt: k.submitted_at, reviewedAt: k.reviewed_at } : null };
  },

  async submitKyc(user: AuthUser, input: { legalName: string; idType: 'nid' | 'passport' | 'driving_license'; idNumber: string }) {
    const cp = await one('SELECT kyc_status FROM creator_profiles WHERE user_id = $1', [user.id]);
    if (!cp) throw forbidden('NOT_CREATOR', 'Turn on creator tools first');
    if (cp.kyc_status === 'verified') throw conflict('KYC_VERIFIED', 'Your identity is already verified');
    if (cp.kyc_status === 'on_hold' || cp.kyc_status === 'suspended') throw forbidden('KYC_LOCKED', 'Your identity check is under review by DualSphere — contact support');
    const idn = input.idNumber.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-Z0-9]{6,20}$/.test(idn)) throw badRequest('BAD_ID', 'Enter the ID number as shown on the document');
    await tx(async (c) => {
      await c.query(
        `INSERT INTO kyc_records (user_id, legal_name, id_type, id_number_enc, id_last4, status, submitted_at) VALUES ($1, $2, $3, $4, $5, 'pending', now())
         ON CONFLICT (user_id) DO UPDATE SET legal_name = EXCLUDED.legal_name, id_type = EXCLUDED.id_type, id_number_enc = EXCLUDED.id_number_enc,
                id_last4 = EXCLUDED.id_last4, status = 'pending', notes = NULL, reviewed_by = NULL, reviewed_at = NULL, submitted_at = now()`,
        [user.id, cleanText(input.legalName).slice(0, 100), input.idType, financeCrypto.encrypt(idn), idn.slice(-4)],
      );
      await c.query(`UPDATE creator_profiles SET kyc_status = 'pending' WHERE user_id = $1`, [user.id]);
    });
    return this.kyc(user);
  },

  // ── Payout requests ──
  async list(user: AuthUser) {
    const { rows } = await query(
      `SELECT p.*, m.label AS method_label FROM payouts p JOIN payout_methods m ON m.id = p.method_id WHERE p.user_id = $1 ORDER BY p.created_at DESC LIMIT 50`,
      [user.id],
    );
    return { payouts: rows.map(payoutOut), minMinor: env.PAYOUT_MIN_MINOR, holdDays: env.PAYOUT_HOLD_DAYS };
  },

  async request(user: AuthUser, input: { methodId: string; amountMinor: number; currency: Currency }) {
    assertAmount(input.amountMinor, 'Payout');
    if (input.amountMinor < env.PAYOUT_MIN_MINOR) throw badRequest('BELOW_MINIMUM', `The minimum payout is ${formatMoney(env.PAYOUT_MIN_MINOR, input.currency)}`);
    const cp = await one('SELECT kyc_status, payouts_suspended FROM creator_profiles WHERE user_id = $1', [user.id]);
    if (!cp) throw forbidden('NOT_CREATOR', 'Turn on creator tools first');
    if (cp.payouts_suspended) throw forbidden('PAYOUTS_SUSPENDED', 'Payouts are suspended on your account — contact support');
    if (cp.kyc_status !== 'verified') throw forbidden('KYC_REQUIRED', 'Verify your identity before your first payout');
    const m = await one('SELECT id FROM payout_methods WHERE id = $1 AND user_id = $2', [input.methodId, user.id]);
    if (!m) throw notFound('Payout method');

    const id = await tx(async (c) => {
      const available = acct.available(user.id);
      await lockAccount(c, available);
      const open = await c.query(`SELECT 1 FROM payouts WHERE user_id = $1 AND status IN ${OPEN}`, [user.id]);
      if (open.rowCount) throw conflict('PAYOUT_OPEN', 'You already have a payout in progress');
      const balance = await liabilityBalance(available, input.currency, c);
      if (input.amountMinor > balance) throw badRequest('INSUFFICIENT_FUNDS', `You can withdraw up to ${formatMoney(balance, input.currency)}`);
      const { rows } = await c.query(
        `INSERT INTO payouts (user_id, method_id, amount_minor, currency) VALUES ($1, $2, $3, $4) RETURNING id`,
        [user.id, input.methodId, input.amountMinor, input.currency],
      );
      await book(c, { kind: 'payout_request', idempotencyKey: `payout:req:${rows[0].id}`, currency: input.currency, referenceId: rows[0].id, legs: [
        { account: available, amount: input.amountMinor },
        { account: acct.payoutHold(user.id), amount: -input.amountMinor },
      ] });
      return rows[0].id as string;
    });
    return { id, status: 'requested' };
  },

  // ── Staff (Admin Panel) ──
  async staffList(status: string | undefined, page: number, limit: number) {
    const where = status && status !== 'all' ? 'WHERE p.status = $3' : '';
    const params: unknown[] = [limit, (page - 1) * limit];
    if (where) params.push(status);
    const { rows } = await query(
      `SELECT p.*, m.label AS method_label, m.type AS method_type, u.username, u.display_name, cp.kyc_status, cp.payouts_suspended
         FROM payouts p JOIN payout_methods m ON m.id = p.method_id JOIN users u ON u.id = p.user_id
         LEFT JOIN creator_profiles cp ON cp.user_id = p.user_id
         ${where} ORDER BY (p.status = 'requested') DESC, p.created_at DESC LIMIT $1 OFFSET $2`,
      params,
    );
    const total = await one<{ n: number }>(`SELECT count(*)::int AS n FROM payouts p ${where.replace('$3', '$1')}`, where ? [status] : []);
    return {
      items: rows.map((p) => ({ ...payoutOut(p), user: { id: p.user_id, username: p.username, displayName: p.display_name }, kycStatus: p.kyc_status, payoutsSuspended: !!p.payouts_suspended, methodType: p.method_type,
        needsAdmin: Number(p.amount_minor) > env.PAYOUT_ADMIN_THRESHOLD_MINOR })),
      total: total?.n ?? 0,
    };
  },

  /** Full destination details for the staff member making the transfer. Audited every time. */
  async staffMethodDetails(actor: AuthUser, payoutId: string) {
    const p = await one('SELECT p.id, p.user_id, m.details_enc, m.type FROM payouts p JOIN payout_methods m ON m.id = p.method_id WHERE p.id = $1', [payoutId]);
    if (!p) throw notFound('Payout');
    await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'PAYOUT_DETAILS_VIEW', targetId: p.id, targetType: 'payout', metadata: { userId: p.user_id } });
    return { type: p.type, details: JSON.parse(financeCrypto.decrypt(p.details_enc)) };
  },

  async staffDecide(actor: AuthUser, payoutId: string, input: { action: 'approve' | 'mark_paid' | 'reject'; providerRef?: string; reason?: string }) {
    const result = await tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [payoutId]);
      const p = rows[0];
      if (!p) throw notFound('Payout');
      if (p.user_id === actor.id) throw forbidden('SELF_ACTION', "You can't approve your own payout");
      const amount = Number(p.amount_minor);
      if (amount > env.PAYOUT_ADMIN_THRESHOLD_MINOR && actor.role !== 'admin' && input.action !== 'reject') {
        throw forbidden('ADMIN_ONLY', `Payouts above ${formatMoney(env.PAYOUT_ADMIN_THRESHOLD_MINOR, p.currency)} need an admin`);
      }
      if (input.action !== 'reject') {
        // Money only leaves for a creator whose identity is verified and whose payouts aren't suspended
        const cp = (await c.query('SELECT kyc_status, payouts_suspended FROM creator_profiles WHERE user_id = $1', [p.user_id])).rows[0];
        if (cp?.payouts_suspended) throw forbidden('PAYOUTS_SUSPENDED', "This creator's payouts are suspended");
        if (cp?.kyc_status !== 'verified') throw forbidden('KYC_NOT_VERIFIED', "This creator's identity check isn't verified");
      }
      if (input.action === 'approve') {
        if (p.status !== 'requested') throw badRequest('BAD_STATE', 'Only new requests can be approved');
        await c.query(`UPDATE payouts SET status = 'approved', reviewed_by = $2, reviewed_at = now() WHERE id = $1`, [p.id, actor.id]);
      } else if (input.action === 'mark_paid') {
        if (p.status !== 'approved') throw badRequest('BAD_STATE', 'Approve the payout before marking it paid');
        const ref = cleanText(input.providerRef ?? '').slice(0, 100);
        if (ref.length < 4) throw badRequest('REF_REQUIRED', 'Enter the transfer reference');
        await book(c, { kind: 'payout_paid', idempotencyKey: `payout:paid:${p.id}`, currency: p.currency, referenceId: p.id, legs: [
          { account: acct.payoutHold(p.user_id), amount },
          { account: acct.payoutsSent, amount: -amount },
        ] });
        await c.query(`UPDATE payouts SET status = 'paid', provider_ref = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1`, [p.id, ref, actor.id]);
      } else {
        if (!['requested', 'approved', 'on_hold'].includes(p.status)) throw badRequest('BAD_STATE', 'This payout is already finished');
        const why = cleanText(input.reason ?? '').slice(0, 300);
        if (why.length < 3) throw badRequest('REASON_REQUIRED', 'Give a reason');
        await book(c, { kind: 'payout_rejected', idempotencyKey: `payout:rej:${p.id}`, currency: p.currency, referenceId: p.id, legs: [
          { account: acct.payoutHold(p.user_id), amount },
          { account: acct.available(p.user_id), amount: -amount },
        ] });
        await c.query(`UPDATE payouts SET status = 'rejected', reject_reason = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1`, [p.id, why, actor.id]);
      }
      await auditService.log({
        actorId: actor.id, actorRole: actor.role, action: `PAYOUT_${input.action.toUpperCase()}`, targetId: p.id, targetType: 'payout',
        metadata: { userId: p.user_id, amount, currency: p.currency, providerRef: input.providerRef ?? null, reason: input.reason ?? null },
      }, c);
      return { userId: p.user_id as string, amount, currency: p.currency as Currency };
    });
    const msg = input.action === 'mark_paid' ? `Your payout of ${formatMoney(result.amount, result.currency)} was sent`
      : input.action === 'reject' ? `Your payout of ${formatMoney(result.amount, result.currency)} was declined: ${input.reason}. The money is back in your balance.`
      : null;
    if (msg) await notificationService.create({ userId: result.userId, type: 'system', message: msg }).catch(() => {});
    return { ok: true };
  },

  async staffKycList(status: string | undefined) {
    const { rows } = await query(
      `SELECT k.user_id, k.legal_name, k.id_type, k.id_last4, k.status, k.notes, k.submitted_at, k.reviewed_at, u.username, u.display_name, u.created_at, cp.payouts_suspended
         FROM kyc_records k JOIN users u ON u.id = k.user_id LEFT JOIN creator_profiles cp ON cp.user_id = k.user_id
        WHERE ($1::text IS NULL OR k.status = $1) ORDER BY (k.status = 'pending') DESC, k.submitted_at DESC LIMIT 200`,
      [status && status !== 'all' ? status : null],
    );
    return { items: rows.map((k) => ({ userId: k.user_id, username: k.username, displayName: k.display_name, legalName: k.legal_name, idType: k.id_type, idLast4: k.id_last4, status: k.status, notes: k.notes, submittedAt: k.submitted_at, reviewedAt: k.reviewed_at, accountCreatedAt: k.created_at, payoutsSuspended: !!k.payouts_suspended })) };
  },

  /** Full ID number for the reviewer — audited. */
  async staffKycReveal(actor: AuthUser, userId: string) {
    const k = await one('SELECT id_number_enc FROM kyc_records WHERE user_id = $1', [userId]);
    if (!k) throw notFound('KYC record');
    await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'KYC_ID_VIEW', targetId: userId, targetType: 'user' });
    return { idNumber: financeCrypto.decrypt(k.id_number_enc) };
  },

  async staffKycDecide(actor: AuthUser, userId: string, approve: boolean, notes?: string) {
    if (userId === actor.id) throw forbidden('SELF_ACTION', "You can't review your own identity");
    const why = cleanText(notes ?? '').slice(0, 300);
    if (!approve && why.length < 3) throw badRequest('REASON_REQUIRED', 'Tell the creator what to fix');
    await tx(async (c) => {
      const r = await c.query(
        `UPDATE kyc_records SET status = $2, notes = $3, reviewed_by = $4, reviewed_at = now() WHERE user_id = $1 AND status = 'pending'`,
        [userId, approve ? 'verified' : 'rejected', why || null, actor.id],
      );
      if (!r.rowCount) throw badRequest('BAD_STATE', 'Only pending submissions can be reviewed');
      await c.query('UPDATE creator_profiles SET kyc_status = $2 WHERE user_id = $1', [userId, approve ? 'verified' : 'rejected']);
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: approve ? 'KYC_APPROVE' : 'KYC_REJECT', targetId: userId, targetType: 'user', metadata: { notes: why || null } }, c);
    });
    await notificationService.create({
      userId, type: 'system', message: approve ? 'Your identity is verified — you can request payouts now' : `Identity check not approved: ${why}`,
    }).catch(() => {});
    return { ok: true };
  },

  // ── Staff: hold / suspend / delete ──

  /** Pause one payout (money stays reserved) or release it back to where it was. */
  async staffPayoutHold(actor: AuthUser, payoutId: string, hold: boolean, reason?: string) {
    const why = cleanText(reason ?? '').slice(0, 300);
    if (hold && why.length < 3) throw badRequest('REASON_REQUIRED', 'Give a reason');
    const p = await tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [payoutId]);
      const x = rows[0];
      if (!x) throw notFound('Payout');
      if (hold) {
        if (!['requested', 'approved'].includes(x.status)) throw badRequest('BAD_STATE', 'Only open payouts can be put on hold');
        await c.query(`UPDATE payouts SET status = 'on_hold', held_from = status, hold_reason = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1`, [x.id, why, actor.id]);
      } else {
        if (x.status !== 'on_hold') throw badRequest('BAD_STATE', 'This payout is not on hold');
        const cp = (await c.query('SELECT kyc_status, payouts_suspended FROM creator_profiles WHERE user_id = $1', [x.user_id])).rows[0];
        if (cp?.payouts_suspended) throw forbidden('PAYOUTS_SUSPENDED', "Unsuspend this creator's payouts first");
        await c.query(`UPDATE payouts SET status = COALESCE(held_from, 'requested'), held_from = NULL, hold_reason = NULL WHERE id = $1`, [x.id]);
      }
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: hold ? 'PAYOUT_HOLD' : 'PAYOUT_RELEASE', targetId: x.id, targetType: 'payout', metadata: { userId: x.user_id, amount: Number(x.amount_minor), reason: why || null } }, c);
      return x;
    });
    await notificationService.create({
      userId: p.user_id, type: 'system',
      message: hold ? `Your payout of ${formatMoney(Number(p.amount_minor), p.currency)} is on hold: ${why}` : `Your payout of ${formatMoney(Number(p.amount_minor), p.currency)} is no longer on hold`,
    }).catch(() => {});
    return { ok: true };
  },

  /**
   * Permanently delete a payout and its ledger records. An unpaid payout's money goes back to the creator's
   * available balance. For a paid payout only the record goes: the money really left, so the ledger keeps that.
   */
  async staffPayoutDelete(actor: AuthUser, payoutId: string, reason: string) {
    const why = cleanText(reason).slice(0, 300);
    if (why.length < 3) throw badRequest('REASON_REQUIRED', 'Give a reason');
    const p = await tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [payoutId]);
      const x = rows[0];
      if (!x) throw notFound('Payout');
      const amount = Number(x.amount_minor);
      if (x.status !== 'paid') {
        const { rows: txs } = await c.query<{ id: string }>('SELECT id FROM ledger_transactions WHERE reference_id = $1', [x.id]);
        await purgeTransactions(c, txs.map((t) => t.id), "This payout's money is already in use");
      }
      await c.query('DELETE FROM payouts WHERE id = $1', [x.id]);
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'PAYOUT_DELETE', targetId: x.id, targetType: 'payout', metadata: { userId: x.user_id, amount, status: x.status, reason: why } }, c);
      return x;
    });
    if (p.status !== 'rejected' && p.status !== 'paid') {
      await notificationService.create({ userId: p.user_id, type: 'system', message: `Your payout of ${formatMoney(Number(p.amount_minor), p.currency)} was cancelled: ${why}. The money is back in your balance.` }).catch(() => {});
    }
    return { ok: true };
  },

  /** Stop (or allow again) all payouts for a creator. Open payouts are put on hold. */
  async staffSuspendPayouts(actor: AuthUser, userId: string, suspended: boolean, reason?: string) {
    const why = cleanText(reason ?? '').slice(0, 300);
    if (suspended && why.length < 3) throw badRequest('REASON_REQUIRED', 'Give a reason');
    if (userId === actor.id) throw forbidden('SELF_ACTION', "You can't change your own payouts");
    await tx(async (c) => {
      const r = await c.query('UPDATE creator_profiles SET payouts_suspended = $2, payouts_suspend_reason = $3 WHERE user_id = $1', [userId, suspended, suspended ? why : null]);
      if (!r.rowCount) throw notFound('Creator');
      if (suspended) {
        await c.query(`UPDATE payouts SET status = 'on_hold', held_from = status, hold_reason = $2 WHERE user_id = $1 AND status IN ('requested','approved')`, [userId, `Payouts suspended: ${why}`]);
      }
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: suspended ? 'PAYOUTS_SUSPEND' : 'PAYOUTS_UNSUSPEND', targetId: userId, targetType: 'user', metadata: { reason: why || null } }, c);
    });
    await notificationService.create({ userId, type: 'system', message: suspended ? `Payouts on your account are suspended: ${why}` : 'Payouts on your account are allowed again' }).catch(() => {});
    return { ok: true };
  },

  /** Put an identity check on hold (more review) or release it to its previous status. Blocks payouts while held. */
  async staffKycHold(actor: AuthUser, userId: string, hold: boolean, reason?: string) {
    const why = cleanText(reason ?? '').slice(0, 300);
    if (hold && why.length < 3) throw badRequest('REASON_REQUIRED', 'Give a reason');
    if (userId === actor.id) throw forbidden('SELF_ACTION', "You can't review your own identity");
    await tx(async (c) => {
      const k = (await c.query('SELECT status, held_from FROM kyc_records WHERE user_id = $1 FOR UPDATE', [userId])).rows[0];
      if (!k) throw notFound('KYC record');
      let next: string;
      if (hold) {
        if (!['pending', 'verified'].includes(k.status)) throw badRequest('BAD_STATE', 'Only waiting or verified checks can be put on hold');
        next = 'on_hold';
        await c.query(`UPDATE kyc_records SET status = 'on_hold', held_from = status, notes = $2, reviewed_by = $3, reviewed_at = now() WHERE user_id = $1`, [userId, why, actor.id]);
        await c.query(`UPDATE payouts SET status = 'on_hold', held_from = status, hold_reason = 'Identity check on hold' WHERE user_id = $1 AND status IN ('requested','approved')`, [userId]);
      } else {
        if (k.status !== 'on_hold') throw badRequest('BAD_STATE', 'This check is not on hold');
        next = k.held_from ?? 'pending';
        await c.query('UPDATE kyc_records SET status = $2, held_from = NULL, notes = NULL WHERE user_id = $1', [userId, next]);
      }
      await c.query('UPDATE creator_profiles SET kyc_status = $2 WHERE user_id = $1', [userId, next]);
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: hold ? 'KYC_HOLD' : 'KYC_RELEASE', targetId: userId, targetType: 'user', metadata: { reason: why || null } }, c);
    });
    await notificationService.create({ userId, type: 'system', message: hold ? `Your identity check is on hold: ${why}` : 'Your identity check is no longer on hold' }).catch(() => {});
    return { ok: true };
  },

  /** Revoke a verification (or restore it). Suspended creators can't be paid. */
  async staffKycSuspend(actor: AuthUser, userId: string, suspended: boolean, reason?: string) {
    const why = cleanText(reason ?? '').slice(0, 300);
    if (suspended && why.length < 3) throw badRequest('REASON_REQUIRED', 'Give a reason');
    if (userId === actor.id) throw forbidden('SELF_ACTION', "You can't review your own identity");
    await tx(async (c) => {
      const k = (await c.query('SELECT status FROM kyc_records WHERE user_id = $1 FOR UPDATE', [userId])).rows[0];
      if (!k) throw notFound('KYC record');
      if (suspended && k.status === 'suspended') throw badRequest('BAD_STATE', 'Already suspended');
      if (!suspended && k.status !== 'suspended') throw badRequest('BAD_STATE', 'This check is not suspended');
      const next = suspended ? 'suspended' : 'verified';
      await c.query('UPDATE kyc_records SET status = $2, held_from = NULL, notes = $3, reviewed_by = $4, reviewed_at = now() WHERE user_id = $1', [userId, next, suspended ? why : null, actor.id]);
      await c.query('UPDATE creator_profiles SET kyc_status = $2 WHERE user_id = $1', [userId, next]);
      if (suspended) await c.query(`UPDATE payouts SET status = 'on_hold', held_from = status, hold_reason = 'Identity verification suspended' WHERE user_id = $1 AND status IN ('requested','approved')`, [userId]);
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: suspended ? 'KYC_SUSPEND' : 'KYC_UNSUSPEND', targetId: userId, targetType: 'user', metadata: { reason: why || null } }, c);
    });
    await notificationService.create({ userId, type: 'system', message: suspended ? `Your identity verification was suspended: ${why}` : 'Your identity verification is active again' }).catch(() => {});
    return { ok: true };
  },

  /** Remove an identity check entirely; the creator must submit again. Not allowed while a payout is in progress. */
  async staffKycDelete(actor: AuthUser, userId: string, reason: string) {
    const why = cleanText(reason).slice(0, 300);
    if (why.length < 3) throw badRequest('REASON_REQUIRED', 'Give a reason');
    if (userId === actor.id) throw forbidden('SELF_ACTION', "You can't delete your own identity check");
    await tx(async (c) => {
      const open = await c.query(`SELECT 1 FROM payouts WHERE user_id = $1 AND status IN ${OPEN}`, [userId]);
      if (open.rowCount) throw badRequest('PAYOUT_OPEN', 'This creator has a payout in progress — finish, reject or delete it first');
      const r = await c.query('DELETE FROM kyc_records WHERE user_id = $1 RETURNING legal_name', [userId]);
      if (!r.rowCount) throw notFound('KYC record');
      await c.query(`UPDATE creator_profiles SET kyc_status = 'none' WHERE user_id = $1`, [userId]);
      await auditService.log({ actorId: actor.id, actorRole: actor.role, action: 'KYC_DELETE', targetId: userId, targetType: 'user', metadata: { reason: why } }, c);
    });
    await notificationService.create({ userId, type: 'system', message: `Your identity check was removed: ${why}. Please submit it again to receive payouts.` }).catch(() => {});
    return { ok: true };
  },
};
