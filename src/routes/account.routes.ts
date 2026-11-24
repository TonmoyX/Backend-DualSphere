import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { unauthorized } from '../lib/errors.js';
import { requireSuspended } from '../middleware/auth.middleware.js';
import { reportLimiter } from '../middleware/rateLimit.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { suspensionService } from '../services/suspension.service.js';

// ── /account — works for suspended accounts too (their session is limited to these + logout) ──
export const accountRoutes = Router();

// Suspension page: reason, until, review status. A restored account gets { suspended: false } so the page can move on.
accountRoutes.get('/suspension', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  if (req.user) return void res.json({ suspended: false });
  if (!req.suspended) throw unauthorized();
  res.json(await suspensionService.status(req.suspended));
});

// "Request review"
accountRoutes.post('/suspension/appeal', requireSuspended, reportLimiter, validate({ body: z.object({ message: z.string().trim().min(10).max(2000) }).strict() }), async (req, res) => {
  res.status(201).json(await suspensionService.appeal(req.suspended!, req.body.message));
});

// "Download your information" — your profile and every post you made (identity + your anonymous ones), as JSON
const selfOrSuspended = (req: Request, _res: Response, next: NextFunction) => {
  if (req.user || req.suspended) return next();
  throw unauthorized();
};
accountRoutes.get('/export', selfOrSuspended, reportLimiter, async (req, res) => {
  const userId = req.user?.id ?? req.suspended!.id;
  const data = await suspensionService.export(userId);
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', `attachment; filename="dualsphere-${data.account.username}-${data.exportedAt.slice(0, 10)}.json"`);
  res.json(data);
});
