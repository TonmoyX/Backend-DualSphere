import bcrypt from 'bcryptjs';
import type { Request, Response, CookieOptions } from 'express';
import QRCode from 'qrcode';
import { one, query, tx } from '../config/db.js';
import { env, isProd } from '../config/env.js';
import { aesDecrypt, aesEncrypt, hashIp, randomToken, sha256 } from '../lib/crypto.js';
import { AppError, badRequest, conflict, forbidden, unauthorized } from '../lib/errors.js';
import { signAccessToken, signMfaChallenge, verifyMfaChallenge } from '../lib/jwt.js';
import { logger } from '../lib/logger.js';
import { mailTemplates, sendMail } from '../lib/mailer.js';
import { emit } from '../lib/realtime.js';
import { selfUser } from '../lib/serialize.js';
import { generateSecret, otpauthUrl, verifyTotp } from '../lib/totp.js';
import type { Role } from '../types/index.js';
import { auditService } from './audit.service.js';
import { notificationService } from './notification.service.js';
import { getSettings } from './settings.service.js';

const BCRYPT_COST = 12;
// Pre-computed hash so unknown-user logins take the same time (anti user-enumeration)
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_COST);
const REFRESH_PATH = '/api/v1/auth';
const GRACE_MS = 60_000;

function cookieBase(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'strict' : 'lax',
    domain: env.COOKIE_DOMAIN || undefined,
  };
}

function setAccessCookie(res: Response, token: string) {
  res.cookie('ds_access', token, { ...cookieBase(), path: '/', maxAge: env.ACCESS_TOKEN_TTL_MIN * 60_000 });
}

function setRefreshCookie(res: Response, token: string) {
  res.cookie('ds_refresh', token, { ...cookieBase(), path: REFRESH_PATH, maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000 });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie('ds_access', { ...cookieBase(), path: '/' });
  res.clearCookie('ds_refresh', { ...cookieBase(), path: REFRESH_PATH });
}

function deviceFingerprint(req: Request) {
  const ip = req.ip ?? '';
  const subnet = ip.includes('.') ? ip.split('.').slice(0, 3).join('.') : ip.split(':').slice(0, 4).join(':');
  return sha256(`${req.headers['user-agent'] ?? ''}|${subnet}`).slice(0, 40);
}

async function createSession(req: Request, res: Response, user: { id: string; role: Role }) {
  const refresh = randomToken(48);
  const session = await one<{ id: string }>(
    `INSERT INTO sessions (user_id, refresh_token_hash, user_agent, ip_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' days')::interval) RETURNING id`,
    [user.id, sha256(refresh), (req.headers['user-agent'] ?? '').slice(0, 300), hashIp(req.ip), String(env.REFRESH_TOKEN_TTL_DAYS)],
  );
  setAccessCookie(res, signAccessToken({ sub: user.id, sid: session!.id, role: user.role }));
  setRefreshCookie(res, refresh);
  return session!.id;
}

/** Account-takeover heuristics: alert on sign-in from an unseen device/network. */
async function checkDevice(req: Request, user: { id: string; email: string; role: Role }) {
  const fp = deviceFingerprint(req);
  const existing = await query('SELECT fingerprint FROM known_devices WHERE user_id = $1', [user.id]);
  const known = existing.rows.some((r) => r.fingerprint === fp);
  await query(
    `INSERT INTO known_devices (user_id, fingerprint) VALUES ($1, $2)
     ON CONFLICT (user_id, fingerprint) DO UPDATE SET last_seen = now()`,
    [user.id, fp],
  );
  if (!known && existing.rowCount! > 0) {
    const ua = String(req.headers['user-agent'] ?? 'unknown').slice(0, 120);
    await notificationService.create({ userId: user.id, type: 'security', message: `New sign-in from ${ua}` });
    const t = mailTemplates.newDevice(new Date().toUTCString(), ua);
    void sendMail(user.email, t.subject, t.text);
    await auditService.log({ actorId: user.id, actorRole: user.role, action: 'NEW_DEVICE_LOGIN', targetId: user.id, targetType: 'user', metadata: { ipHash: hashIp(req.ip) } });
  }
}

async function issueEmailToken(userId: string, type: 'verify' | 'reset') {
  const token = randomToken(32);
  const ttl = type === 'verify' ? '24 hours' : '1 hour';
  await query(`UPDATE email_tokens SET used_at = now() WHERE user_id = $1 AND type = $2 AND used_at IS NULL`, [userId, type]);
  await query(
    `INSERT INTO email_tokens (user_id, type, token_hash, expires_at) VALUES ($1, $2, $3, now() + $4::interval)`,
    [userId, type, sha256(token), ttl],
  );
  return token;
}

async function consumeEmailToken(token: string, type: 'verify' | 'reset') {
  const row = await one<{ id: string; user_id: string }>(
    `UPDATE email_tokens SET used_at = now()
      WHERE token_hash = $1 AND type = $2 AND used_at IS NULL AND expires_at > now()
      RETURNING id, user_id`,
    [sha256(token), type],
  );
  if (!row) throw badRequest('INVALID_TOKEN', 'This link is invalid or has expired');
  return row.user_id;
}

export async function getSelf(userId: string) {
  const row = await one('SELECT * FROM users WHERE id = $1', [userId]);
  if (!row) throw unauthorized();
  return selfUser(row, getSettings().limits.anonAccountAgeHours);
}

export const authService = {
  async signup(req: Request, res: Response, input: { username: string; email: string; password: string; displayName: string; birthDate: string; gender: string; website?: string }) {
    if (input.website) throw badRequest('INVALID', 'Unable to create account'); // honeypot
    if (!getSettings().features.registrationEnabled) throw forbidden('REGISTRATION_CLOSED', 'Registration is currently closed');

    const clash = await one<{ username_taken: boolean; email_taken: boolean }>(
      `SELECT bool_or(lower(username) = lower($1)) AS username_taken, bool_or(lower(email) = lower($2)) AS email_taken
         FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($2)`,
      [input.username, input.email],
    );
    if (clash?.username_taken) throw conflict('USERNAME_TAKEN', 'That username is taken');
    if (clash?.email_taken) throw conflict('ACCOUNT_EXISTS', 'An account with these details already exists');

    const hash = await bcrypt.hash(input.password, BCRYPT_COST);
    const user = await one<{ id: string; role: Role; email: string }>(
      `INSERT INTO users (username, email, password_hash, display_name, birth_date, gender)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, role, email`,
      [input.username, input.email, hash, input.displayName, input.birthDate, input.gender],
    );

    const token = await issueEmailToken(user!.id, 'verify');
    const t = mailTemplates.verify(`${env.FRONTEND_URL}/verify-email?token=${token}`);
    void sendMail(user!.email, t.subject, t.text);

    await createSession(req, res, user!);
    await query(`INSERT INTO known_devices (user_id, fingerprint) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [user!.id, deviceFingerprint(req)]);
    await auditService.log({ actorId: user!.id, actorRole: 'user', action: 'USER_SIGNUP', targetId: user!.id, targetType: 'user', metadata: { ipHash: hashIp(req.ip) } });
    emit.staff('admin:signup', { username: input.username });
    return getSelf(user!.id);
  },

  async login(req: Request, res: Response, identifier: string, password: string) {
    const user = await one(
      `SELECT * FROM users WHERE lower(email) = lower($1) OR lower(username) = lower($1) LIMIT 1`,
      [identifier],
    );
    const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) {
      if (user) await auditService.log({ actorId: user.id, action: 'LOGIN_FAILED', targetId: user.id, targetType: 'user', metadata: { ipHash: hashIp(req.ip) } });
      throw unauthorized('INVALID_CREDENTIALS', 'Incorrect email/username or password');
    }
    if (user.is_banned && !(user.banned_until && new Date(user.banned_until).getTime() < Date.now())) {
      throw new AppError(403, 'BANNED', 'This account is suspended', { reason: user.ban_reason, until: user.banned_until });
    }
    if (user.mfa_enabled) return { mfaRequired: true as const, challenge: signMfaChallenge(user.id) };
    return { mfaRequired: false as const, user: await this.completeLogin(req, res, user) };
  },

  async loginMfa(req: Request, res: Response, challenge: string, code: string) {
    const userId = verifyMfaChallenge(challenge);
    if (!userId) throw unauthorized('MFA_EXPIRED', 'Sign-in expired, please start again');
    const user = await one('SELECT * FROM users WHERE id = $1', [userId]);
    if (!user?.mfa_enabled || !user.mfa_secret_enc) throw unauthorized();
    if (!verifyTotp(aesDecrypt(user.mfa_secret_enc, env.MFA_ENC_KEY), code)) {
      await auditService.log({ actorId: user.id, action: 'MFA_FAILED', targetId: user.id, targetType: 'user' });
      throw unauthorized('INVALID_MFA', 'Invalid authentication code');
    }
    return this.completeLogin(req, res, user);
  },

  async completeLogin(req: Request, res: Response, user: any) {
    await createSession(req, res, user);
    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    await checkDevice(req, user).catch((err) => logger.error({ err }, 'device check failed'));
    await auditService.log({ actorId: user.id, actorRole: user.role, action: 'USER_LOGIN', targetId: user.id, targetType: 'user', metadata: { ipHash: hashIp(req.ip) } });
    return getSelf(user.id);
  },

  /** Rotating refresh tokens with a short grace window for concurrent tabs. */
  async refresh(req: Request, res: Response) {
    const token = req.cookies?.ds_refresh as string | undefined;
    if (!token) throw unauthorized('NO_REFRESH', 'Not signed in');
    const hash = sha256(token);

    const s = await one(
      `SELECT s.*, u.role, u.is_banned FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.refresh_token_hash = $1 OR s.prev_token_hash = $1 LIMIT 1`,
      [hash],
    );
    if (!s || s.revoked_at || new Date(s.expires_at).getTime() < Date.now() || s.is_banned) {
      clearAuthCookies(res);
      throw unauthorized('SESSION_INVALID', 'Session expired, please sign in again');
    }

    if (s.prev_token_hash === hash) {
      // An old token was replayed. Inside the grace window it's a multi-tab race; outside it's likely theft.
      if (s.rotated_at && Date.now() - new Date(s.rotated_at).getTime() < GRACE_MS) {
        setAccessCookie(res, signAccessToken({ sub: s.user_id, sid: s.id, role: s.role }));
        return { ok: true };
      }
      await query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [s.id]);
      await auditService.log({ actorId: s.user_id, action: 'REFRESH_TOKEN_REUSE', targetId: s.id, targetType: 'session' });
      clearAuthCookies(res);
      throw unauthorized('SESSION_INVALID', 'Session revoked for security reasons');
    }

    const next = randomToken(48);
    await query(
      `UPDATE sessions SET prev_token_hash = refresh_token_hash, refresh_token_hash = $2, rotated_at = now(), last_used_at = now()
        WHERE id = $1`,
      [s.id, sha256(next)],
    );
    setAccessCookie(res, signAccessToken({ sub: s.user_id, sid: s.id, role: s.role }));
    setRefreshCookie(res, next);
    return { ok: true };
  },

  async logout(req: Request, res: Response) {
    if (req.user) await query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [req.user.sessionId]);
    else if (req.cookies?.ds_refresh) {
      await query('UPDATE sessions SET revoked_at = now() WHERE refresh_token_hash = $1', [sha256(req.cookies.ds_refresh)]);
    }
    clearAuthCookies(res);
  },

  async verifyEmail(token: string) {
    const userId = await consumeEmailToken(token, 'verify');
    await query('UPDATE users SET is_verified = true WHERE id = $1', [userId]);
    return { verified: true };
  },

  async resendVerification(userId: string) {
    const u = await one('SELECT email, is_verified FROM users WHERE id = $1', [userId]);
    if (!u || u.is_verified) return;
    const token = await issueEmailToken(userId, 'verify');
    const t = mailTemplates.verify(`${env.FRONTEND_URL}/verify-email?token=${token}`);
    await sendMail(u.email, t.subject, t.text);
  },

  /** Always succeeds — never reveals whether an email is registered. */
  async forgotPassword(email: string) {
    const u = await one('SELECT id, email FROM users WHERE lower(email) = lower($1)', [email]);
    if (!u) return;
    const token = await issueEmailToken(u.id, 'reset');
    const t = mailTemplates.reset(`${env.FRONTEND_URL}/reset-password?token=${token}`);
    await sendMail(u.email, t.subject, t.text);
  },

  async resetPassword(token: string, password: string) {
    const userId = await consumeEmailToken(token, 'reset');
    await tx(async (c) => {
      await c.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, await bcrypt.hash(password, BCRYPT_COST)]);
      await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      await auditService.log({ actorId: userId, action: 'PASSWORD_RESET', targetId: userId, targetType: 'user' }, c);
    });
    emit.revoke(userId, {});
  },

  async changePassword(userId: string, sessionId: string, current: string, next: string) {
    const u = await one('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (!u || !(await bcrypt.compare(current, u.password_hash))) throw badRequest('WRONG_PASSWORD', 'Current password is incorrect');
    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, await bcrypt.hash(next, BCRYPT_COST)]);
    await query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [userId, sessionId]);
    await auditService.log({ actorId: userId, action: 'PASSWORD_CHANGE', targetId: userId, targetType: 'user' });
  },

  async listSessions(userId: string, currentId: string) {
    const { rows } = await query(
      `SELECT id, user_agent, created_at, last_used_at, expires_at FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_used_at DESC`,
      [userId],
    );
    return rows.map((r) => ({
      id: r.id, userAgent: r.user_agent, createdAt: r.created_at, lastUsedAt: r.last_used_at,
      expiresAt: r.expires_at, current: r.id === currentId,
    }));
  },

  async revokeSession(userId: string, sessionId: string) {
    const r = await query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [sessionId, userId]);
    if (!r.rowCount) throw new AppError(404, 'NOT_FOUND', 'Session not found');
  },

  async revokeOtherSessions(userId: string, currentId: string) {
    await query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [userId, currentId]);
  },

  // ── TOTP MFA ──
  async mfaSetup(userId: string) {
    const u = await one('SELECT email, mfa_enabled FROM users WHERE id = $1', [userId]);
    if (u.mfa_enabled) throw conflict('MFA_ALREADY_ENABLED', 'Two-factor auth is already enabled');
    const secret = generateSecret();
    await query('UPDATE users SET mfa_secret_enc = $2 WHERE id = $1', [userId, aesEncrypt(secret, env.MFA_ENC_KEY)]);
    const url = otpauthUrl(secret, u.email);
    return { secret, otpauthUrl: url, qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 220 }) };
  },

  async mfaEnable(userId: string, code: string) {
    const u = await one('SELECT mfa_secret_enc, role FROM users WHERE id = $1', [userId]);
    if (!u?.mfa_secret_enc) throw badRequest('MFA_NOT_SETUP', 'Start setup first');
    if (!verifyTotp(aesDecrypt(u.mfa_secret_enc, env.MFA_ENC_KEY), code)) throw badRequest('INVALID_MFA', 'Invalid code — check your device clock');
    await query('UPDATE users SET mfa_enabled = true WHERE id = $1', [userId]);
    await auditService.log({ actorId: userId, actorRole: u.role, action: 'MFA_ENABLED', targetId: userId, targetType: 'user' });
  },

  async mfaDisable(userId: string, code: string, password: string) {
    const u = await one('SELECT mfa_secret_enc, password_hash, role FROM users WHERE id = $1', [userId]);
    if (!u?.mfa_secret_enc) throw badRequest('MFA_NOT_ENABLED', 'Two-factor auth is not enabled');
    if (!(await bcrypt.compare(password, u.password_hash))) throw badRequest('WRONG_PASSWORD', 'Password is incorrect');
    if (!verifyTotp(aesDecrypt(u.mfa_secret_enc, env.MFA_ENC_KEY), code)) throw badRequest('INVALID_MFA', 'Invalid code');
    await query('UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL WHERE id = $1', [userId]);
    await auditService.log({ actorId: userId, actorRole: u.role, action: 'MFA_DISABLED', targetId: userId, targetType: 'user' });
  },

  /** Used for step-up checks (identity lookup). */
  async verifyUserTotp(userId: string, code: string | undefined): Promise<boolean> {
    if (!code) return false;
    const u = await one('SELECT mfa_secret_enc, mfa_enabled FROM users WHERE id = $1', [userId]);
    if (!u?.mfa_enabled || !u.mfa_secret_enc) return false;
    return verifyTotp(aesDecrypt(u.mfa_secret_enc, env.MFA_ENC_KEY), code);
  },
};
