import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.middleware.js';
import { messageLimiter, reportLimiter } from '../middleware/rateLimit.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { messageService } from '../services/message.service.js';
import * as v from '../validators/index.js';

const EMOJI = z.string().min(1).max(8);

// ── /conversations ──
export const conversationRoutes = Router();
conversationRoutes.use(requireAuth);

conversationRoutes.get('/', validate({ query: z.object({ folder: z.enum(['primary', 'requests']).default('primary'), q: z.string().trim().max(60).optional() }) }), async (req, res) => {
  const { folder, q } = req.validated!.query;
  res.json({ conversations: await messageService.list(req.user!.id, folder, q || undefined) });
});

conversationRoutes.get('/unread-count', async (req, res) => {
  res.json(await messageService.unreadCounts(req.user!.id));
});

conversationRoutes.post('/', validate({ body: z.object({ userIds: z.array(v.uuid).min(1).max(31), title: z.string().trim().max(60).optional() }) }), async (req, res) => {
  res.status(201).json({ conversation: await messageService.create(req.user!, req.body.userIds, req.body.title) });
});

conversationRoutes.get('/:id', validate({ params: v.idParam }), async (req, res) => {
  res.json({ conversation: await messageService.get(req.validated!.params.id, req.user!.id) });
});

conversationRoutes.patch('/:id', validate({ params: v.idParam, body: z.object({ title: z.string().trim().max(60).nullable().optional(), muted: z.boolean().optional(), avatarMediaId: v.uuid.nullable().optional() }) }), async (req, res) => {
  res.json({ conversation: await messageService.update(req.validated!.params.id, req.user!, req.body) });
});

conversationRoutes.post('/:id/accept', validate({ params: v.idParam }), async (req, res) => {
  res.json({ conversation: await messageService.accept(req.validated!.params.id, req.user!.id) });
});

conversationRoutes.delete('/:id', validate({ params: v.idParam }), async (req, res) => {
  await messageService.removeForMe(req.validated!.params.id, req.user!.id);
  res.json({ ok: true });
});

conversationRoutes.post('/:id/leave', validate({ params: v.idParam }), async (req, res) => {
  await messageService.leave(req.validated!.params.id, req.user!);
  res.json({ ok: true });
});

conversationRoutes.post('/:id/members', validate({ params: v.idParam, body: z.object({ userIds: z.array(v.uuid).min(1).max(31) }) }), async (req, res) => {
  res.json({ conversation: await messageService.addMembers(req.validated!.params.id, req.user!, req.body.userIds) });
});

conversationRoutes.get('/:id/messages', validate({ params: v.idParam, query: z.object({ before: z.string().max(200).optional() }) }), async (req, res) => {
  res.json(await messageService.messages(req.validated!.params.id, req.user!.id, req.validated!.query.before));
});

conversationRoutes.post(
  '/:id/messages',
  messageLimiter,
  validate({
    params: v.idParam,
    body: z.object({
      content: z.string().max(2000).optional(),
      mediaIds: z.array(v.uuid).max(10).optional(),
      replyToId: v.uuid.nullable().optional(),
      heart: z.boolean().optional(),
      clientId: z.string().max(64).optional(),
      voiceDuration: z.number().positive().max(3600).optional(),
      anonymous: z.boolean().optional(), // group chats only
    }),
  }),
  async (req, res) => {
    res.status(201).json({ message: await messageService.send(req.validated!.params.id, req.user!, req.body) });
  },
);

conversationRoutes.get('/:id/search', validate({ params: v.idParam, query: z.object({ q: z.string().trim().min(1).max(100) }) }), async (req, res) => {
  res.json({ messages: await messageService.search(req.validated!.params.id, req.user!.id, req.validated!.query.q) });
});

conversationRoutes.put('/:id/pin-message', validate({ params: v.idParam, body: z.object({ messageId: v.uuid.nullable() }) }), async (req, res) => {
  res.json({ conversation: await messageService.pinMessage(req.validated!.params.id, req.user!, req.body.messageId) });
});

conversationRoutes.put('/:id/pin', validate({ params: v.idParam, body: z.object({ pinned: z.boolean() }) }), async (req, res) => {
  res.json({ conversation: await messageService.pinChat(req.validated!.params.id, req.user!.id, req.body.pinned) });
});

conversationRoutes.post('/:id/read', validate({ params: v.idParam }), async (req, res) => {
  await messageService.markRead(req.validated!.params.id, req.user!.id);
  res.json({ ok: true });
});

// ── /messages ──
export const messageRoutes = Router();
messageRoutes.use(requireAuth);

messageRoutes.post('/:id/react', validate({ params: v.idParam, body: z.object({ emoji: EMOJI.nullable() }) }), async (req, res) => {
  res.json(await messageService.react(req.validated!.params.id, req.user!.id, req.body.emoji));
});

// ?scope=everyone (default, sender only) → unsend for all · ?scope=me → remove just for me
messageRoutes.delete('/:id', validate({ params: v.idParam, query: z.object({ scope: z.enum(['everyone', 'me']).default('everyone') }) }), async (req, res) => {
  if (req.validated!.query.scope === 'me') await messageService.hideMessageForMe(req.validated!.params.id, req.user!.id);
  else await messageService.unsend(req.validated!.params.id, req.user!.id);
  res.json({ ok: true });
});

messageRoutes.patch('/:id', messageLimiter, validate({ params: v.idParam, body: z.object({ content: z.string().max(2000) }) }), async (req, res) => {
  res.json({ message: await messageService.edit(req.validated!.params.id, req.user!.id, req.body.content) });
});

messageRoutes.post('/:id/forward', messageLimiter, validate({ params: v.idParam, body: z.object({ conversationIds: z.array(v.uuid).min(1).max(20) }) }), async (req, res) => {
  res.json(await messageService.forward(req.validated!.params.id, req.user!, req.body.conversationIds));
});

messageRoutes.post('/:id/report', reportLimiter, validate({ params: v.idParam, body: v.reportSchema }), async (req, res) => {
  res.status(201).json(await messageService.report(req.validated!.params.id, req.user!, req.body.reason, req.body.details));
});

// ── /blocks ──
export const blockRoutes = Router();
blockRoutes.use(requireAuth);
blockRoutes.get('/', async (req, res) => res.json({ blocks: await messageService.listBlocks(req.user!.id) }));
blockRoutes.post('/:id', validate({ params: v.idParam }), async (req, res) => {
  await messageService.block(req.user!.id, req.validated!.params.id);
  res.json({ ok: true });
});
blockRoutes.delete('/:id', validate({ params: v.idParam }), async (req, res) => {
  await messageService.unblock(req.user!.id, req.validated!.params.id);
  res.json({ ok: true });
});
