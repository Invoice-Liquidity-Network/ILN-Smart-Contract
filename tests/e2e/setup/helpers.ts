/**
 * Shared helpers for end-to-end tests.
 *
 * These utilities wrap the three things almost every E2E test needs against a
 * live (local or testnet) Stellar node:
 *
 *   - {@link fundAccount}    – fund an account from Friendbot so it can pay fees.
 *   - {@link advanceLedger}  – wait for / fast-forward the ledger past a deadline.
 *   - {@link pollIndexer}    – poll an async producer until a predicate holds.
 *
 * They intentionally depend only on `fetch` and the global env so they can be
 * imported from any test without pulling in the Stellar SDK.
 */

/** Base URL of the Stellar node, as written by {@link file://./globalSetup.ts}. */
export const RPC_URL = process.env.STELLAR_RPC_URL ?? 'http://localhost:8000';

/** Friendbot URL. The local quickstart image serves it at `<rpc>/friendbot`. */
export const FRIENDBOT_URL =
  process.env.FRIENDBOT_URL ?? `${RPC_URL}/friendbot`;

/** Sleep for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read the latest closed ledger sequence from the node's `/ledger` endpoint.
 *
 * The Stellar quickstart image exposes the latest ledger header (including its
 * `sequence`) at `GET /ledger`.
 */
export async function getLatestLedger(rpcUrl: string = RPC_URL): Promise<number> {
  const res = await fetch(`${rpcUrl}/ledger`);
  if (!res.ok) {
    throw new Error(`Failed to read latest ledger: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { sequence: number };
  return body.sequence;
}

/**
 * Fund an account from Friendbot.
 *
 * On the local standalone node this credits the account with a large XLM
 * balance so it can pay transaction fees. Resolves once the funding
 * transaction has been accepted; safe to call on an already-funded account
 * (Friendbot simply errors and we surface that).
 *
 * @param publicKey   The `G...` account to fund.
 * @param friendbotUrl Override the Friendbot base URL (defaults to {@link FRIENDBOT_URL}).
 */
export async function fundAccount(
  publicKey: string,
  friendbotUrl: string = FRIENDBOT_URL,
): Promise<void> {
  const res = await fetch(`${friendbotUrl}?addr=${encodeURIComponent(publicKey)}`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Friendbot funding failed for ${publicKey}: HTTP ${res.status} ${text}`);
  }
}

export interface AdvanceLedgerOptions {
  /** RPC base URL. Defaults to {@link RPC_URL}. */
  rpcUrl?: string;
  /** How long to wait, in ms, before giving up. Defaults to 120_000. */
  timeoutMs?: number;
  /** Poll interval, in ms. Defaults to 2_000. */
  intervalMs?: number;
}

/**
 * Fast-forward the chain by waiting until the ledger sequence has advanced by
 * at least `count` ledgers from the current tip.
 *
 * On the local standalone node ledgers close automatically every few seconds,
 * so this resolves quickly. When running against a node started in manual-close
 * mode you should drive closes externally (see `tests/e2e/README.md` →
 * "Ledger fast-forward"); this helper still works, it simply blocks until the
 * required number of closes have happened.
 *
 * Governance timelocks in this protocol are expressed in ledger *sequence*
 * numbers (`eta_ledger`), which is why advancing by ledger count — rather than
 * wall-clock time — is the correct primitive for executing a passed proposal.
 *
 * @returns the ledger sequence reached.
 */
export async function advanceLedger(
  count: number,
  opts: AdvanceLedgerOptions = {},
): Promise<number> {
  const rpcUrl = opts.rpcUrl ?? RPC_URL;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 2_000;

  const start = await getLatestLedger(rpcUrl);
  const target = start + count;
  const deadline = Date.now() + timeoutMs;

  let current = start;
  while (current < target) {
    if (Date.now() > deadline) {
      throw new Error(
        `advanceLedger timed out: wanted ledger ${target}, reached ${current} after ${timeoutMs}ms`,
      );
    }
    await sleep(intervalMs);
    current = await getLatestLedger(rpcUrl);
  }
  return current;
}

export interface PollOptions {
  /** Total time to keep polling, in ms. Defaults to 30_000. */
  timeoutMs?: number;
  /** Delay between attempts, in ms. Defaults to 2_000. */
  intervalMs?: number;
  /** Human-readable description used in the timeout error. */
  description?: string;
}

/**
 * Poll `produce()` until `predicate(result)` returns true, then return that
 * result. Throws if the timeout elapses first.
 *
 * This is the canonical way to wait for the indexer to catch up with on-chain
 * state — the indexer ingests Horizon events asynchronously, so a value written
 * on-chain is only visible via the REST API a few seconds later.
 *
 * @example
 * ```ts
 * const invoice = await pollIndexer(
 *   () => request('http://localhost:3000').get(`/invoices/${id}`).then((r) => r.body),
 *   (body) => body?.status === 'Funded',
 *   { description: `invoice ${id} to become Funded` },
 * );
 * ```
 */
export async function pollIndexer<T>(
  produce: () => Promise<T>,
  predicate: (value: T) => boolean,
  opts: PollOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await produce();
    if (predicate(last)) return last;
    await sleep(intervalMs);
  }
  throw new Error(
    `pollIndexer timed out after ${timeoutMs}ms waiting for ${opts.description ?? 'condition'}`,
  );
}
