// /business and /ads — Ads Manager + AI Ad Studio (Phase 3).
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.middleware.js';
import { adEventLimiter, aiJobLimiter, communityLimiter } from '../middleware/rateLimit.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { adStudioService } from '../services/ad-studio.service.js';
import { adsService } from '../services/ads.service.js';
import { adsManager } from '../services/ads-manager.service.js';
import { businessService, CATEGORIES } from '../services/business.service.js';
import * as v from '../validators/index.js';

const uuid = z.string().uuid();
const slug = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/);
const https = z.string().trim().url().max(500).refine((u) => u.startsWith('https://'), 'Use an https:// link');
const cta = z.enum(['learn_more', 'shop_now', 'message', 'sign_up', 'book_now']);
const money = z.number().int().positive().max(100_000_000);

// ── /business ──
export const businessRoutes = Router();
businessRoutes.use(requireAuth);
businessRoutes.get('/', async (req, res) => res.json(await businessService.mine(req.user!)));
businessRoutes.post('/', communityLimiter, validate({ body: z.object({
  name: z.string().trim().min(2).max(60), slug, description: z.string().trim().max(1000).default(''),
  category: z.enum(CATEGORIES), website: https.optional(),
}).strict() }), async (req, res) => res.status(201).json(await businessService.create(req.user!, req.body)));
businessRoutes.get('/:id', validate({ params: z.object({ id: z.string().trim().max(40) }) }), async (req, res) => {
  res.json(await businessService.get(req.validated!.params.id, req.user));
});
businessRoutes.patch('/:id', communityLimiter, validate({ params: v.idParam, body: z.object({
  name: z.string().trim().min(2).max(60).optional(), description: z.string().trim().max(1000).optional(),
  category: z.enum(CATEGORIES).optional(), website: https.nullable().optional(), logoMediaId: uuid.nullable().optional(),
}).strict() }), async (req, res) => res.json(await businessService.update(req.validated!.params.id, req.user!, req.body)));
businessRoutes.delete('/:id', communityLimiter, validate({ params: v.idParam, body: z.object({ confirmName: z.string().trim().min(1).max(60) }).strict() }), async (req, res) => {
  res.json(await businessService.remove(req.validated!.params.id, req.user!, req.body.confirmName));
});
businessRoutes.post('/:id/verification', communityLimiter, validate({ params: v.idParam }), async (req, res) => {
  res.json(await businessService.requestVerification(req.validated!.params.id, req.user!));
});
businessRoutes.post('/:id/members', communityLimiter, validate({ params: v.idParam, body: z.object({ username: v.username, role: z.enum(['admin', 'analyst']) }).strict() }), async (req, res) => {
  res.json(await businessService.addMember(req.validated!.params.id, req.user!, req.body.username, req.body.role));
});
businessRoutes.delete('/:id/members/:userId', validate({ params: z.object({ id: uuid, userId: uuid }) }), async (req, res) => {
  res.json(await businessService.removeMember(req.validated!.params.id, req.user!, req.validated!.params.userId));
});

// ── /ads ──
export const adRoutes = Router();

// Delivery (signed-in or not). The token returned with an ad authorises its impression/click beacons.
adRoutes.get('/slot', validate({ query: z.object({
  placement: z.enum(['feed', 'sidebar', 'reels']).default('feed'),
  exclude: z.string().max(400).optional(), // comma-separated creative ids already on screen
}) }), async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const exclude = (req.validated!.query.exclude ?? '').split(',').filter((x: string) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 10);
  res.json(await adsService.slot(req.user, req.ip, req.validated!.query.placement, exclude));
});
adRoutes.post('/events', adEventLimiter, validate({ body: z.object({ token: z.string().min(40).max(300), kind: z.enum(['impression', 'click']) }).strict() }), async (req, res) => {
  res.json(await adsService.event(req.user, req.ip, req.body.token, req.body.kind));
});

// Ads Manager
const creative = z.object({
  headline: z.string().trim().min(1).max(90), body: z.string().trim().max(600).default(''), cta,
  linkUrl: https.nullable().optional(), mediaIds: z.array(uuid).max(5).default([]), hashtags: z.array(z.string().trim().max(30)).max(6).default([]),
  claimsConfirmed: z.boolean().default(false),
}).strict();
const targeting = z.object({
  geo: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  ageMin: z.number().int().min(13).max(100).default(18), ageMax: z.number().int().min(13).max(100).default(65),
  interests: z.array(z.string().trim().min(1).max(40)).max(15).default([]),
  genders: z.array(z.enum(['male', 'female'])).max(2).default([]),
}).strict();
const objective = z.enum(['awareness', 'traffic', 'engagement', 'messages', 'leads', 'sales']);
const placement = z.enum(['feed', 'sidebar', 'reels']);
const adSet = z.object({
  name: z.string().trim().max(80).optional(), targeting: targeting.optional(), placements: z.array(placement).min(1).max(3).optional(),
  billingEvent: z.enum(['impression', 'click']).optional(), bidStrategy: z.enum(['lowest_cost', 'bid_cap']).optional(),
  bidCpmMinor: money.optional(), bidCpcMinor: money.optional(), frequencyCap: z.number().int().min(1).max(20).optional(),
}).strict();
const range = z.enum(['today', '7d', '30d', 'lifetime']).default('7d');
adRoutes.get('/campaigns', requireAuth, validate({ query: z.object({ businessId: uuid, archived: z.enum(['0', '1']).default('0') }) }), async (req, res) => {
  res.json(await adsService.listCampaigns(req.user!, req.validated!.query.businessId, req.validated!.query.archived === '1'));
});
adRoutes.post('/campaigns', requireAuth, communityLimiter, validate({ body: z.object({
  businessId: uuid, name: z.string().trim().min(2).max(80), objective,
  dailyBudgetMinor: money, totalBudgetMinor: money.nullable().optional(), startsAt: z.string().datetime().optional(), endsAt: z.string().datetime().nullable().optional(),
  targeting: targeting.optional(), bidCpmMinor: money.optional(), adSet: adSet.optional(), creatives: z.array(creative).min(1).max(5), submit: z.boolean().default(true),
}).strict() }), async (req, res) => res.status(201).json(await adsService.createCampaign(req.user!, req.body)));
adRoutes.get('/campaigns/:id', requireAuth, validate({ params: v.idParam }), async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json(await adsService.getCampaign(req.user!, req.validated!.params.id));
});
adRoutes.post('/campaigns/:id/status', requireAuth, communityLimiter, validate({ params: v.idParam, body: z.object({ action: z.enum(['pause', 'resume', 'submit', 'end']) }) }), async (req, res) => {
  res.json(await adsService.setCampaignStatus(req.user!, req.validated!.params.id, req.body.action));
});
adRoutes.patch('/campaigns/:id/budget', requireAuth, communityLimiter, validate({ params: v.idParam, body: z.object({
  dailyBudgetMinor: money.optional(), totalBudgetMinor: money.nullable().optional(), endsAt: z.string().datetime().nullable().optional(),
}).strict() }), async (req, res) => res.json(await adsService.updateBudget(req.user!, req.validated!.params.id, req.body)));
// ── Ads Manager: edit, duplicate, delete, ad sets, ads, reports ──
adRoutes.get('/insights', requireAuth, validate({ query: z.object({ businessId: uuid, range }) }), async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json(await adsManager.businessInsights(req.user!, req.validated!.query.businessId, req.validated!.query.range));
});
adRoutes.get('/billing', requireAuth, validate({ query: z.object({ businessId: uuid }) }), async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json(await adsManager.billing(req.user!, req.validated!.query.businessId));
});
adRoutes.post('/audience-estimate', requireAuth, communityLimiter, validate({ body: z.object({ targeting }).strict() }), async (req, res) => {
  res.json(await adsManager.audienceEstimate(req.body.targeting));
});
adRoutes.get('/campaigns/:id/insights', requireAuth, validate({ params: v.idParam, query: z.object({ range }) }), async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json(await adsManager.campaignInsights(req.user!, req.validated!.params.id, req.validated!.query.range));
});
adRoutes.patch('/campaigns/:id', requireAuth, communityLimiter, validate({ params: v.idParam, body: z.object({
  name: z.string().trim().min(2).max(80).optional(), dailyBudgetMinor: money.optional(), totalBudgetMinor: money.nullable().optional(),
  startsAt: z.string().datetime().optional(), endsAt: z.string().datetime().nullable().optional(),
}).strict() }), async (req, res) => res.json(await adsManager.updateCampaign(req.user!, req.validated!.params.id, req.body)));
adRoutes.post('/campaigns/:id/duplicate', requireAuth, communityLimiter, validate({ params: v.idParam }), async (req, res) => {
  res.status(201).json(await adsManager.duplicateCampaign(req.user!, req.validated!.params.id));
});
adRoutes.delete('/campaigns/:id', requireAuth, communityLimiter, validate({ params: v.idParam }), async (req, res) => {
  res.json(await adsManager.deleteCampaign(req.user!, req.validated!.params.id));
});
adRoutes.post('/campaigns/:id/adsets', requireAuth, communityLimiter, validate({ params: v.idParam, body: adSet.extend({ creatives: z.array(creative).max(5).default([]) }) }), async (req, res) => {
  res.status(201).json(await adsManager.addAdSet(req.user!, req.validated!.params.id, req.body));
});
adRoutes.patch('/adsets/:id', requireAuth, communityLimiter, validate({ params: v.idParam, body: adSet }), async (req, res) => {
  res.json(await adsManager.updateAdSet(req.user!, req.validated!.params.id, req.body));
});
adRoutes.post('/adsets/:id/status', requireAuth, communityLimiter, validate({ params: v.idParam, body: z.object({ action: z.enum(['pause', 'resume']) }).strict() }), async (req, res) => {
  res.json(await adsManager.setAdSetStatus(req.user!, req.validated!.params.id, req.body.action));
});
adRoutes.delete('/adsets/:id', requireAuth, communityLimiter, validate({ params: v.idParam }), async (req, res) => {
  res.json(await adsManager.deleteAdSet(req.user!, req.validated!.params.id));
});
adRoutes.post('/adsets/:id/creatives', requireAuth, communityLimiter, validate({ params: v.idParam, body: z.object({ creatives: z.array(creative).min(1).max(5) }).strict() }), async (req, res) => {
  res.status(201).json(await adsManager.addCreatives(req.user!, req.validated!.params.id, req.body.creatives));
});
adRoutes.patch('/creatives/:id', requireAuth, communityLimiter, validate({ params: v.idParam, body: creative }), async (req, res) => {
  res.json(await adsManager.updateCreative(req.user!, req.validated!.params.id, req.body));
});
adRoutes.post('/creatives/:id/status', requireAuth, communityLimiter, validate({ params: v.idParam, body: z.object({ action: z.enum(['pause', 'resume']) }).strict() }), async (req, res) => {
  res.json(await adsManager.setCreativeStatus(req.user!, req.validated!.params.id, req.body.action));
});
adRoutes.delete('/creatives/:id', requireAuth, communityLimiter, validate({ params: v.idParam }), async (req, res) => {
  res.json(await adsManager.deleteCreative(req.user!, req.validated!.params.id));
});
// People in the feed: why this ad, hide it, report it (the token proves they were shown it)
const adToken = z.string().min(40).max(300);
adRoutes.post('/why', adEventLimiter, validate({ body: z.object({ token: adToken }).strict() }), async (req, res) => {
  res.json(await adsManager.why(req.user, req.ip, req.body.token));
});
adRoutes.post('/hide', requireAuth, adEventLimiter, validate({ body: z.object({ token: adToken, scope: z.enum(['ad', 'business']) }).strict() }), async (req, res) => {
  res.json(await adsManager.hide(req.user!, req.ip, req.body.token, req.body.scope));
});
adRoutes.post('/report', requireAuth, adEventLimiter, validate({ body: z.object({
  token: adToken, reason: z.enum(['misleading', 'scam', 'offensive', 'sexual', 'violence', 'prohibited', 'other']), details: z.string().trim().max(500).optional(),
}).strict() }), async (req, res) => res.json(await adsManager.report(req.user!, req.ip, req.body.token, req.body.reason, req.body.details)));
adRoutes.post('/creatives/:id/confirm-claims', requireAuth, validate({ params: v.idParam }), async (req, res) => {
  res.json(await adsService.confirmClaims(req.user!, req.validated!.params.id));
});

// AI Ad Studio
adRoutes.get('/studio', requireAuth, (_req, res) => res.json(adStudioService.status()));
adRoutes.post('/studio/jobs', requireAuth, aiJobLimiter, validate({ body: z.object({
  businessId: uuid, mediaIds: z.array(uuid).max(6).default([]), productName: z.string().trim().min(1).max(120),
  concept: z.string().trim().max(2000).default(''), language: z.enum(['en', 'bn', 'banglish']).default('banglish'),
  goal: z.enum(['sales', 'messages', 'awareness']).default('sales'), dailyBudgetMinor: money, autoPublish: z.boolean().default(false),
  linkUrl: https.optional(), geo: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
}).strict() }), async (req, res) => res.status(201).json(await adStudioService.create(req.user!, req.body)));
adRoutes.get('/studio/jobs', requireAuth, validate({ query: z.object({ businessId: uuid }) }), async (req, res) => {
  res.json(await adStudioService.list(req.user!, req.validated!.query.businessId));
});
adRoutes.get('/studio/jobs/:id', requireAuth, validate({ params: v.idParam }), async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json(await adStudioService.get(req.user!, req.validated!.params.id));
});
