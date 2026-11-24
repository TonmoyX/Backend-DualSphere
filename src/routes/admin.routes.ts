import { Router } from 'express';
import { z } from 'zod';
import { hashIp } from '../lib/crypto.js';
import { forbidden } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { ADMIN_ONLY, ALL_PERMISSIONS, DEFAULT_MODERATOR_PERMISSIONS, PERMISSIONS } from '../lib/permissions.js';
import { hasPermission, requirePermission, requireRole } from '../middleware/rbac.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { abuseService } from '../services/abuse.service.js';
import { adminCommunityService } from '../services/admin-community.service.js';
import { adminFinanceService } from '../services/admin-finance.service.js';
import { adsService, deleteCreative } from '../services/ads.service.js';
import { adsManager } from '../services/ads-manager.service.js';
import { businessService } from '../services/business.service.js';
import { paymentService } from '../services/payment.service.js';
import { payoutService } from '../services/payout.service.js';
import { adminService } from '../services/admin.service.js';
import { auditService } from '../services/audit.service.js';
import { authService } from '../services/auth.service.js';
import { identityService } from '../services/identity.service.js';
import { suspensionService } from '../services/suspension.service.js';
import { investigationService } from '../services/investigation.service.js';
import { mediaService } from '../services/media.service.js';
import { adminPurge, moderationService } from '../services/moderation.service.js';
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
// ── Admin: "Delete permanently" (erased from the database, audit-logged, can't be undone) ──
moderationRoutes.delete('/posts/:id/purge', requireRole('admin'), validate({ params: v.idParam }), async (req, res) => res.json(await adminPurge.post(req.validated!.params.id, req.user!)));
moderationRoutes.delete('/comments/:id/purge', requireRole('admin'), validate({ params: v.idParam }), async (req, res) => res.json(await adminPurge.comment(req.validated!.params.id, req.user!)));
moderationRoutes.delete('/appeals/:id', requireRole('admin'), validate({ params: v.idParam }), async (req, res) => res.json(await adminPurge.appeal(req.validated!.params.id, req.user!)));

// Admin: permanently delete a report (+ all reports on the same item); ?content=true also deletes the item itself
moderationRoutes.delete('/reports/:id', requireRole('admin'), validate({ params: v.idParam, query: z.object({ content: z.enum(['true', 'false']).default('false') }) }), async (req, res) => {
  res.json(await moderationService.deleteReport(req.validated!.params.id, req.user!, req.validated!.query.content === 'true'));
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

// Review requests from suspended accounts
moderationRoutes.get('/appeals', requirePermission('users.ban'), validate({ query: v.adminListQuery }), async (req, res) => {
  const { status, page, limit } = req.validated!.query;
  res.json(await suspensionService.list(status, page, limit));
});
moderationRoutes.get('/appeals/count', requirePermission('users.ban'), async (_req, res) => {
  res.json(await suspensionService.list('pending', 1, 1).then((r) => ({ pending: r.total })));
});
moderationRoutes.post(
  '/appeals/:id',
  requirePermission('users.ban'),
  validate({ params: v.idParam, body: z.object({ decision: z.enum(['approve', 'reject']), response: z.string().trim().max(1000).optional() }) }),
  async (req, res) => {
    res.json(await suspensionService.decide(req.validated!.params.id, req.user!, req.body.decision, req.body.response));
  },
);

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

// ── Investigations (admin only): one case = one user, 2FA + reason, 30 minutes, every view audit-logged ──
adminRoutes.post(
  '/investigations',
  requireRole('admin'),
  validate({ body: z.object({ targetUserId: v.uuid, reason: z.string().trim().min(10, 'Provide a detailed reason (min 10 chars)').max(500), mfaCode: z.string().regex(/^\d{6}$/).optional() }) }),
  async (req: any, res) => {
    if (getSettings().moderation.requireMfaForIdentityLookup) {
      if (!req.user.mfaEnabled) throw forbidden('MFA_REQUIRED', 'Enable two-factor authentication to open investigations');
      if (!(await authService.verifyUserTotp(req.user.id, req.body.mfaCode))) throw forbidden('INVALID_MFA', 'A valid 6-digit authenticator code is required');
    }
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ case: await investigationService.open(req.user, req.body.targetUserId, req.body.reason, hashIp(req.ip)) });
  },
);
adminRoutes.get('/investigations', requireRole('admin'), validate({ query: v.adminListQuery }), async (req, res) => {
  res.json(await investigationService.list(req.validated!.query.page, req.validated!.query.limit));
});
adminRoutes.get('/investigations/:id', requireRole('admin'), validate({ params: v.idParam }), async (req, res) => {
  res.json({ case: await investigationService.get(req.validated!.params.id, req.user!) });
});
adminRoutes.post('/investigations/:id/close', requireRole('admin'), validate({ params: v.idParam }), async (req, res) => {
  res.json(await investigationService.close(req.validated!.params.id, req.user!));
});
adminRoutes.get('/investigations/:id/conversations', requireRole('admin'), validate({ params: v.idParam }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ conversations: await investigationService.conversations(req.validated!.params.id, req.user!) });
});
adminRoutes.get('/investigations/:id/conversations/:cid', requireRole('admin'), validate({ params: v.idParam.extend({ cid: v.uuid }) }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await investigationService.messages(req.validated!.params.id, req.user!, req.validated!.params.cid));
});
adminRoutes.get('/investigations/:id/anonymous-posts', requireRole('admin'), validate({ params: v.idParam }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ posts: await investigationService.anonymousPosts(req.validated!.params.id, req.user!) });
});
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

adminRoutes.get('/abuse-flags', requirePermission('abuse.view'), validate({ query: z.object({ status: z.enum(['open', 'resolved']).default('open') }) }), async (req, res) => {
  res.json(await abuseService.flagged(req.validated!.query.status));
});
adminRoutes.post('/abuse-flags/posts/:id/dismiss', requirePermission('posts.moderate'), validate({ params: v.idParam }), async (req, res) => {
  await abuseService.dismiss(req.validated!.params.id, req.user!);
  res.json({ ok: true });
});
adminRoutes.post('/abuse-flags/posts/:id/reopen', requirePermission('posts.moderate'), validate({ params: v.idParam }), async (req, res) => {
  await abuseService.reopen(req.validated!.params.id, req.user!);
  res.json({ ok: true });
});

// ── Ads (DualSphere Next · Phase 3) ──
adminRoutes.get('/ads/review', requirePermission('ads.review'), validate({ query: z.object({ status: z.enum(['live', 'pending_review', 'approved', 'rejected', 'all']).default('live') }) }), async (req, res) => {
  res.json(await adsService.reviewQueue(req.validated!.query.status));
});
adminRoutes.post('/ads/creatives/:id/review', requirePermission('ads.review'), validate({ params: v.idParam, body: z.object({ approve: z.boolean(), reason: z.string().trim().max(300).optional() }) }), async (req, res) => {
  res.json(await adsService.review(req.user!, req.validated!.params.id, req.body.approve, req.body.reason));
});
// Permanent delete — needs advertiser-management rights, a reason, and is audited
adminRoutes.delete('/ads/creatives/:id', requirePermission('ads.manage'), validate({ params: v.idParam, body: z.object({ reason: z.string().trim().min(3).max(300) }) }), async (req, res) => {
  res.json(await deleteCreative(req.user!, req.validated!.params.id, req.body.reason));
});
// Ads overview, every campaign, user reports on ads
const adRange = z.enum(['today', '7d', '30d', 'lifetime']).default('7d');
adminRoutes.get('/ads/overview', requirePermission('ads.manage'), validate({ query: z.object({ range: adRange }) }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await adsManager.staffOverview(req.validated!.query.range));
});
adminRoutes.get('/ads/campaigns', requirePermission('ads.manage'), validate({ query: z.object({ status: z.string().max(20).optional(), q: z.string().trim().max(60).optional() }) }), async (req, res) => {
  res.json(await adsManager.staffCampaigns(req.validated!.query));
});
adminRoutes.post('/ads/campaigns/:id/status', requirePermission('ads.manage'), validate({ params: v.idParam, body: z.object({ action: z.enum(['pause', 'resume', 'end']), reason: z.string().trim().max(300).optional() }) }), async (req, res) => {
  res.json(await adsManager.staffCampaignStatus(req.user!, req.validated!.params.id, req.body.action, req.body.reason));
});
adminRoutes.get('/ads/reports', requirePermission('ads.review'), validate({ query: z.object({ status: z.enum(['open', 'dismissed', 'actioned']).default('open') }) }), async (req, res) => {
  res.json(await adsManager.staffReports(req.validated!.query.status));
});
adminRoutes.post('/ads/reports/:id', requirePermission('ads.review'), validate({ params: v.idParam, body: z.object({ action: z.enum(['dismiss', 'takedown']), reason: z.string().trim().max(300).optional() }) }), async (req, res) => {
  res.json(await adsManager.resolveReports(req.user!, req.validated!.params.id, req.body.action, req.body.reason));
});
adminRoutes.delete('/ads/reports/:id', requireRole('admin'), validate({ params: v.idParam }), async (req, res) => res.json(await adminPurge.adReports(req.validated!.params.id, req.user!)));
adminRoutes.delete('/communities/:id/purge', requireRole('admin'), validate({ params: v.idParam }), async (req, res) => res.json(await adminPurge.community(req.validated!.params.id, req.user!)));
adminRoutes.get('/advertisers', requirePermission('ads.manage'), validate({ query: z.object({ status: z.string().max(20).optional(), q: z.string().trim().max(60).optional() }) }), async (req, res) => {
  res.json(await businessService.staffList(req.validated!.query.status, req.validated!.query.q || undefined));
});
adminRoutes.post('/advertisers/:id/verify', requirePermission('ads.manage'), validate({ params: v.idParam, body: z.object({ approve: z.boolean(), note: z.string().trim().max(300).optional() }) }), async (req, res) => {
  res.json(await businessService.staffVerify(req.user!, req.validated!.params.id, req.body.approve, req.body.note));
});
adminRoutes.post('/advertisers/:id/status', requirePermission('ads.manage'), validate({ params: v.idParam, body: z.object({
  verification: z.enum(['unverified', 'pending', 'verified', 'rejected']),
  badge: z.enum(['none', 'verified', 'official', 'partner', 'trusted']),
  note: z.string().trim().max(300).optional(),
}).strict() }), async (req, res) => {
  res.json(await businessService.staffSetStatus(req.user!, req.validated!.params.id, req.body));
});
// Erases the page and all its money records: admins only, the page name typed to confirm, audited
adminRoutes.delete('/advertisers/:id', requireRole('admin'), requirePermission('ads.manage'), validate({ params: v.idParam, body: z.object({ confirmName: z.string().trim().min(1).max(80) }) }), async (req, res) => {
  res.json(await businessService.staffPurge(req.user!, req.validated!.params.id, req.body.confirmName));
});
adminRoutes.post('/advertisers/:id/suspend', requirePermission('ads.manage'), validate({ params: v.idParam, body: z.object({ suspended: z.boolean(), reason: z.string().trim().max(300).optional() }) }), async (req, res) => {
  res.json(await businessService.staffSuspend(req.user!, req.validated!.params.id, req.body.suspended, req.body.reason));
});

// ── Creators, payouts, KYC, payments (Phase 2) ──
adminRoutes.get('/payouts', requirePermission('payouts.view'), validate({ query: v.adminListQuery }), async (req, res) => {
  const { status, page, limit } = req.validated!.query;
  res.json(await payoutService.staffList(status, page, limit));
});
adminRoutes.get('/payouts/:id/details', requirePermission('payouts.approve'), validate({ params: v.idParam }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await payoutService.staffMethodDetails(req.user!, req.validated!.params.id));
});
adminRoutes.post('/payouts/:id', requirePermission('payouts.approve'), validate({ params: v.idParam, body: z.object({
  action: z.enum(['approve', 'mark_paid', 'reject']), providerRef: z.string().trim().max(100).optional(), reason: z.string().trim().max(300).optional(),
}) }), async (req, res) => res.json(await payoutService.staffDecide(req.user!, req.validated!.params.id, req.body)));
const reasonBody = z.object({ reason: z.string().trim().min(3).max(300) });
const toggleBody = (key: 'hold' | 'suspended') => z.object({ [key]: z.boolean(), reason: z.string().trim().max(300).optional() } as Record<string, z.ZodTypeAny>);
adminRoutes.post('/payouts/:id/hold', requirePermission('payouts.approve'), validate({ params: v.idParam, body: toggleBody('hold') }), async (req, res) => {
  res.json(await payoutService.staffPayoutHold(req.user!, req.validated!.params.id, req.body.hold, req.body.reason));
});
adminRoutes.delete('/payouts/:id', requirePermission('payouts.approve'), validate({ params: v.idParam, body: reasonBody }), async (req, res) => {
  res.json(await payoutService.staffPayoutDelete(req.user!, req.validated!.params.id, req.body.reason));
});
adminRoutes.post('/creators/:id/payouts-suspend', requirePermission('payouts.approve'), validate({ params: v.idParam, body: toggleBody('suspended') }), async (req, res) => {
  res.json(await payoutService.staffSuspendPayouts(req.user!, req.validated!.params.id, req.body.suspended, req.body.reason));
});
adminRoutes.post('/kyc/:id/hold', requirePermission('payouts.approve'), validate({ params: v.idParam, body: toggleBody('hold') }), async (req, res) => {
  res.json(await payoutService.staffKycHold(req.user!, req.validated!.params.id, req.body.hold, req.body.reason));
});
adminRoutes.post('/kyc/:id/suspend', requirePermission('payouts.approve'), validate({ params: v.idParam, body: toggleBody('suspended') }), async (req, res) => {
  res.json(await payoutService.staffKycSuspend(req.user!, req.validated!.params.id, req.body.suspended, req.body.reason));
});
adminRoutes.delete('/kyc/:id', requirePermission('payouts.approve'), validate({ params: v.idParam, body: reasonBody }), async (req, res) => {
  res.json(await payoutService.staffKycDelete(req.user!, req.validated!.params.id, req.body.reason));
});
adminRoutes.get('/kyc', requirePermission('payouts.view'), validate({ query: z.object({ status: z.string().max(20).optional() }) }), async (req, res) => {
  res.json(await payoutService.staffKycList(req.validated!.query.status));
});
adminRoutes.get('/kyc/:id/reveal', requirePermission('payouts.approve'), validate({ params: v.idParam }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await payoutService.staffKycReveal(req.user!, req.validated!.params.id));
});
adminRoutes.post('/kyc/:id', requirePermission('payouts.approve'), validate({ params: v.idParam, body: z.object({ approve: z.boolean(), notes: z.string().trim().max(300).optional() }) }), async (req, res) => {
  res.json(await payoutService.staffKycDecide(req.user!, req.validated!.params.id, req.body.approve, req.body.notes));
});
adminRoutes.get('/payments', requirePermission('finance.view'), validate({ query: v.adminListQuery.extend({ purpose: z.string().max(20).optional() }) }), async (req, res) => {
  const { status, purpose, page, limit } = req.validated!.query;
  res.json(await adminFinanceService.payments({ status, purpose, page, limit }));
});
// Refunds move money: admins only (plus the permission), reason required, audited
adminRoutes.post('/payments/:id/refund', requireRole('admin'), requirePermission('payouts.approve'), validate({ params: v.idParam, body: z.object({ reason: z.string().trim().min(3).max(300) }) }), async (req, res) => {
  res.json(await paymentService.refund(req.user!, req.validated!.params.id, req.body.reason));
});
adminRoutes.delete('/payments/:id', requireRole('admin'), requirePermission('payouts.approve'), validate({ params: v.idParam, body: z.object({ reason: z.string().trim().min(3).max(300) }) }), async (req, res) => {
  res.json(await paymentService.remove(req.user!, req.validated!.params.id, req.body.reason));
});
adminRoutes.get('/revenue', requirePermission('finance.view'), async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await adminFinanceService.revenue());
});

// ── Communities (DualSphere Next) ──
adminRoutes.get('/communities', requirePermission('communities.view'), validate({ query: v.adminListQuery }), async (req, res) => {
  const { q, status, page, limit } = req.validated!.query;
  res.json(await adminCommunityService.list({ q, status, page, limit }));
});
adminRoutes.get('/communities/:id', requirePermission('communities.view'), validate({ params: v.idParam }), async (req, res) => {
  res.json(await adminCommunityService.get(req.validated!.params.id));
});
adminRoutes.post('/communities/:id/suspend', requirePermission('communities.manage'), validate({ params: v.idParam, body: z.object({ suspended: z.boolean(), reason: z.string().trim().max(300).optional() }) }), async (req, res) => {
  res.json(await adminCommunityService.setSuspended(req.validated!.params.id, req.user!, req.body.suspended, req.body.reason));
});
adminRoutes.post('/communities/:id/feature', requirePermission('communities.manage'), validate({ params: v.idParam, body: z.object({ featured: z.boolean() }) }), async (req, res) => {
  res.json(await adminCommunityService.setFeatured(req.validated!.params.id, req.user!, req.body.featured));
});
adminRoutes.post('/communities/:id/transfer', requirePermission('communities.manage'), validate({ params: v.idParam, body: z.object({ username: v.username, reason: z.string().trim().min(3).max(300) }) }), async (req, res) => {
  res.json(await adminCommunityService.transfer(req.validated!.params.id, req.user!, req.body.username, req.body.reason));
});
adminRoutes.post('/communities/:id/delete', requirePermission('communities.manage'), validate({ params: v.idParam, body: z.object({ deleted: z.boolean(), reason: z.string().trim().max(300).optional() }) }), async (req, res) => {
  res.json(await adminCommunityService.setDeleted(req.validated!.params.id, req.user!, req.body.deleted, req.body.reason));
});

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
  await auditService.log({ actorId: req.user!.id, actorRole: req.user!.role, action: 'MEDIA_DELETE', targetId: m.id, targetType: 'media', metadata: { key: m.object_key, removedPosts: m.removedPosts } });
  res.json({ ok: true });
});
