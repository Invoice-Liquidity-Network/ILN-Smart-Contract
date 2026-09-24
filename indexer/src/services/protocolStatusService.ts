/**
 * Public protocol-status snapshot for incident transparency (Issue #775).
 *
 * Reads `get_protocol_status()` from the deployed `invoice_liquidity` contract
 * via read-only simulation and caches it for a short TTL so a burst of
 * "is it paused?" requests during an incident does not hammer the RPC. On a
 * fetch failure the last good value is served with `stale: true` rather than
 * erroring — a slightly old "paused: true" is still useful.
 */

import type { ChainReader, OnChainProtocolStatus } from '../reconciliation/chainReader.js';

export type ProtocolStatusSource = 'chain' | 'cache' | 'unavailable';

export interface ProtocolStatusSnapshot {
  status: OnChainProtocolStatus | null;
  /** ISO timestamp of the last successful chain read, or null if never. */
  fetchedAt: string | null;
  /** True when serving a cached value because the latest refresh failed. */
  stale: boolean;
  source: ProtocolStatusSource;
  /** Set when the latest refresh failed. */
  error?: string;
}

export interface ProtocolStatusServiceOptions {
  reader?: Pick<ChainReader, 'getProtocolStatus'>;
  /** Cache lifetime in ms (default 15s). */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface ProtocolStatusService {
  get(): Promise<ProtocolStatusSnapshot>;
}

const DEFAULT_TTL_MS = 15_000;

export function createProtocolStatusService(
  options: ProtocolStatusServiceOptions = {},
): ProtocolStatusService {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const reader = options.reader;

  let cached: OnChainProtocolStatus | null = null;
  let cachedAtMs = 0;
  let fetchedAtIso: string | null = null;
  let lastError: string | undefined;
  let inFlight: Promise<void> | null = null;

  async function doRefresh(): Promise<void> {
    const getStatus = reader?.getProtocolStatus?.bind(reader);
    if (!getStatus) {
      lastError = 'protocol status source not configured';
      return;
    }
    try {
      const status = await getStatus();
      if (status === null) {
        lastError = 'contract does not expose get_protocol_status';
        return;
      }
      cached = status;
      cachedAtMs = now();
      fetchedAtIso = new Date(cachedAtMs).toISOString();
      lastError = undefined;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  function refresh(): Promise<void> {
    if (!inFlight) {
      inFlight = doRefresh().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  return {
    async get(): Promise<ProtocolStatusSnapshot> {
      const isFresh = cached !== null && now() - cachedAtMs < ttlMs;
      if (isFresh) {
        return { status: cached, fetchedAt: fetchedAtIso, stale: false, source: 'cache' };
      }

      await refresh();

      if (cached !== null && !lastError) {
        return { status: cached, fetchedAt: fetchedAtIso, stale: false, source: 'chain' };
      }
      if (cached !== null) {
        return {
          status: cached,
          fetchedAt: fetchedAtIso,
          stale: true,
          source: 'cache',
          error: lastError,
        };
      }
      return {
        status: null,
        fetchedAt: null,
        stale: false,
        source: 'unavailable',
        error: lastError ?? 'protocol status unavailable',
      };
    },
  };
}
