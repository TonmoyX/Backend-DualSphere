import { Router } from 'express';
import { z } from 'zod';
import { query } from '../config/db.js';
import { emit } from '../lib/realtime.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { adminPurge } from '../services/moderation.service.js';
import { reportLimiter } from '../middleware/rateLimit.middleware.js';
import { requirePermission, requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import * as v from '../validators/index.js';

// ── /feedback — "Report a problem" (any signed-in user) ──
export const feedbackRoutes = Router();
feedbackRoutes.post(
  '/',
  requireAuth,
  reportLimiter,
  validate({
    body: z.object({
      category: z.enum(['bug', 'account', 'safety', 'idea', 'other']).default('bug'),
      message: z.string().trim().min(5, 'Tell us a bit more (at least 5 characters)').max(2000),
      pageUrl: z.string().max(500).optional(),
    }),
  }),
  async (req, res) => {
    await query(
      'INSERT INTO feedback (user_id, category, message, page_url, user_agent) VALUES ($1, $2, $3, $4, $5)',
      [req.user!.id, req.body.category, req.body.message, req.body.pageUrl ?? null, String(req.headers['user-agent'] ?? '').slice(0, 300)],
    );
    emit.staff('admin:feedback', { category: req.body.category });
    res.status(201).json({ ok: true });
  },
);

// ── /admin/feedback — staff inbox ──
export const adminFeedbackRoutes = Router();
adminFeedbackRoutes.use(requireAuth, requireRole('moderator'), requirePermission('feedback.view'));

adminFeedbackRoutes.get('/', validate({ query: v.adminListQuery }), async (req, res) => {
  const { page, limit, status } = req.validated!.query;
  const params: unknown[] = [limit, (page - 1) * limit];
  let where = '';
  if (status && status !== 'all') {
    params.push(status);
    where = `WHERE f.status = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT f.*, u.username, u.display_name, u.avatar_url, count(*) OVER() AS total
       FROM feedback f LEFT JOIN users u ON u.id = f.user_id ${where}
      ORDER BY (f.status = 'new') DESC, f.created_at DESC LIMIT $1 OFFSET $2`,
    params,
  );
  res.json({
    total: rows[0]?.total ?? 0,
    items: rows.map((r) => ({
      id: r.id, category: r.category, message: r.message, pageUrl: r.page_url, userAgent: r.user_agent, status: r.status, createdAt: r.created_at,
      user: r.user_id ? { id: r.user_id, username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url } : null,
    })),
  });
});

adminFeedbackRoutes.patch('/:id', validate({ params: v.idParam, body: z.object({ status: z.enum(['new', 'resolved']) }) }), async (req, res) => {
  await query('UPDATE feedback SET status = $2 WHERE id = $1', [req.validated!.params.id, req.body.status]);
  res.json({ ok: true });
});

// Admin: delete a feedback item permanently
adminFeedbackRoutes.delete('/:id', requireRole('admin'), validate({ params: v.idParam }), async (req, res) => {
  res.json(await adminPurge.feedback(req.validated!.params.id, req.user!));
});
