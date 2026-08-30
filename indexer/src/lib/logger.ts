/**
 * Structured JSON logging with cross-service correlation IDs (Issue #776).
 *
 * Every line is a single JSON object on one line:
 *
 *   {"ts":"2026-08-30T20:11:03.512Z","level":"info","service":"indexer",
 *    "msg":"ingestion leader acquired","correlationId":"a1b2...","ledger":12345}
 *
 * The `correlationId` is propagated automatically via `AsyncLocalStorage`:
 * set it once at the ingestion boundary (an HTTP request, a Horizon event, a
 * scheduled job) with `runWithContext`, and every `logger.*` call inside that
 * async scope — however deep — carries it without threading an argument.
 *
 * See `docs/observability-standards.md` for the full field contract and the
 * ID-propagation scheme shared with the notifications service.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  correlationId?: string;
  [key: string]: unknown;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const store = new AsyncLocalStorage<LogContext>();

const SERVICE_NAME = process.env.LOG_SERVICE ?? 'indexer';
const THRESHOLD =
  LEVEL_WEIGHT[(process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info'] ?? LEVEL_WEIGHT.info;

/** Run `fn` with a fresh logging context (correlation id + any extra fields). */
export function runWithContext<T>(context: LogContext, fn: () => T): T {
  return store.run({ ...context }, fn);
}

/** Merge extra fields into the current context, if one is active. */
export function bindContext(extra: LogContext): void {
  const current = store.getStore();
  if (current) {
    Object.assign(current, extra);
  }
}

/** The correlation id for the current async scope, if any. */
export function getCorrelationId(): string | undefined {
  return store.getStore()?.correlationId;
}

/** A new random correlation id (UUID v4). */
export function newCorrelationId(): string {
  return randomUUID();
}

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_WEIGHT[level] < THRESHOLD) {
    return;
  }
  const context = store.getStore();
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    msg,
    ...(context ?? {}),
    ...(fields ?? {}),
  };
  const serialized = `${JSON.stringify(line)}\n`;
  if (level === 'error' || level === 'warn') {
    process.stderr.write(serialized);
  } else {
    process.stdout.write(serialized);
  }
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Returns a logger whose calls always include `bindings`. */
  child(bindings: Record<string, unknown>): Logger;
}

function makeLogger(base: Record<string, unknown>): Logger {
  const withBase = (fields?: Record<string, unknown>) => ({ ...base, ...(fields ?? {}) });
  return {
    debug: (msg, fields) => emit('debug', msg, withBase(fields)),
    info: (msg, fields) => emit('info', msg, withBase(fields)),
    warn: (msg, fields) => emit('warn', msg, withBase(fields)),
    error: (msg, fields) => emit('error', msg, withBase(fields)),
    child: (bindings) => makeLogger({ ...base, ...bindings }),
  };
}

export const logger: Logger = makeLogger({});
