import { createClient, type RedisClientType } from 'redis';
import { env } from './env.js';
import { logger } from '../lib/logger.js';

/** Optional Redis — used for distributed rate limiting. Falls back to in-memory when unset. */
export let redis: RedisClientType | null = null;

export async function connectRedis() {
  if (!env.REDIS_URL) {
    logger.warn('REDIS_URL not set — using in-memory rate limiting (single instance only)');
    return;
  }
  const client = createClient({ url: env.REDIS_URL }) as RedisClientType;
  client.on('error', (err) => logger.error({ err }, 'Redis error'));
  await client.connect();
  redis = client;
  logger.info('Redis connected');
}
