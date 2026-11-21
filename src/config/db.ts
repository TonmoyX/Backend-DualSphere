import pg from 'pg';
import { env } from './env.js';
import { logger } from '../lib/logger.js';

// Return BIGINT/COUNT as JS numbers (safe for our counter ranges)
pg.types.setTypeParser(20, (v) => Number(v));
// DATE stays a 'YYYY-MM-DD' string (avoids timezone shifts)
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => logger.error({ err }, 'Postgres pool error'));

export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export async function query<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) {
  return pool.query<T>(text, params);
}

export async function one<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) {
  const r = await pool.query<T>(text, params);
  return r.rows[0] as T | undefined;
}

/** Run fn inside a transaction; rolls back on throw. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
