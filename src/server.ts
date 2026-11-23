import http from 'http';
import { env } from './config/env.js';
import { pool, query } from './config/db.js';
import { connectRedis } from './config/redis.js';
import { createApp } from './app.js';
import { logger } from './lib/logger.js';
import { initRealtime } from './lib/realtime.js';
import { storageDriver } from './lib/storage.js';
import { initLimiters } from './middleware/rateLimit.middleware.js';
import { mediaService } from './services/media.service.js';
import { storyService } from './services/story.service.js';
import { loadSettings } from './services/settings.service.js';
import { runWorker } from './worker-tasks.js';

async function main() {
  await pool.query('SELECT 1');
  logger.info('PostgreSQL connected');
  await connectRedis();
  initLimiters();
  await loadSettings();

  const app = createApp();
  const server = http.createServer(app);
  initRealtime(server);

  // Background jobs
  const hourly = setInterval(async () => {
    try {
      await query(`DELETE FROM sessions WHERE expires_at < now() - interval '1 day'`);
      await query(`DELETE FROM email_tokens WHERE expires_at < now() - interval '1 day'`);
      await mediaService.cleanupPending();
      await storyService.cleanupExpired();
    } catch (err) {
      logger.error({ err }, 'Cleanup job failed');
    }
  }, 10 * 60 * 1000);
  hourly.unref();

  // Background worker inside the API process (dev convenience). In production run `npm run worker` separately.
  if (env.WORKER_IN_PROCESS === 'true') runWorker();

  server.listen(env.PORT, () => {
    logger.info(`🚀 DualSphere API on http://localhost:${env.PORT}  (storage: ${storageDriver})`);
  });

  const shutdown = async (sig: string) => {
    logger.info(`${sig} received, shutting down`);
    server.close();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
