import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { env } from './config/env.js';
import { errorHandler, notFound } from './lib/errors.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { meRouter } from './modules/me/me.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { uploadsRouter } from './modules/uploads/uploads.routes.js';
import { feedRouter, postsRouter } from './modules/posts/posts.routes.js';

export function createApp() {
  const app = express();

  if (env.TRUST_PROXY) {
    app.set('trust proxy', env.TRUST_PROXY);
  }
  app.disable('x-powered-by');
  app.use(helmet());
  const origins = env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
  // Native apps don't send an Origin header; this only matters for web tools.
  app.use(cors({ origin: origins.length ? origins : false }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, db: mongoose.connection.readyState === 1 ? 'up' : 'down' });
  });

  app.use('/v1/auth', authRouter);
  app.use('/v1/me', meRouter);
  app.use('/v1/users', usersRouter);
  app.use('/v1/uploads', uploadsRouter);
  app.use('/v1/feed', feedRouter);
  app.use('/v1/posts', postsRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
