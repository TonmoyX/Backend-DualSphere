import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { authLimiter } from '../middleware/rateLimit.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { authService, getSelf } from '../services/auth.service.js';
import { getSettings } from '../services/settings.service.js';
import * as v from '../validators/index.js';

const r = Router();

r.post('/signup', authLimiter, validate({ body: v.signupSchema }), async (req, res) => {
  res.status(201).json({ user: await authService.signup(req, res, req.body) });
});

r.post('/login', authLimiter, validate({ body: v.loginSchema }), async (req, res) => {
  res.json(await authService.login(req, res, req.body.identifier, req.body.password));
});

r.post('/login/mfa', authLimiter, validate({ body: v.mfaLoginSchema }), async (req, res) => {
  res.json({ mfaRequired: false, user: await authService.loginMfa(req, res, req.body.challenge, req.body.code) });
});

r.post('/refresh', async (req, res) => {
  res.json(await authService.refresh(req, res));
});

r.post('/logout', async (req, res) => {
  await authService.logout(req, res);
  res.json({ ok: true });
});

r.get('/me', requireAuth, async (req, res) => {
  res.json({ user: await getSelf(req.user!.id), anonAccountAgeHours: getSettings().limits.anonAccountAgeHours });
});

r.post('/verify-email', validate({ body: v.tokenSchema }), async (req, res) => {
  res.json(await authService.verifyEmail(req.body.token));
});

r.post('/resend-verification', requireAuth, async (req, res) => {
  await authService.resendVerification(req.user!.id);
  res.json({ ok: true });
});

r.post('/forgot-password', authLimiter, validate({ body: v.emailSchema }), async (req, res) => {
  await authService.forgotPassword(req.body.email);
  res.json({ ok: true, message: 'If that email is registered, a reset link is on its way.' });
});

r.post('/reset-password', authLimiter, validate({ body: v.resetPasswordSchema }), async (req, res) => {
  await authService.resetPassword(req.body.token, req.body.password);
  res.json({ ok: true });
});

r.post('/change-password', requireAuth, validate({ body: v.changePasswordSchema }), async (req, res) => {
  await authService.changePassword(req.user!.id, req.user!.sessionId, req.body.currentPassword, req.body.newPassword);
  res.json({ ok: true });
});

r.get('/sessions', requireAuth, async (req, res) => {
  res.json({ sessions: await authService.listSessions(req.user!.id, req.user!.sessionId) });
});

r.delete('/sessions', requireAuth, async (req, res) => {
  await authService.revokeOtherSessions(req.user!.id, req.user!.sessionId);
  res.json({ ok: true });
});

r.delete('/sessions/:id', requireAuth, validate({ params: v.idParam }), async (req, res) => {
  await authService.revokeSession(req.user!.id, req.validated!.params.id);
  res.json({ ok: true });
});

r.post('/mfa/setup', requireAuth, async (req, res) => {
  res.json(await authService.mfaSetup(req.user!.id));
});

r.post('/mfa/enable', requireAuth, validate({ body: v.mfaCodeSchema }), async (req, res) => {
  await authService.mfaEnable(req.user!.id, req.body.code);
  res.json({ ok: true });
});

r.post('/mfa/disable', requireAuth, validate({ body: v.mfaDisableSchema }), async (req, res) => {
  await authService.mfaDisable(req.user!.id, req.body.code, req.body.password);
  res.json({ ok: true });
});

export default r;
