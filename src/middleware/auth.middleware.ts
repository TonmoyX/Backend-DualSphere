import type { NextFunction, Request, Response } from 'express';
import { effectivePermissions } from '../lib/permissions.js';
import { one, query } from '../config/db.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { AppError, unauthorized } from '../lib/errors.js';
import type { Role } from '../types/index.js';

type AuthError = { kind: 'expired' } | { kind: 'invalid' } | { kind: 'banned'; reason: string | null; until: Date | null };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authError?: AuthError;
    }
  }
}

function extractToken(req: Request): string | undefined {
  const cookie = req.cookies?.ds_access as string | undefined;
  if (cookie) return cookie;
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

/**
 * Runs on every request. Verifies the JWT, then confirms the session is still live
 * and the user is not banned (so bans / revocations take effect immediately).
 */
export async function attachUser(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) return next();

  const v = verifyAccessToken(token);
  if (!v.ok) {
    req.authError = { kind: v.expired ? 'expired' : 'invalid' };
    // Lets the client refresh + retry even on public routes that don't require auth
    if (v.expired) res.setHeader('X-Auth-Expired', '1');
    return next();
  }

  const row = await one<{
    id: string; role: Role; username: string; is_verified: boolean; mfa_enabled: boolean;
    is_banned: boolean; ban_reason: string | null; banned_until: Date | null; created_at: Date; permissions: string[] | null;
  }>(
    `SELECT u.id, u.role, u.username, u.is_verified, u.mfa_enabled, u.is_banned, u.ban_reason, u.banned_until, u.created_at, u.permissions
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [v.claims.sid, v.claims.sub],
  );

  if (!row) {
    req.authError = { kind: 'invalid' };
    return next();
  }

  if (row.is_banned) {
    if (row.banned_until && row.banned_until.getTime() < Date.now()) {
      // Temporary ban expired — lift automatically
      await query('UPDATE users SET is_banned = false, ban_reason = NULL, banned_until = NULL WHERE id = $1', [row.id]);
    } else {
      req.authError = { kind: 'banned', reason: row.ban_reason, until: row.banned_until };
      return next();
    }
  }

  req.user = {
    id: row.id,
    sessionId: v.claims.sid,
    role: row.role, // fresh from DB, not from the token
    username: row.username,
    isVerified: row.is_verified,
    mfaEnabled: row.mfa_enabled,
    createdAt: row.created_at,
    permissions: effectivePermissions(row.role, row.permissions), // read fresh every request → changes apply instantly
  };
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (req.user) return next();
  const e = req.authError;
  if (e?.kind === 'expired') throw unauthorized('TOKEN_EXPIRED', 'Access token expired');
  if (e?.kind === 'banned') {
    throw new AppError(403, 'BANNED', 'This account is suspended', { reason: e.reason, until: e.until });
  }
  throw unauthorized();
}
