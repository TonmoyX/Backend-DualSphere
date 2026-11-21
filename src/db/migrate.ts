// Minimal forward-only SQL migration runner. Files in ./migrations run once, in name order.
import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

for (const file of files) {
  if (applied.has(file)) continue;
  const sql = await readFile(path.join(dir, file), 'utf8');
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    await client.query('COMMIT');
    console.log(`✓ applied ${file}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`✗ ${file} failed:`, (err as Error).message);
    process.exit(1);
  }
}
console.log('Migrations up to date.');
await client.end();
