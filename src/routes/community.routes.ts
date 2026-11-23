// /api/v1/communities — every write needs a signed-in user and is rate-limited; every handler
// re-checks the caller's community role server-side (the UI hiding a button is never the guard).
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.middleware.js';
import { communityLimiter } from '../middleware/rateLimit.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { communityService } from '../services/community.service.js';
import * as v from '../validators/index.js';

export const communityRoutes = Router();
const auth = [requireAuth, communityLimiter];
const slug = (req: any) => req.validated!.params.slug as string;

// Browse
communityRoutes.get('/', validate({ query: z.object({ q: z.string().trim().max(60).optional(), page: z.coerce.number().int().min(1).max(100).default(1), limit: z.coerce.number().int().min(1).max(50).default(24) }) }), async (req, res) => {
  const { q, page, limit } = req.validated!.query;
  res.json(await communityService.discover(req.user, q || undefined, page, limit));
});
communityRoutes.get('/mine', requireAuth, async (req, res) => res.json(await communityService.mine(req.user!)));
communityRoutes.post('/', ...auth, validate({ body: v.createCommunitySchema }), async (req, res) => {
  res.status(201).json(await communityService.create(req.user!, req.body));
});

// One community
communityRoutes.get('/:slug', validate({ params: v.communitySlugParam, query: z.object({ invite: z.string().regex(/^[A-Za-z0-9_-]{12,40}$/).optional() }) }), async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json(await communityService.get(slug(req), req.user, 'slug', req.validated!.query.invite));
});
communityRoutes.patch('/:slug', ...auth, validate({ params: v.communitySlugParam, body: v.updateCommunitySchema }), async (req, res) => {
  res.json(await communityService.update(slug(req), req.user!, req.body));
});
communityRoutes.delete('/:slug', ...auth, validate({ params: v.communitySlugParam, body: v.communityDeleteSchema }), async (req, res) => {
  res.json(await communityService.remove(slug(req), req.user!, req.body.confirmName));
});
communityRoutes.put('/:slug/rules', ...auth, validate({ params: v.communitySlugParam, body: v.communityRulesSchema }), async (req, res) => {
  res.json(await communityService.setRules(slug(req), req.user!, req.body.rules));
});
communityRoutes.get('/:slug/posts', validate({ params: v.communitySlugParam, query: v.pageQuery }), async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const { cursor, limit } = req.validated!.query;
  res.json(await communityService.feed(slug(req), req.user, cursor, limit));
});

// Membership
communityRoutes.post('/:slug/join', ...auth, validate({ params: v.communitySlugParam, body: v.joinCommunitySchema }), async (req, res) => {
  res.json(await communityService.join(slug(req), req.user!, req.body));
});
communityRoutes.post('/:slug/leave', ...auth, validate({ params: v.communitySlugParam }), async (req, res) => {
  res.json(await communityService.leave(slug(req), req.user!));
});
communityRoutes.get('/:slug/members', validate({ params: v.communitySlugParam, query: z.object({ q: z.string().trim().max(60).optional() }) }), async (req, res) => {
  res.json(await communityService.members(slug(req), req.user, req.validated!.query.q || undefined));
});

// Moderation (owner / community mods)
communityRoutes.get('/:slug/requests', requireAuth, validate({ params: v.communitySlugParam }), async (req, res) => {
  res.json(await communityService.requests(slug(req), req.user!));
});
communityRoutes.post('/:slug/requests/:userId', ...auth, validate({ params: v.communityMemberParam, body: v.communityDecisionSchema }), async (req, res) => {
  res.json(await communityService.decideRequest(slug(req), req.user!, req.validated!.params.userId, req.body.approve));
});
communityRoutes.put('/:slug/members/:userId/role', ...auth, validate({ params: v.communityMemberParam, body: v.communityRoleSchema }), async (req, res) => {
  res.json(await communityService.setRole(slug(req), req.user!, req.validated!.params.userId, req.body.role));
});
communityRoutes.post('/:slug/members/:userId/remove', ...auth, validate({ params: v.communityMemberParam, body: v.communityRemoveSchema }), async (req, res) => {
  res.json(await communityService.removeMember(slug(req), req.user!, req.validated!.params.userId, req.body));
});
communityRoutes.post('/:slug/members/:userId/mute', ...auth, validate({ params: v.communityMemberParam, body: v.communityMuteSchema }), async (req, res) => {
  res.json(await communityService.mute(slug(req), req.user!, req.validated!.params.userId, req.body.hours));
});
communityRoutes.get('/:slug/bans', requireAuth, validate({ params: v.communitySlugParam }), async (req, res) => {
  res.json(await communityService.bans(slug(req), req.user!));
});
communityRoutes.delete('/:slug/bans/:userId', ...auth, validate({ params: v.communityMemberParam }), async (req, res) => {
  res.json(await communityService.unban(slug(req), req.user!, req.validated!.params.userId));
});
communityRoutes.post('/:slug/transfer', ...auth, validate({ params: v.communitySlugParam, body: v.communityTransferSchema }), async (req, res) => {
  res.json(await communityService.transfer(slug(req), req.user!, req.body.userId));
});
communityRoutes.get('/:slug/invites', requireAuth, validate({ params: v.communitySlugParam }), async (req, res) => {
  res.json(await communityService.invites(slug(req), req.user!));
});
communityRoutes.post('/:slug/invites', ...auth, validate({ params: v.communitySlugParam, body: v.communityInviteSchema }), async (req, res) => {
  res.status(201).json(await communityService.createInvite(slug(req), req.user!, req.body));
});
communityRoutes.delete('/:slug/invites/:code', ...auth, validate({ params: v.communityInviteParam }), async (req, res) => {
  res.json(await communityService.revokeInvite(slug(req), req.user!, req.validated!.params.code));
});
communityRoutes.get('/:slug/pending', requireAuth, validate({ params: v.communitySlugParam }), async (req, res) => {
  res.json(await communityService.pending(slug(req), req.user!));
});
communityRoutes.post('/:slug/posts/:postId/decision', ...auth, validate({ params: v.communityPostParam, body: v.communityDecisionSchema }), async (req, res) => {
  res.json(await communityService.decidePost(slug(req), req.user!, req.validated!.params.postId, req.body.approve, req.body.reason));
});
communityRoutes.post('/:slug/posts/:postId/remove', ...auth, validate({ params: v.communityPostParam, body: v.removeSchema }), async (req, res) => {
  res.json(await communityService.removePost(slug(req), req.user!, req.validated!.params.postId, req.body.reason));
});
communityRoutes.post('/:slug/posts/:postId/pin', ...auth, validate({ params: v.communityPostParam, body: z.object({ pinned: z.boolean() }) }), async (req, res) => {
  res.json(await communityService.pin(slug(req), req.user!, req.validated!.params.postId, req.body.pinned));
});
communityRoutes.get('/:slug/modlog', requireAuth, validate({ params: v.communitySlugParam }), async (req, res) => {
  res.json(await communityService.modLog(slug(req), req.user!));
});
