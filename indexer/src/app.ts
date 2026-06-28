import express from 'express';
import type Database from 'better-sqlite3';
import { createLeaderboardRouter } from './api/routes/leaderboard.js';
import { createReputationRouter } from './api/routes/reputation.js';
import { createStatsRouter } from './api/routes/stats.js';
import { createInvoicesRouter } from './api/routes/invoices.js';
import { createEventsRouter } from './api/routes/events.js';

export function createApp(db: Database.Database): express.Express {
  const app = express();

  app.use(express.json());

  app.use(createLeaderboardRouter(db));
  app.use(createReputationRouter(db));
  app.use(createStatsRouter(db));
  app.use(createInvoicesRouter(db));
  app.use(createEventsRouter(db));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}
