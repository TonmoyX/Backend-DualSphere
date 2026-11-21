import type { PoolClient } from 'pg';
import { query, tx } from '../config/db.js';
import { env } from '../config/env.js';
import { canonicalJson, hmacHex, safeEqual } from '../lib/crypto.js';

export interface AuditEntry {
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  targetId?: string | null;
  targetType?: string | null;
  metadata?: Record<string, unknown>;
}

interface AuditRow {
  id: number;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  target_id: string | null;
  target_type: string | null;
  metadata: Record<string, unknown>;
  prev_signature: string | null;
  hmac_signature: string;
  created_at: Date;
}

const LOCK_ID = 727_274; // serialises chain appends

function sign(record: {
  actorId: string | null; actorRole: string | null; action: string; targetId: string | null;
  targetType: string | null; metadata: Record<string, unknown>; prevSignature: string | null; createdAt: string;
}) {
  return hmacHex(env.AUDIT_HMAC_KEY, canonicalJson(record));
}

/**
 * Append-only, HMAC-signed, hash-chained audit log.
 * The DB rejects UPDATE/DELETE/TRUNCATE via trigger; each record also signs the previous
 * record's signature, so removing or reordering rows breaks the chain.
 */
export const auditService = {
  async log(entry: AuditEntry, client?: PoolClient): Promise<void> {
    const run = async (c: PoolClient) => {
      await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
      const prev = await c.query<{ hmac_signature: string }>('SELECT hmac_signature FROM audit_logs ORDER BY id DESC LIMIT 1');
      const createdAt = new Date();
      const record = {
        actorId: entry.actorId ?? null,
        actorRole: entry.actorRole ?? null,
        action: entry.action,
        targetId: entry.targetId ?? null,
        targetType: entry.targetType ?? null,
        metadata: entry.metadata ?? {},
        prevSignature: prev.rows[0]?.hmac_signature ?? null,
        createdAt: createdAt.toISOString(),
      };
      await c.query(
        `INSERT INTO audit_logs (actor_id, actor_role, action, target_id, target_type, metadata, prev_signature, hmac_signature, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [record.actorId, record.actorRole, record.action, record.targetId, record.targetType,
         JSON.stringify(record.metadata), record.prevSignature, sign(record), createdAt],
      );
    };
    if (client) await run(client); // caller owns the transaction
    else await tx(run);
  },

  verifyRow(row: AuditRow): boolean {
    const expected = sign({
      actorId: row.actor_id,
      actorRole: row.actor_role,
      action: row.action,
      targetId: row.target_id,
      targetType: row.target_type,
      metadata: row.metadata ?? {},
      prevSignature: row.prev_signature,
      createdAt: new Date(row.created_at).toISOString(),
    });
    return safeEqual(expected, row.hmac_signature);
  },

  async verify(id: number): Promise<boolean> {
    const { rows } = await query<AuditRow>('SELECT * FROM audit_logs WHERE id = $1', [id]);
    return rows[0] ? this.verifyRow(rows[0]) : false;
  },

  /** Walks the full chain in batches. Returns the first broken record, if any. */
  async verifyChain(): Promise<{ ok: boolean; checked: number; brokenAt?: number; reason?: string }> {
    let lastId = 0;
    let prevSig: string | null = null;
    let checked = 0;
    for (;;) {
      const { rows } = await query<AuditRow>('SELECT * FROM audit_logs WHERE id > $1 ORDER BY id ASC LIMIT 1000', [lastId]);
      if (rows.length === 0) break;
      for (const row of rows) {
        if (checked > 0 && row.prev_signature !== prevSig) return { ok: false, checked, brokenAt: row.id, reason: 'CHAIN_BROKEN' };
        if (!this.verifyRow(row)) return { ok: false, checked, brokenAt: row.id, reason: 'BAD_SIGNATURE' };
        prevSig = row.hmac_signature;
        lastId = row.id;
        checked++;
      }
    }
    return { ok: true, checked };
  },
};
