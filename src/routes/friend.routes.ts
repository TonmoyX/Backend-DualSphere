import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.middleware.js';
import { friendLimiter } from '../middleware/rateLimit.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { friendService } from '../services/friend.service.js';
import * as v from '../validators/index.js';

export const friendRoutes = Router();
friendRoutes.use(requireAuth);

friendRoutes.get('/', validate({ query: z.object({ q: z.string().trim().max(60).optional() }) }), async (req, res) => {
  res.json({ friends: await friendService.list(req.user!.id, req.user!.id, req.validated!.query.q || undefined, 500) });
});
friendRoutes.get('/counts', async (req, res) => res.json(await friendService.counts(req.user!.id)));
friendRoutes.get('/requests', async (req, res) => res.json({ requests: await friendService.incoming(req.user!.id) }));
friendRoutes.get('/requests/sent', async (req, res) => res.json({ requests: await friendService.outgoing(req.user!.id) }));
friendRoutes.get('/suggestions', validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }) }), async (req, res) => {
  res.json({ suggestions: await friendService.suggestions(req.user!.id, req.validated!.query.limit) });
});
friendRoutes.post('/suggestions/:id/dismiss', validate({ params: v.idParam }), async (req, res) => {
  await friendService.dismissSuggestion(req.user!.id, req.validated!.params.id);
  res.json({ ok: true });
});

friendRoutes.post('/requests/:id', friendLimiter, validate({ params: v.idParam }), async (req, res) => {
  res.json(await friendService.send(req.user!.id, req.validated!.params.id));
});
friendRoutes.delete('/requests/:id', validate({ params: v.idParam }), async (req, res) => {
  res.json(await friendService.cancel(req.user!.id, req.validated!.params.id));
});
friendRoutes.post('/requests/:id/accept', validate({ params: v.idParam }), async (req, res) => {
  res.json(await friendService.accept(req.user!.id, req.validated!.params.id));
});
friendRoutes.post('/requests/:id/decline', validate({ params: v.idParam }), async (req, res) => {
  res.json(await friendService.decline(req.user!.id, req.validated!.params.id));
});
friendRoutes.delete('/:id', validate({ params: v.idParam }), async (req, res) => {
  res.json(await friendService.unfriend(req.user!.id, req.validated!.params.id));
});
