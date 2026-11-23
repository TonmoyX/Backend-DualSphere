// ═══════════════════════════════════════════════════════════════
// Background worker on a Postgres job queue (FOR UPDATE SKIP LOCKED) — no Redis needed.
// Runs queued jobs (AI Ad Studio) and periodic tasks (earnings release, membership expiry, ad billing, rollups,
// A/B optimisation, campaign completion). Periodic tasks take a Postgres advisory lock, so running several
// workers never double-runs them; the money tasks are idempotent anyway (ledger idempotency keys).
// ═══════════════════════════════════════════════════════════════
import type { PoolClient } from 'pg';
import { pool, query } from '../config/db.js';
import { logger } from '../lib/logger.js';

export async function enqueue(c: PoolClient | null, queue: string, payload: Record<string, unknown>, runAt?: Date) {
  const sql = 'INSERT INTO jobs (queue, payload, run_at) VALUES ($1, $2, $3)';
  const params = [queue, JSON.stringify(payload), runAt ?? new Date()];
  if (c) await c.query(sql, params);
  else await query(sql, params);
}

type Handler = (payload: any) => Promise<void>;
type Periodic = { name: string; everyMs: number; run: () => Promise<unknown> };

let running = false;

export function startWorker(handlers: Record<string, Handler>, periodic: Periodic[]) {
  if (running) return () => {};
  running = true;
  let stopped = false;

  const claim = async () => {
    const { rows } = await query(
      `UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
        WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now() ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING *`,
    );
    return rows[0];
  };

  const loop = async () => {
    while (!stopped) {
      let job: any;
      try {
        job = await claim();
      } catch (err) {
        logger.error({ err }, 'worker: claim failed');
      }
      if (!job) { await new Promise((r) => setTimeout(r, 2000)); continue; }
      const handler = handlers[job.queue];
      try {
        if (!handler) throw new Error(`no handler for queue ${job.queue}`);
        await handler(job.payload);
        await query(`UPDATE jobs SET status = 'done', locked_at = NULL WHERE id = $1`, [job.id]);
      } catch (err) {
        const retry = job.attempts < job.max_attempts;
        logger.error({ err, jobId: job.id, queue: job.queue, retry }, 'worker: job failed');
        await query(
          `UPDATE jobs SET status = $2, locked_at = NULL, last_error = $3, run_at = now() + ($4::int || ' seconds')::interval WHERE id = $1`,
          [job.id, retry ? 'queued' : 'failed', String((err as Error)?.message ?? err).slice(0, 500), 30 * job.attempts],
        );
      }
    }
  };

  // Jobs stuck in "running" (worker crashed) go back to the queue
  const reaper = setInterval(() => {
    query(`UPDATE jobs SET status = 'queued', locked_at = NULL WHERE status = 'running' AND locked_at < now() - interval '10 minutes'`).catch(() => {});
  }, 60_000);
  reaper.unref();

  const timers = periodic.map((p, i) => {
    const tick = async () => {
      const c = await pool.connect();
      try {
        const got = await c.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [`periodic:${p.name}`]);
        if (!got.rows[0].ok) return;
        try { await p.run(); } finally { await c.query('SELECT pg_advisory_unlock(hashtext($1))', [`periodic:${p.name}`]); }
      } catch (err) {
        logger.error({ err, task: p.name }, 'worker: periodic task failed');
      } finally {
        c.release();
      }
    };
    setTimeout(tick, 5_000 + i * 1_500).unref(); // stagger the first run
    const t = setInterval(tick, p.everyMs);
    t.unref();
    return t;
  });

  void loop();
  logger.info(`Worker started (${Object.keys(handlers).length} queues, ${periodic.length} periodic tasks)`);
  return () => { stopped = true; clearInterval(reaper); timers.forEach(clearInterval); running = false; };
}
