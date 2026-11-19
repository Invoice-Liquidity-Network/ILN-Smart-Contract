import type { RequestHandler } from 'express';
import { newCorrelationId, runWithContext } from '../lib/logger.js';

/**
 * Correlation-ID middleware (Issue #776).
 *
 * Reads an inbound `x-correlation-id` (or `x-request-id`) header if it looks
 * safe, otherwise mints a new UUID. Echoes it back on the response and runs
 * the rest of the request inside an `AsyncLocalStorage` scope so every
 * `logger.*` call for this request carries `correlationId`, `method`, and
 * `path` automatically.
 *
 * Register this before every other middleware and route.
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
