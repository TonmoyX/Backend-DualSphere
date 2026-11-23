// Background worker entry (`npm run worker` / `npm run worker:dev`). Scale separately from the API.
import { pool } from './config/db.js';
import { logger } from './lib/logger.js';
import { loadSettings } from './services/settings.service.js';
import { runWorker } from './worker-tasks.js';

await pool.query('SELECT 1');
await loadSettings();
const stop = runWorker();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    logger.info(`Worker stopping (${sig})`);
    stop();
    await pool.end().catch(() => {});
    process.exit(0);
  });
}
