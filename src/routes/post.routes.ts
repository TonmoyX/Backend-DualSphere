import { Router, type RequestHandler } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { anonPostLimiter, commentLimiter, postCreateLimiter, reportLimiter } from '../middleware/rateLimit.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { commentService } from '../services/comment.service.js';
import { postService } from '../services/post.service.js';
import * as v from '../validators/index.js';

const r = Router();

// Identity post — linked to the profile
r.post('/', requireAuth, postCreateLimiter, validate({ body: v.createPostSchema }), async (req, res) => {
  res.status(201).json({ post: await postService.create({ ...req.body, mode: 'identity', user: req.user! }) });
});

// Anonymous post — identity stored encrypted, separately; stricter throttle
r.post('/anonymous', requireAuth, postCreateLimiter, anonPostLimiter, validate({ body: v.createPostSchema }), async (req, res) => {
  res.status(201).json({ post: await postService.create({ ...req.body, mode: 'anonymous', user: req.user! }) });
});

r.get('/:postId', validate({ params: v.postIdParam }), async (req, res) => {
  res.json({ post: await postService.get(req.validated!.params.postId, req.user) });
});

r.delete('/:postId', requireAuth, validate({ params: v.postIdParam }), async (req, res) => {
  await postService.remove(req.validated!.params.postId, req.user!);
  res.json({ ok: true });
});

// Author only: edit the text and/or change who can share (works for your anonymous posts too)
// Text/tag edits share the hourly post limit (edit-spam, re-tag notification spam); share-policy toggles stay unthrottled as before
const editLimiter: RequestHandler = (req, res, next) => (req.body?.content !== undefined || req.body?.tagIds !== undefined || req.body?.mediaIds !== undefined ? postCreateLimiter(req, res, next) : next());
r.patch('/:postId', requireAuth, editLimiter, validate({ params: v.postIdParam, body: v.updatePostSchema }), async (req, res) => {
  const id = req.validated!.params.postId;
  const { content, sharePolicy, tagIds, mediaIds } = req.body as { content?: string; sharePolicy?: 'everyone' | 'friends' | 'none'; tagIds?: string[]; mediaIds?: string[] };
  const out: Record<string, unknown> = {};
  if (content !== undefined || tagIds !== undefined || mediaIds !== undefined) out.post = await postService.edit(id, req.user!, { content, tagIds, mediaIds });
  if (sharePolicy !== undefined) Object.assign(out, await postService.setSharePolicy(id, req.user!, sharePolicy));
  res.json(out);
});

// A tagged person removes themselves from a post
r.delete('/:postId/tags/me', requireAuth, validate({ params: v.postIdParam }), async (req, res) => {
  res.json(await postService.untagSelf(req.validated!.params.postId, req.user!));
});

r.post('/:postId/share', requireAuth, postCreateLimiter, validate({ params: v.postIdParam, body: v.sharePostSchema }), async (req, res) => {
  res.status(201).json({ post: await postService.share(req.validated!.params.postId, req.user!, req.body) });
});

r.post('/:postId/save', requireAuth, validate({ params: v.postIdParam }), async (req, res) => {
  res.json(await postService.setSaved(req.validated!.params.postId, req.user!, true));
});
r.delete('/:postId/save', requireAuth, validate({ params: v.postIdParam }), async (req, res) => {
  res.json(await postService.setSaved(req.validated!.params.postId, req.user!, false));
});

r.post('/:postId/like', requireAuth, validate({ params: v.postIdParam }), async (req, res) => {
  res.json(await postService.toggleLike(req.validated!.params.postId, req.user!));
});

r.get('/:postId/comments', validate({ params: v.postIdParam, query: v.pageQuery.extend({ limit: v.pageQuery.shape.limit.default(200) }) }), async (req, res) => {
  const { cursor, limit } = req.validated!.query;
  res.json(await commentService.list(req.validated!.params.postId, req.user, cursor, limit));
});

r.post('/:postId/comments', requireAuth, commentLimiter, validate({ params: v.postIdParam, body: v.commentSchema }), async (req, res) => {
  res.status(201).json({ comment: await commentService.create(req.validated!.params.postId, req.user!, req.body) });
});

r.post('/:postId/report', requireAuth, reportLimiter, validate({ params: v.postIdParam, body: v.reportSchema }), async (req, res) => {
  res.status(201).json(await postService.report('post', req.validated!.params.postId, req.user!, req.body.reason, req.body.details));
});

export default r;
