// Creates the target database if it doesn't exist (connects to the `postgres` maintenance DB).
import pg from 'pg';

const url = new URL(process.env.DATABASE_URL!);
const dbName = url.pathname.slice(1);
if (!/^[a-zA-Z0-9_]+$/.test(dbName)) throw new Error('Invalid database name');
url.pathname = '/postgres';

const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
if (exists.rowCount) console.log(`✓ Database "${dbName}" already exists`);
else {
  await client.query(`CREATE DATABASE "${dbName}"`);
  console.log(`✓ Created database "${dbName}"`);
}
await client.end();
