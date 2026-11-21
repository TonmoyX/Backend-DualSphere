import { Router } from 'express';
import { z } from 'zod';
import { hashIp } from '../lib/crypto.js';
import { forbidden } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { ADMIN_ONLY, ALL_PERMISSIONS, DEFAULT_MODERATOR_PERMISSIONS, PERMISSIONS } from '../lib/permissions.js';
import { hasPermission, requirePermission, requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { abuseService } from '../services/abuse.service.js';
import { adminService } from '../services/admin.service.js';
import { auditService } from '../services/audit.service.js';
import { authService } from '../services/auth.service.js';
import { identityService } from '../services/identity.service.js';
import { mediaService } from '../services/media.service.js';
import { moderationService } from '../services/moderation.service.js';
import { getSettings, updateSettings } from '../services/settings.service.js';
import * as v from '../validators/index.js';

// ═══ /moderation — moderator+ ═══
export const moderationRoutes = Router();
moderationRoutes.use(requireAuth, requireRole('moderator'));

moderationRoutes.get('/reports', requirePermission('reports.view'), validate({ query: v.adminListQuery }), async (req, res) => {
  const { status, page, limit } = req.validated!.query;
  res.json(await moderationService.listReports(status ?? 'pending', page, limit));
});
moderationRoutes.patch('/reports/:id', requirePermission('reports.resolve'), validate({ params: v.idParam, body: v.reportUpdateSchema }), async (req, res) => {
  // Acting on a report needs the matching power too (banning → users.ban, removing → posts/comments.moderate)
  if (req.body.action === 'ban_author' && !hasPermission(req.user, 'users.ban')) throw forbidden('NO_PERMISSION', "You don't have permission to ban users");
  if (req.body.action === 'remove_content' && !(hasPermission(req.user, 'posts.moderate') && hasPermission(req.user, 'comments.moderate'))) {
    throw forbidden('NO_PERMISSION', "You don't have permission to remove content");
  }
  await moderationService.updateReport(req.validated!.params.id, req.user!, req.body);
  res.json({ ok: true });
});
moderationRoutes.delete('/posts/:id', requirePermission('posts.moderate'), validate({ params: v.idParam, body: v.removeSchema }), async (req, res) => {
  await moderationService.removePost(req.validated!.params.id, req.user!, req.body.reason);
  res.json({ ok: true });
});
moderationRoutes.post('/posts/:id/restore', requirePermission('posts.moderate'), validate({ params: v.idParam }), async (req, res) => {
  await moderationService.restorePost(req.validated!.params.id, req.user!);
  res.json({ ok: true });
});
moderationRoutes.delete('/comments/:id', requirePermission('comments.moderate'), validate({ params: v.idParam, body: v.removeSchema }), async (req, res) => {
  await moderationService.removeComment(req.validated!.params.id, req.user!, req.body.reason);
  res.json({ ok: true });
});
moderationRoutes.post('/comments/:id/restore', requirePermission('comments.moderate'), validate({ params: v.idParam }), async (req, res) => {
  await moderationService.restoreComment(req.validated!.params.id, req.user!);
  res.json({ ok: true });
});
moderationRoutes.post('/users/:id/ban', requirePermission('users.ban'), validate({ params: v.idParam, body: v.banSchema }), async (req, res) => {
  await moderationService.banUser(req.validated!.params.id, req.user!, req.body.reason, req.body.durationHours);
  res.json({ ok: true });
});
moderationRoutes.post('/users/:id/unban', requirePermission('users.ban'), validate({ params: v.idParam }), async (req, res) => {
  await moderationService.unbanUser(req.validated!.params.id, req.user!);
  res.json({ ok: true });
});

// ═══ /admin ═══
export const adminRoutes = Router();
adminRoutes.use(requireAuth);

// Staff (moderator+) read views used by the admin panel
adminRoutes.get('/stats', requirePermission('dashboard.view'), async (_req, res) => res.json(await adminService.stats()));
adminRoutes.get('/users', requirePermission('users.view'), validate({ query: v.adminListQuery }), async (req, res) => {
  res.json(await adminService.listUsers(req.validated!.query));
});
adminRoutes.get('/users/:id', requirePermission('users.view'), validate({ params: v.idParam }), async (req, res) => {
  res.json({ user: await adminService.getUser(req.validated!.params.id) });
});
adminRoutes.get('/posts', requirePermission('posts.view'), validate({ query: v.adminListQuery }), async (req, res) => {
  res.json(await adminService.listPosts(req.validated!.query));
});
adminRoutes.get('/comments', requirePermission('comments.view'), validate({ query: v.adminListQuery }), async (req, res) => {
  res.json(await adminService.listComments(req.validated!.query));
});

// Admin-only
adminRoutes.patch('/users/:id', requirePermission('users.manage'), validate({ params: v.idParam, body: v.adminUserUpdateSchema }), async (req, res) => {
  if (req.body.role !== undefined && req.user!.role !== 'admin') throw forbidden('ADMIN_ONLY', 'Only admins can change roles');
  res.json({ user: await adminService.updateUser(req.validated!.params.id, req.user!, req.body) });
});
adminRoutes.delete('/users/:id', requireRole('admin'), validate({ params: v.idParam }), async (req, res) => {
  await adminService.deleteUser(req.validated!.params.id, req.user!);
  res.json({ ok: true });
});
// ── Moderator permissions (admin only) ──
adminRoutes.get('/permissions', requireRole('moderator'), (_req, res) => {
  res.json({ permissions: PERMISSIONS, defaults: DEFAULT_MODERATOR_PERMISSIONS, adminOnly: ADMIN_ONLY });
});
adminRoutes.put('/users/:id/permissions', requireRole('admin'), validate({ params: v.idParam, body: z.object({ permissions: z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])).max(50).nullable() }) }), async (req, res) => {
  res.json(await adminService.setPermissions(req.validated!.params.id, req.user!, req.body.permissions));
});
adminRoutes.post('/users/:id/reset-mfa', requirePermission('users.manage'), validate({ params: v.idParam }), async (req, res) => {
  await adminService.resetMfa(req.validated!.params.id, req.user!);
  res.json({ ok: true });
});
adminRoutes.post('/users/:id/revoke-sessions', requirePermission('users.manage'), validate({ params: v.idParam }), async (req, res) => {
  await adminService.revokeSessions(req.validated!.params.id, req.user!);
  res.json({ ok: true });
});

/**
 * De-anonymisation. Admin + reason + (by default) a fresh TOTP code. The audit entry is
 * written before the decrypt. POST keeps the reason out of URLs/access logs; GET alias kept for spec parity.
 */
const identityHandler = async (req: any, res: any) => {
  const input = v.identityLookupSchema.parse(req.method === 'GET' ? req.query : req.body);
  if (getSettings().moderation.requireMfaForIdentityLookup) {
    if (!req.user.mfaEnabled) throw forbidden('MFA_REQUIRED', 'Enable two-factor authentication to perform identity lookups');
    if (!(await authService.verifyUserTotp(req.user.id, input.mfaCode))) throw forbidden('INVALID_MFA', 'A valid 6-digit authenticator code is required');
  }
  res.set('Cache-Control', 'no-store');
  res.json(await identityService.lookupPostAuthor(req.validated.params.postId, req.user, input.reason, hashIp(req.ip)));
};
adminRoutes.post('/identity/:postId', requireRole('admin'), validate({ params: v.postIdParam }), identityHandler);
adminRoutes.get('/identity/:postId', requireRole('admin'), validate({ params: v.postIdParam }), identityHandler);

adminRoutes.get('/audit-logs', requirePermission('audit.view'), validate({ query: v.auditQuery }), async (req, res) => {
  res.json(await adminService.auditLogs(req.validated!.query));
});
adminRoutes.get('/audit-logs/verify', requirePermission('audit.view'), async (_req, res) => {
  res.json(await auditService.verifyChain());
});
adminRoutes.get('/audit-logs/:id/verify', requirePermission('audit.view'), validate({ params: z.object({ id: z.coerce.number().int().positive() }) }), async (req, res) => {
  res.json({ valid: await auditService.verify(req.validated!.params.id) });
});

adminRoutes.get('/abuse-flags', requirePermission('abuse.view'), async (_req, res) => res.json(await abuseService.flagged()));

adminRoutes.get('/settings', requirePermission('settings.manage'), (_req, res) => res.json(getSettings()));
adminRoutes.put('/settings', requirePermission('settings.manage'), validate({ body: z.record(z.string(), z.unknown()) }), async (req, res) => {
  const before = getSettings();
  const after = await updateSettings(req.body, req.user!.id);
  await auditService.log({
    actorId: req.user!.id, actorRole: req.user!.role, action: 'SETTINGS_UPDATE', targetType: 'settings',
    metadata: { sections: Object.keys(req.body), before: Object.fromEntries(Object.keys(req.body).map((k) => [k, (before as any)[k]])) },
  });
  res.json(after);
});

adminRoutes.get('/media', requirePermission('media.view'), validate({ query: v.adminListQuery.extend({ kind: z.enum(['image', 'video']).optional() }) }), async (req, res) => {
  const { page, limit, kind } = req.validated!.query;
  res.json(await mediaService.list(page, limit, kind));
});
adminRoutes.delete('/media/:id', requirePermission('media.delete'), validate({ params: v.idParam }), async (req, res) => {
  const m = await mediaService.adminDelete(req.validated!.params.id);
  await auditService.log({ actorId: req.user!.id, actorRole: req.user!.role, action: 'MEDIA_DELETE', targetId: m.id, targetType: 'media', metadata: { key: m.object_key } });
  res.json({ ok: true });
});
