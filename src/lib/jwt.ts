import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { Role } from '../types/index.js';

export interface AccessClaims {
  sub: string; // user id
  sid: string; // session id
  role: Role;
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: `${env.ACCESS_TOKEN_TTL_MIN}m`,
    issuer: 'dualsphere-api',
    audience: 'dualsphere',
  });
}

export type VerifyResult = { ok: true; claims: AccessClaims } | { ok: false; expired: boolean };

export function verifyAccessToken(token: string): VerifyResult {
  try {
    const claims = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: 'dualsphere-api',
      audience: 'dualsphere',
    }) as AccessClaims;
    return { ok: true, claims };
  } catch (err) {
    return { ok: false, expired: err instanceof jwt.TokenExpiredError };
  }
}

/** Short-lived token proving password step passed, pending MFA code. */
export function signMfaChallenge(userId: string): string {
  return jwt.sign({ sub: userId, typ: 'mfa' }, env.JWT_REFRESH_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
}

export function verifyMfaChallenge(token: string): string | null {
  try {
    const p = jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] }) as { sub: string; typ: string };
    return p.typ === 'mfa' ? p.sub : null;
  } catch {
    return null;
  }
}

/** Signed short-lived token for local-disk upload URLs (mirrors R2 presigned PUT). */
export function signUploadToken(key: string, mediaId: string, maxBytes: number, mime: string): string {
  return jwt.sign({ key, mid: mediaId, max: maxBytes, mime, typ: 'upload' }, env.JWT_REFRESH_SECRET, {
    algorithm: 'HS256',
    expiresIn: '10m',
  });
}

export function verifyUploadToken(token: string) {
  try {
    const p = jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] }) as {
      key: string; mid: string; max: number; mime: string; typ: string;
    };
    return p.typ === 'upload' ? p : null;
  } catch {
    return null;
  }
}
