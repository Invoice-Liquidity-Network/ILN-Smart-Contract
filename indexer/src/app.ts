import express from 'express';
import type Database from 'better-sqlite3';
import { createLeaderboardRouter } from './api/routes/leaderboard.js';
import { createReputationRouter } from './api/routes/reputation.js';
import { createStatsRouter } from './api/routes/stats.js';
import { createInvoicesRouter } from './api/routes/invoices.js';
import { config } from './config.js';
import { createApiKeyMiddleware } from './middleware/apiKey.js';
import { createRateLimitMiddleware } from './middleware/rateLimit.js';
import { createEventsRouter } from './api/routes/events.js';
import { mountGraphQL } from './api/graphql/index.js';

export interface CreateAppOptions {
  apiKeys?: string[];
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
}

export function createApp(
  db: Database.Database,
  options: CreateAppOptions = {}
): express.Express {
  const app = express();
  const apiKeys = options.apiKeys ?? config.apiKeys;
  const rateLimitMax = options.rateLimitMax ?? 100;
  const rateLimitWindowMs = options.rateLimitWindowMs ?? 60_000;

  app.use(express.json());
  app.use(createApiKeyMiddleware(apiKeys));
  app.use(createRateLimitMiddleware(rateLimitMax, rateLimitWindowMs));

  app.use(createLeaderboardRouter(db));
  app.use(createReputationRouter(db));
  app.use(createStatsRouter(db));
  app.use(createInvoicesRouter(db));
  app.use(createEventsRouter(db));
  mountGraphQL(app, db);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}
