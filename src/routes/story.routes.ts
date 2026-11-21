import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.middleware.js';
import { messageLimiter, postCreateLimiter } from '../middleware/rateLimit.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { storyService } from '../services/story.service.js';
import * as v from '../validators/index.js';

export const storyRoutes = Router();
storyRoutes.use(requireAuth);

storyRoutes.get('/feed', async (req, res) => res.json({ groups: await storyService.feed(req.user!.id) }));
storyRoutes.get('/backgrounds', (_req, res) => res.json({ backgrounds: storyService.backgrounds }));

storyRoutes.post(
  '/',
  postCreateLimiter,
  validate({
    body: z.object({
      mediaId: v.uuid.optional(),
      text: z.string().max(500).optional(),
      background: z.string().max(200).optional(),
      audience: z.enum(['friends', 'public']).default('friends'),
    }),
  }),
  async (req, res) => res.status(201).json({ story: await storyService.create(req.user!, req.body) }),
);

storyRoutes.post('/:id/view', validate({ params: v.idParam }), async (req, res) => {
  await storyService.view(req.validated!.params.id, req.user!.id);
  res.json({ ok: true });
});
storyRoutes.get('/:id/viewers', validate({ params: v.idParam }), async (req, res) => {
  res.json({ viewers: await storyService.viewers(req.validated!.params.id, req.user!.id) });
});
storyRoutes.post('/:id/reply', messageLimiter, validate({ params: v.idParam, body: z.object({ content: z.string().trim().min(1).max(1000) }) }), async (req, res) => {
  res.json(await storyService.reply(req.validated!.params.id, req.user!, req.body.content));
});
storyRoutes.post('/:id/react', messageLimiter, validate({ params: v.idParam, body: z.object({ emoji: z.string().min(1).max(16).nullable() }) }), async (req, res) => {
  res.json(await storyService.react(req.validated!.params.id, req.user!, req.body.emoji));
});
storyRoutes.delete('/:id', validate({ params: v.idParam }), async (req, res) => {
  await storyService.remove(req.validated!.params.id, req.user!.id);
  res.json({ ok: true });
});
