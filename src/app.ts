import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import path from 'node:path';
import helmet from 'helmet';
import { corsOrigins, env, isProd } from './config/env.js';
import { UPLOAD_DIR } from './lib/storage.js';
import { attachUser } from './middleware/auth.middleware.js';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';
import { globalLimiter } from './middleware/rateLimit.middleware.js';
import { honeypot, maintenanceGuard, originGuard } from './middleware/security.middleware.js';
import { adminRoutes, moderationRoutes } from './routes/admin.routes.js';
import authRoutes from './routes/auth.routes.js';
import { accountRoutes } from './routes/account.routes.js';
import { callRoutes, commentRoutes, feedRoutes, mediaRoutes, notificationRoutes, settingsRoutes, userRoutes } from './routes/misc.routes.js';
import { storyRoutes } from './routes/story.routes.js';
import { adminFeedbackRoutes, feedbackRoutes } from './routes/feedback.routes.js';
import postRoutes from './routes/post.routes.js';
import { blockRoutes, conversationRoutes, messageRoutes } from './routes/message.routes.js';
import { friendRoutes } from './routes/friend.routes.js';
import { enginePage } from './routes/engine.routes.js';
import { communityRoutes } from './routes/community.routes.js';
import { creatorRoutes, paymentRoutes, paymentWebhook, walletRoutes } from './routes/money.routes.js';
import { adRoutes, businessRoutes } from './routes/ads.routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', env.TRUST_PROXY);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'default-src': ["'none'"],
          'img-src': ["'self'", 'data:'],
          'media-src': ["'self'"],
          'frame-ancestors': ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
      frameguard: { action: 'deny' },
      noSniff: true,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  // CORS — whitelist only, credentials for HttpOnly cookies
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || corsOrigins.includes(origin)),
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      exposedHeaders: ['X-Auth-Expired'],
      maxAge: 600,
    }),
  );

  app.use(honeypot);

  // Local media (only used when R2 isn't configured). Served inert: no scripts, no sniffing.
  app.use(
    '/uploads',
    (_req, res, next) => {
      res.set({
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      next();
    },
    express.static(UPLOAD_DIR, { dotfiles: 'deny', index: false, fallthrough: false }),
  );

  // Brand icons (DualSphere black-hole logo)
  const publicDir = path.resolve(process.cwd(), 'public');
  const iconHeaders = { 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'public, max-age=86400' };
  app.get('/favicon.ico', (_req, res) => res.set(iconHeaders).sendFile(path.join(publicDir, 'favicon.ico')));
  app.get('/icon.png', (_req, res) => res.set(iconHeaders).sendFile(path.join(publicDir, 'icon.png')));

  app.get('/', enginePage);
  app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  // Payment provider webhooks: raw body (signature checks), no cookies, no Origin header — must come before express.json
  app.post('/api/v1/payments/webhooks/:provider', express.raw({ type: '*/*', limit: '256kb' }), paymentWebhook);

  app.use(cookieParser());
  app.use(express.json({ limit: '100kb' }));
  app.use(originGuard);
  app.use(globalLimiter);
  app.use(attachUser);
  app.use(maintenanceGuard);

  const api = express.Router();
  api.use('/auth', authRoutes);
  api.use('/account', accountRoutes);
  api.use('/posts', postRoutes);
  api.use('/feed', feedRoutes);
  api.use('/users', userRoutes);
  api.use('/comments', commentRoutes);
  api.use('/notifications', notificationRoutes);
  api.use('/media', mediaRoutes);
  api.use('/settings', settingsRoutes);
  api.use('/conversations', conversationRoutes);
  api.use('/messages', messageRoutes);
  api.use('/blocks', blockRoutes);
  api.use('/friends', friendRoutes);
  api.use('/calls', callRoutes);
  api.use('/feedback', feedbackRoutes);
  api.use('/admin/feedback', adminFeedbackRoutes);
  api.use('/stories', storyRoutes);
  api.use('/communities', communityRoutes);
  api.use('/creators', creatorRoutes);
  api.use('/wallet', walletRoutes);
  api.use('/payments', paymentRoutes);
  api.use('/business', businessRoutes);
  api.use('/ads', adRoutes);
  api.use('/moderation', moderationRoutes);
  api.use('/admin', adminRoutes);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
