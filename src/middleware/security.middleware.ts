import type { NextFunction, Request, Response } from 'express';
import { corsOrigins } from '../config/env.js';
import { forbidden, AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getSettings } from '../services/settings.service.js';
import { isStaff } from './rbac.middleware.js';

/**
 * CSRF defence (layered on top of SameSite cookies): state-changing requests that
 * carry an Origin header must come from a whitelisted origin.
 */
export function originGuard(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && !corsOrigins.includes(origin)) throw forbidden('BAD_ORIGIN', 'Origin not allowed');
  next();
}

// ── Honeypot: scanners hitting bait paths get blocked for an hour ──
const blocked = new Map<string, number>();
const BAIT = [/^\/wp-(login|admin)/i, /^\/\.env/, /^\/\.git/, /^\/phpmyadmin/i, /\.php$/i, /^\/api\/v1\/admin\/login$/];

// Never block loopback/private addresses: behind a proxy without TRUST_PROXY every visitor
// would share the proxy's IP, and one scanner would lock everyone out.
const PRIVATE_IP = /^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::ffff:(127|10|192\.168)\.|fc|fd)/i;

export function honeypot(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip ?? '';
  const until = blocked.get(ip);
  if (until && until > Date.now()) return res.status(403).end();
  if (BAIT.some((r) => r.test(req.path))) {
    if (!PRIVATE_IP.test(ip)) blocked.set(ip, Date.now() + 60 * 60 * 1000);
    logger.warn({ path: req.path }, 'Honeypot triggered — IP blocked for 1h');
    return res.status(404).end();
  }
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of blocked) if (v < now) blocked.delete(k);
}, 10 * 60 * 1000).unref();

/** Maintenance mode: non-staff can read but not write (auth + admin routes stay open). */
export function maintenanceGuard(req: Request, _res: Response, next: NextFunction) {
  const f = getSettings().features;
  if (!f.maintenanceMode || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/api/v1/auth') || req.path.startsWith('/api/v1/admin') || req.path.startsWith('/api/v1/moderation')) return next();
  if (isStaff(req.user?.role)) return next();
  throw new AppError(503, 'MAINTENANCE', f.maintenanceMessage);
}
