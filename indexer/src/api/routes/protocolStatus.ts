import { Router } from 'express';
import type { ProtocolStatusService } from '../../services/protocolStatusService.js';

/**
 * `GET /protocol-status` (Issue #775) — public, unauthenticated mirror of the
 * contract's `get_protocol_status()` view so the community has a source of
 * truth for "is the protocol paused, and why" without querying contract state
 * directly.
 *
 * - 200 with the snapshot when a value is available (possibly `stale`).
 * - 503 when no value has ever been read (contract/RPC not configured or
 *   unreachable), with `{ configured: false }` and an `error` string.
 */
export function createProtocolStatusRouter(service: ProtocolStatusService): Router {
  const router = Router();

  router.get('/protocol-status', async (_req, res) => {
    try {
      const snapshot = await service.get();
      if (snapshot.source === 'unavailable') {
        res.status(503).json({
          configured: false,
          error: snapshot.error ?? 'protocol status unavailable',
        });
        return;
      }
      res.json({
        configured: true,
        stale: snapshot.stale,
        fetchedAt: snapshot.fetchedAt,
        source: snapshot.source,
        ...(snapshot.error ? { error: snapshot.error } : {}),
        status: snapshot.status,
      });
    } catch (err) {
      res.status(503).json({
        configured: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
