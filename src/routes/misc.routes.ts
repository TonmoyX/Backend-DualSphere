import express, { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../lib/errors.js';
import { verifyUploadToken } from '../lib/jwt.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { friendLimiter, reportLimiter, uploadLimiter } from '../middleware/rateLimit.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { commentService } from '../services/comment.service.js';
import { getFeed, getMyAnonymous, getSaved } from '../services/feed.service.js';
import { markSeen } from '../services/feed-ranking.service.js';
import { query } from '../config/db.js';
import { mediaService } from '../services/media.service.js';
import { notificationService } from '../services/notification.service.js';
import { postService } from '../services/post.service.js';
import { publicSettings } from '../services/settings.service.js';
import { userService } from '../services/user.service.js';
import * as v from '../validators/index.js';
import { env } from '../config/env.js';

// ── /feed ──
export const feedRoutes = Router();
feedRoutes.get('/', validate({ query: v.feedQuery }), async (req, res) => {
  res.json(await getFeed({ ...req.validated!.query, viewer: req.user }));
});

// Posts the viewer saw in the feed — ranking pushes them down next time (POST /feed/seen)
const uuidList = z.array(z.string().uuid()).min(1).max(50);
feedRoutes.post('/seen', requireAuth, validate({ body: z.object({ postIds: uuidList }).strict() }), async (req, res) => {
  await markSeen(req.user!.id, req.body.postIds);
  res.status(204).end();
});
// "Hide post" (and undo)
feedRoutes.post('/hide/:id', requireAuth, validate({ params: v.idParam }), async (req, res) => {
  await query('INSERT INTO post_hides (user_id, post_id) SELECT $1, id FROM posts WHERE id = $2 ON CONFLICT DO NOTHING', [req.user!.id, req.validated!.params.id]);
  res.json({ ok: true });
});
feedRoutes.delete('/hide/:id', requireAuth, validate({ params: v.idParam }), async (req, res) => {
  await query('DELETE FROM post_hides WHERE user_id = $1 AND post_id = $2', [req.user!.id, req.validated!.params.id]);
  res.json({ ok: true });
});
// "Snooze <person> for 30 days" (and undo). Only real (identity) authors can be snoozed.
feedRoutes.post('/snooze/:id', requireAuth, validate({ params: v.idParam }), async (req, res) => {
  if (req.validated!.params.id === req.user!.id) throw badRequest('SELF', "You can't snooze yourself");
  const r = await query(
    `INSERT INTO author_snoozes (user_id, author_id, until) SELECT $1, id, now() + interval '30 days' FROM users WHERE id = $2
     ON CONFLICT (user_id, author_id) DO UPDATE SET until = EXCLUDED.until RETURNING until`,
    [req.user!.id, req.validated!.params.id],
  );
  if (!r.rowCount) throw badRequest('NOT_FOUND', 'User not found');
  res.json({ ok: true, until: r.rows[0].until });
});
feedRoutes.delete('/snooze/:id', requireAuth, validate({ params: v.idParam }), async (req, res) => {
  await query('DELETE FROM author_snoozes WHERE user_id = $1 AND author_id = $2', [req.user!.id, req.validated!.params.id]);
  res.json({ ok: true });
});

// Your own anonymous posts — only ever for yourself (GET /feed/my-anonymous)
feedRoutes.get('/my-anonymous', requireAuth, validate({ query: v.pageQuery }), async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const { cursor, limit } = req.validated!.query;
  res.json(await getMyAnonymous(req.user!, cursor, limit));
});

// Your saved posts (GET /feed/saved)
feedRoutes.get('/saved', requireAuth, validate({ query: v.pageQuery }), async (req, res) => {
  const { cursor, limit } = req.validated!.query;
  res.json(await getSaved(req.user!, cursor, limit));
});

// ── /users ──
export const userRoutes = Router();
userRoutes.get('/', validate({ query: z.object({ q: z.string().trim().min(1).max(50) }) }), async (req, res) => {
  res.json({ users: await userService.search(req.validated!.query.q) });
});
userRoutes.put('/me', requireAuth, validate({ body: v.updateMeSchema }), async (req, res) => {
  res.json({ user: await userService.updateMe(req.user!, req.body) });
});
userRoutes.get('/:username', validate({ params: z.object({ username: v.username }) }), async (req, res) => {
  res.json({ user: await userService.profile(req.validated!.params.username, req.user) });
});
userRoutes.get('/:username/friends', validate({ params: z.object({ username: v.username }) }), async (req, res) => {
  res.json(await userService.friendsOf(req.validated!.params.username, req.user));
});
userRoutes.get('/:username/followers', validate({ params: z.object({ username: v.username }) }), async (req, res) => {
  res.json(await userService.followList(req.validated!.params.username, 'followers', req.user));
});
userRoutes.get('/:username/following', validate({ params: z.object({ username: v.username }) }), async (req, res) => {
  res.json(await userService.followList(req.validated!.params.username, 'following', req.user));
});
userRoutes.post('/:username/follow', requireAuth, friendLimiter, validate({ params: z.object({ username: v.username }) }), async (req, res) => {
  res.json(await userService.follow(req.validated!.params.username, req.user!, true));
});
userRoutes.delete('/:username/follow', requireAuth, validate({ params: z.object({ username: v.username }) }), async (req, res) => {
  res.json(await userService.follow(req.validated!.params.username, req.user!, false));
});
userRoutes.post('/:username/report', requireAuth, reportLimiter, validate({ params: z.object({ username: v.username }), body: v.reportSchema }), async (req, res) => {
  res.status(201).json(await userService.report(req.validated!.params.username, req.user!, req.body.reason, req.body.details));
});
userRoutes.get('/:username/reels', validate({ params: z.object({ username: v.username }), query: z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(60).default(24) }) }), async (req, res) => {
  const { page, limit } = req.validated!.query;
  res.json(await userService.reels(req.validated!.params.username, req.user, page, limit));
});
userRoutes.get('/:username/photos', validate({ params: z.object({ username: v.username }), query: z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(90).default(30) }) }), async (req, res) => {
  const { page, limit } = req.validated!.query;
  res.json(await userService.photos(req.validated!.params.username, req.user, page, limit));
});
userRoutes.get('/:username/posts', validate({ params: z.object({ username: v.username }), query: v.pageQuery }), async (req, res) => {
  const { cursor, limit } = req.validated!.query;
  res.json(await userService.posts(req.validated!.params.username, cursor, limit, req.user));
});

// ── /comments ──
export const commentRoutes = Router();
commentRoutes.delete('/:id', requireAuth, validate({ params: v.idParam }), async (req, res) => {
  await commentService.remove(req.validated!.params.id, req.user!);
  res.json({ ok: true });
});
commentRoutes.post('/:id/like', requireAuth, validate({ params: v.idParam }), async (req, res) => {
  res.json(await commentService.toggleLike(req.validated!.params.id, req.user!));
});
commentRoutes.post('/:id/report', requireAuth, reportLimiter, validate({ params: v.idParam, body: v.reportSchema }), async (req, res) => {
  res.status(201).json(await postService.report('comment', req.validated!.params.id, req.user!, req.body.reason, req.body.details));
});

// ── /notifications ──
export const notificationRoutes = Router();
notificationRoutes.use(requireAuth);
notificationRoutes.get('/', validate({ query: v.pageQuery }), async (req, res) => {
  const { cursor, limit } = req.validated!.query;
  res.json(await notificationService.list(req.user!.id, cursor, limit));
});
notificationRoutes.get('/unread-count', async (req, res) => {
  res.json({ count: await notificationService.unreadCount(req.user!.id) });
});
notificationRoutes.post('/read', validate({ body: z.object({ ids: z.array(v.uuid).max(100).optional() }) }), async (req, res) => {
  await notificationService.markRead(req.user!.id, req.body.ids);
  res.json({ ok: true });
});

// ── /media ──
export const mediaRoutes = Router();
mediaRoutes.post('/presign', requireAuth, uploadLimiter, validate({ body: v.presignSchema }), async (req, res) => {
  res.json(await mediaService.presign(req.user!.id, req.body));
});
mediaRoutes.post('/:id/complete', requireAuth, validate({ params: v.idParam }), async (req, res) => {
  res.json({ media: await mediaService.complete(req.user!.id, req.validated!.params.id) });
});
// Local-disk driver target (authorised by the signed token in the URL, like an R2 presigned URL)
mediaRoutes.put('/local-upload', express.raw({ type: () => true, limit: '520mb' }), async (req, res) => {
  const token = verifyUploadToken(String(req.query.token ?? ''));
  if (!token) throw badRequest('BAD_UPLOAD_TOKEN', 'Upload link expired');
  await mediaService.receiveLocal(token, req.headers['content-type'], req.body as Buffer);
  res.status(200).json({ ok: true });
});

// ── /calls/config — ICE servers for WebRTC ──
export const callRoutes = Router();
callRoutes.get('/config', requireAuth, (_req, res) => {
  const iceServers: { urls: string | string[]; username?: string; credential?: string }[] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  if (env.TURN_URLS) {
    iceServers.push({ urls: env.TURN_URLS.split(',').map((u) => u.trim()), username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ iceServers });
});

// ── /settings (public, drives the frontend) ──
export const settingsRoutes = Router();
settingsRoutes.get('/public', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=15');
  res.json(publicSettings());
});
