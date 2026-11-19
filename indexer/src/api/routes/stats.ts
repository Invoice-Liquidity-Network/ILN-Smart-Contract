import { Router } from 'express';
import type Database from 'better-sqlite3';
import {
  getProtocolStats,
  getStatsHistory,
  type ProtocolStats,
  type StatsHistoryEntry,
} from '../../services/statsService.js';
import { getAnalyticsSnapshot, type AnalyticsSnapshot } from '../../services/analyticsService.js';

export function createStatsRouter(db: Database.Database): Router {
  const router = Router();

  router.get('/stats', (_req, res) => {
    const stats: ProtocolStats = getProtocolStats(db);
    res.json(stats);
  });

  router.get('/stats/history', (req, res) => {
    const period = (req.query.period as string) || '30d';
    if (!['30d', '90d', 'all'].includes(period)) {
      res.status(400).json({ error: 'Invalid period. Use 30d, 90d, or all' });
      return;
    }
    const history: StatsHistoryEntry[] = getStatsHistory(db, period as '30d' | '90d' | 'all');
    res.json(history);
  });

  router.get('/stats/analytics', (req, res) => {
    const limitParam = req.query.limit;
    let limit = 10;

    if (limitParam !== undefined) {
      const parsed = Number.parseInt(limitParam as string, 10);
      if (Number.isNaN(parsed) || parsed < 1) {
        res.status(400).json({ error: 'Invalid limit. Use a positive integer' });
        return;
      }
      limit = parsed;
    }

    const analytics: AnalyticsSnapshot = getAnalyticsSnapshot(db, limit);
    res.json(analytics);
  });

  return router;
}
