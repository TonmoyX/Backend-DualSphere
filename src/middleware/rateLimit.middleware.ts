import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ipKeyGenerator, rateLimit, type Options } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redis } from '../config/redis.js';
import { getSettings } from '../services/settings.service.js';
import { isProd } from '../config/env.js';

/** Dev convenience: localhost isn't throttled by the global limiter (production is unaffected). */
const devLoopback = (req: Request) => !isProd && /^(::1|127\.|::ffff:127\.)/.test(req.ip ?? '');

const HOUR = 60 * 60 * 1000;
const ip = (req: Request) => ipKeyGenerator(req.ip ?? '0.0.0.0');

function make(prefix: string, opts: Partial<Options>): RequestHandler {
  return rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    ...(redis
      ? { store: new RedisStore({ prefix: `rl:${prefix}:`, sendCommand: (...args: string[]) => redis!.sendCommand(args) }) }
      : {}),
    handler: (_req, res) =>
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: opts.message ?? 'Too many requests — slow down.' } }),
    ...opts,
  });
}

let limiters: Record<'global' | 'auth' | 'post' | 'anon' | 'comment' | 'report' | 'upload' | 'message' | 'friend', RequestHandler> | null = null;

/** Must run after Redis connects (stores are bound at creation). Limits read live from admin settings. */
export function initLimiters() {
  limiters = {
    // Per-IP global sliding window
    global: make('global', {
      windowMs: 15 * 60 * 1000,
      limit: () => getSettings().limits.globalRequestsPer15Min,
      keyGenerator: ip,
      skip: devLoopback,
    }),
    // Credential-stuffing defence: per IP + identifier
    auth: make('auth', {
      windowMs: 15 * 60 * 1000,
      limit: 10,
      keyGenerator: (req) => `${ip(req)}:${String(req.body?.identifier ?? req.body?.email ?? '').toLowerCase()}`,
      message: 'Too many attempts. Try again in 15 minutes.',
    }),
    post: make('post', {
      windowMs: HOUR,
      limit: () => getSettings().limits.postsPerHour,
      keyGenerator: (req) => `u:${req.user?.id ?? ip(req)}`,
      message: 'Hourly post limit reached.',
    }),
    // Far stricter for anonymous posting (anti-abuse)
    anon: make('anon', {
      windowMs: HOUR,
      limit: () => getSettings().limits.anonPostsPerHour,
      keyGenerator: (req) => `u:${req.user?.id ?? ip(req)}`,
      message: 'Hourly anonymous post limit reached.',
    }),
    comment: make('comment', {
      windowMs: HOUR,
      limit: () => getSettings().limits.commentsPerHour,
      keyGenerator: (req) => `u:${req.user?.id ?? ip(req)}`,
      message: 'Hourly comment limit reached.',
    }),
    message: make('message', {
      windowMs: 60 * 1000,
      limit: () => getSettings().limits.messagesPerMinute,
      keyGenerator: (req) => `u:${req.user?.id ?? ip(req)}`,
      message: 'You are sending messages too fast.',
    }),
    friend: make('friend', { windowMs: 60 * 60 * 1000, limit: 100, keyGenerator: (req) => `u:${req.user?.id ?? ip(req)}`, message: 'Too many friend requests — try again later.' }),
    report: make('report', { windowMs: HOUR, limit: 30, keyGenerator: (req) => `u:${req.user?.id ?? ip(req)}` }),
    upload: make('upload', { windowMs: HOUR, limit: 60, keyGenerator: (req) => `u:${req.user?.id ?? ip(req)}` }),
  };
}

const lazy = (name: keyof NonNullable<typeof limiters>): RequestHandler => (req: Request, res: Response, next: NextFunction) =>
  limiters ? limiters[name](req, res, next) : next();

export const globalLimiter = lazy('global');
export const authLimiter = lazy('auth');
export const postCreateLimiter = lazy('post');
export const anonPostLimiter = lazy('anon');
export const commentLimiter = lazy('comment');
export const reportLimiter = lazy('report');
export const uploadLimiter = lazy('upload');
export const messageLimiter = lazy('message');
export const friendLimiter = lazy('friend');
