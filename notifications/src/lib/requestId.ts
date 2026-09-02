import type { RequestHandler } from 'express';
import { newCorrelationId, runWithContext } from './logger.js';

/**
 * Correlation-ID middleware for the notifications service (Issue #776).
 *
 * A notification pipeline that starts from an ingested on-chain event should
 * forward that event's id as `x-correlation-id` so a webhook/email delivery
 * can be traced back to the ledger event that triggered it. When no inbound
 * id is present (or it fails the safe-shape check) a new UUID is minted.
 * Echoed on the response; the rest of the request runs inside an
 * `AsyncLocalStorage` scope so every `logger.*` call carries `correlationId`.
 */

export const CORRELATION_HEADER = 'x-correlation-id';

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export function createRequestIdMiddleware(): RequestHandler {
  return (req, res, next) => {
    const inbound =
      req.header(CORRELATION_HEADER) ?? req.header('x-request-id') ?? undefined;
    const correlationId = inbound && SAFE_ID.test(inbound) ? inbound : newCorrelationId();

    res.setHeader(CORRELATION_HEADER, correlationId);

    runWithContext({ correlationId, method: req.method, path: req.path }, () => {
      next();
    });
  };
}
