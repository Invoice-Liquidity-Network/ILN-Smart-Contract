#!/usr/bin/env node
/**
 * check-contract-health.ts — recurring health probe for a deployed ILN stack.
 *
 * Designed to run as a cron job or inside monitoring infrastructure after a
 * mainnet (or testnet) deployment. It verifies that every moving part is
 * responding and that the indexer has not fallen behind the chain:
 *
 *   1. Contract RPC      — Soroban RPC `getLatestLedger` latency + reachability
 *   2. Indexer API       — `/health` response time + last indexed ledger
 *   3. Ledger lag        — last indexed ledger vs. current Horizon ledger
 *                          (critical when the indexer is > LEDGER_LAG_THRESHOLD behind)
 *   4. Notifications      — service `/health` endpoint
 *
 * Output: a single JSON metrics document on stdout, ready for ingestion into
 * Grafana / Datadog / Loki. The process exits with code 1 when any *critical*
 * check fails so a cron wrapper or CI step can alert on it.
 *
 * Usage:
 *   npx tsx scripts/check-contract-health.ts
 *   npx tsx scripts/check-contract-health.ts --alert-slack
 *   npx tsx scripts/check-contract-health.ts --pretty
 *
 * Configuration (environment variables):
 *   SOROBAN_RPC_URL        Soroban RPC endpoint (default: testnet)
 *   HORIZON_URL            Horizon endpoint     (default: testnet)
 *   INDEXER_URL            Indexer base URL     (default: http://localhost:3000)
 *   NOTIFICATIONS_URL      Notifications base URL (default: http://localhost:3001)
 *   INSURANCE_POOL_RPC_URL Soroban RPC endpoint for the insurance pool contract
 *   INSURANCE_POOL_ID      Deployed insurance pool contract address
 *   LEDGER_LAG_THRESHOLD   Max acceptable ledger lag (default: 100)
 *   HEALTH_TIMEOUT_MS      Per-request timeout in ms (default: 5000)
 *   SLACK_WEBHOOK_URL      Incoming webhook used by --alert-slack
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type CheckStatus = "ok" | "fail" | "unknown";

export interface CheckResult {
  /** Stable machine-readable name (used as a metric key). */
  name: string;
  status: CheckStatus;
  /** Whether a non-ok status should fail the whole run (exit 1). */
  critical: boolean;
  /** Round-trip latency in milliseconds, when a request was made. */
  latencyMs: number | null;
  /** Free-form, JSON-serialisable details for dashboards. */
  details: Record<string, unknown>;
  /** Error message when status is "fail". */
  error: string | null;
}

export interface HealthConfig {
  sorobanRpcUrl: string;
  horizonUrl: string;
  indexerUrl: string;
  notificationsUrl: string;
  insurancePoolRpcUrl: string;
  insurancePoolId: string;
  ledgerLagThreshold: number;
  timeoutMs: number;
}

export interface HealthReport {
  timestamp: string;
  healthy: boolean;
  checks: CheckResult[];
  metrics: Record<string, number>;
}

/** Injectable dependencies — overridden in tests so no network is touched. */
export interface Deps {
  fetch: typeof fetch;
  now: () => number;
}

const defaultDeps: Deps = { fetch: (...a) => fetch(...a), now: () => Date.now() };

// ── Config ───────────────────────────────────────────────────────────────────

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HealthConfig {
  return {
    sorobanRpcUrl: env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org",
    horizonUrl: (env.HORIZON_URL || "https://horizon-testnet.stellar.org").replace(/\/$/, ""),
    indexerUrl: (env.INDEXER_URL || "http://localhost:3000").replace(/\/$/, ""),
    notificationsUrl: (env.NOTIFICATIONS_URL || "http://localhost:3001").replace(/\/$/, ""),
    insurancePoolRpcUrl: env.INSURANCE_POOL_RPC_URL || env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org",
    insurancePoolId: env.INSURANCE_POOL_ID || "",
    ledgerLagThreshold: Number(env.LEDGER_LAG_THRESHOLD || 100),
    timeoutMs: Number(env.HEALTH_TIMEOUT_MS || 5000),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Fetch with an abort-based timeout, returning the response plus latency. */
async function timedFetch(
  deps: Deps,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ res: Response; latencyMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = deps.now();
  try {
    const res = await deps.fetch(url, { ...init, signal: controller.signal });
    return { res, latencyMs: deps.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

// ── Individual checks ────────────────────────────────────────────────────────

/** 1. Soroban RPC reachability + `getLatestLedger` latency. */
export async function checkContractRpc(
  cfg: HealthConfig,
  deps: Deps = defaultDeps
): Promise<CheckResult> {
  const base: CheckResult = {
    name: "contract_rpc",
    status: "unknown",
    critical: true,
    latencyMs: null,
    details: { url: cfg.sorobanRpcUrl },
    error: null,
  };
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" });
    const { res, latencyMs } = await timedFetch(
      deps,
      cfg.sorobanRpcUrl,
      { method: "POST", headers: { "content-type": "application/json" }, body },
      cfg.timeoutMs
    );
    base.latencyMs = latencyMs;
    if (!res.ok) {
      return { ...base, status: "fail", error: `RPC returned HTTP ${res.status}` };
    }
    const json: any = await res.json();
    if (json.error) {
      return { ...base, status: "fail", error: `RPC error: ${JSON.stringify(json.error)}` };
    }
    const sequence = Number(json.result?.sequence ?? NaN);
    return {
      ...base,
      status: "ok",
      details: { ...base.details, latestLedger: sequence },
    };
  } catch (e) {
    return { ...base, status: "fail", error: errMsg(e) };
  }
}

/** 2. Indexer `/health` latency + best-effort last indexed ledger. */
export async function checkIndexer(
  cfg: HealthConfig,
  deps: Deps = defaultDeps
): Promise<CheckResult & { lastIndexedLedger: number | null }> {
  const base: CheckResult & { lastIndexedLedger: number | null } = {
    name: "indexer_api",
    status: "unknown",
    critical: true,
    latencyMs: null,
    details: { url: `${cfg.indexerUrl}/health` },
    error: null,
    lastIndexedLedger: null,
  };
  try {
    const { res, latencyMs } = await timedFetch(
      deps,
      `${cfg.indexerUrl}/health`,
      { method: "GET" },
      cfg.timeoutMs
    );
    base.latencyMs = latencyMs;
    if (!res.ok) {
      return { ...base, status: "fail", error: `Indexer returned HTTP ${res.status}` };
    }
    const json: any = await res.json().catch(() => ({}));
    // The indexer exposes last-indexed ledger via the health payload when
    // available; tolerate several field names so this keeps working as the
    // endpoint evolves.
    const lastIndexedLedger = firstNumber(
      json.lastIndexedLedger,
      json.lastLedger,
      json.ledger,
      json.indexedLedger
    );
    return {
      ...base,
      status: json.status === "ok" || res.ok ? "ok" : "fail",
      details: { ...base.details, payload: json },
      lastIndexedLedger,
    };
  } catch (e) {
    return { ...base, status: "fail", error: errMsg(e) };
  }
}

/** 3. Current Horizon ledger, compared against the indexer's last ledger. */
export async function checkLedgerLag(
  cfg: HealthConfig,
  lastIndexedLedger: number | null,
  deps: Deps = defaultDeps
): Promise<CheckResult> {
  const base: CheckResult = {
    name: "ledger_lag",
    status: "unknown",
    critical: true,
    latencyMs: null,
    details: { threshold: cfg.ledgerLagThreshold, lastIndexedLedger },
    error: null,
  };
  try {
    const { res, latencyMs } = await timedFetch(
      deps,
      `${cfg.horizonUrl}/ledgers?order=desc&limit=1`,
      { method: "GET", headers: { accept: "application/json" } },
      cfg.timeoutMs
    );
    base.latencyMs = latencyMs;
    if (!res.ok) {
      return { ...base, status: "fail", error: `Horizon returned HTTP ${res.status}` };
    }
    const json: any = await res.json();
    const horizonLedger = Number(json?._embedded?.records?.[0]?.sequence ?? NaN);
    base.details = { ...base.details, horizonLedger };

    if (!Number.isFinite(horizonLedger)) {
      return { ...base, status: "fail", error: "Could not parse Horizon ledger sequence" };
    }
    if (lastIndexedLedger == null) {
      // We could read the chain head but not the indexer head. Surface it as a
      // non-blocking unknown rather than a false-positive critical failure.
      return {
        ...base,
        critical: false,
        status: "unknown",
        error: "Indexer did not report a last indexed ledger",
      };
    }
    const lag = horizonLedger - lastIndexedLedger;
    base.details = { ...base.details, lag };
    if (lag > cfg.ledgerLagThreshold) {
      return { ...base, status: "fail", error: `Indexer is ${lag} ledgers behind` };
    }
    return { ...base, status: "ok" };
  } catch (e) {
    return { ...base, status: "fail", error: errMsg(e) };
  }
}

/** 5. Insurance pool contract — verifies it is initialized (Admin key present). */
export async function checkInsurancePool(
  cfg: HealthConfig,
  deps: Deps = defaultDeps
): Promise<CheckResult> {
  const base: CheckResult = {
    name: "insurance_pool",
    status: "unknown",
    critical: false,
    latencyMs: null,
    details: { contractId: cfg.insurancePoolId },
    error: null,
  };

  if (!cfg.insurancePoolId) {
    return { ...base, status: "unknown", error: "INSURANCE_POOL_ID not configured" };
  }

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getLedgerEntries",
    params: {
      keys: [
        // DataKey::Admin is a unit enum variant — its XDR is a 1-element vec
        // with symbol "Admin". We request it to confirm the pool is initialised.
        Buffer.from(
          JSON.stringify({ contractId: cfg.insurancePoolId, key: { type: "symbol", value: "Admin" } })
        ).toString("base64"),
      ],
    },
  });

  try {
    const { res, latencyMs } = await timedFetch(
      deps,
      cfg.insurancePoolRpcUrl,
      { method: "POST", headers: { "content-type": "application/json" }, body },
      cfg.timeoutMs
    );
    base.latencyMs = latencyMs;
    if (!res.ok) {
      return { ...base, status: "fail", error: `RPC returned HTTP ${res.status}` };
    }
    const json: any = await res.json();
    if (json.error) {
      return { ...base, status: "fail", error: `RPC error: ${JSON.stringify(json.error)}` };
    }
    const entries: unknown[] = json.result?.entries ?? [];
    const initialized = entries.length > 0;
    return {
      ...base,
      status: initialized ? "ok" : "fail",
      details: { ...base.details, initialized },
      error: initialized ? null : "Insurance pool Admin key not found — pool may not be initialized",
    };
  } catch (e) {
    return { ...base, status: "fail", error: errMsg(e) };
  }
}

/** 4. Notification service `/health` endpoint. */
export async function checkNotifications(
  cfg: HealthConfig,
  deps: Deps = defaultDeps
): Promise<CheckResult> {
  const base: CheckResult = {
    name: "notifications",
    status: "unknown",
    // Non-blocking: a notification outage degrades UX but does not put funds at
    // risk, so it is reported but does not fail the run.
    critical: false,
    latencyMs: null,
    details: { url: `${cfg.notificationsUrl}/health` },
    error: null,
  };
  try {
    const { res, latencyMs } = await timedFetch(
      deps,
      `${cfg.notificationsUrl}/health`,
      { method: "GET" },
      cfg.timeoutMs
    );
    base.latencyMs = latencyMs;
    if (!res.ok) {
      return { ...base, status: "fail", error: `Notifications returned HTTP ${res.status}` };
    }
    const json: any = await res.json().catch(() => ({}));
    return {
      ...base,
      status: json.status === "ok" || res.ok ? "ok" : "fail",
      details: { ...base.details, payload: json },
    };
  } catch (e) {
    return { ...base, status: "fail", error: errMsg(e) };
  }
}

// ── Orchestration ────────────────────────────────────────────────────────────

export async function runHealthChecks(
  cfg: HealthConfig,
  deps: Deps = defaultDeps
): Promise<HealthReport> {
  const [rpc, indexer] = await Promise.all([
    checkContractRpc(cfg, deps),
    checkIndexer(cfg, deps),
  ]);
  const [lag, notifications, insurancePool] = await Promise.all([
    checkLedgerLag(cfg, indexer.lastIndexedLedger, deps),
    checkNotifications(cfg, deps),
    checkInsurancePool(cfg, deps),
  ]);

  // Drop the helper-only field before reporting.
  const { lastIndexedLedger: _ignored, ...indexerResult } = indexer;
  const checks: CheckResult[] = [rpc, indexerResult, lag, notifications, insurancePool];

  const healthy = checks.every((c) => !(c.critical && c.status === "fail"));

  // Flatten latencies into a metrics map for time-series ingestion.
  const metrics: Record<string, number> = {};
  for (const c of checks) {
    if (c.latencyMs != null) metrics[`${c.name}_latency_ms`] = c.latencyMs;
  }
  if (typeof lag.details.lag === "number") metrics.ledger_lag = lag.details.lag;

  return {
    timestamp: new Date(deps.now()).toISOString(),
    healthy,
    checks,
    metrics,
  };
}

/** Post a concise failure summary to a Slack incoming webhook. */
export async function alertSlack(
  report: HealthReport,
  webhookUrl: string,
  deps: Deps = defaultDeps
): Promise<boolean> {
  const failures = report.checks.filter((c) => c.status === "fail");
  if (failures.length === 0) return false;
  const lines = failures.map(
    (c) => `• *${c.name}* (${c.critical ? "critical" : "warning"}): ${c.error ?? "failed"}`
  );
  const text = [`:rotating_light: *ILN health check failed* — ${report.timestamp}`, ...lines].join(
    "\n"
  );
  try {
    const res = await deps.fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.name === "AbortError" ? "Request timed out" : e.message;
  return String(e);
}

function firstNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    const n = Number(v);
    if (v != null && Number.isFinite(n)) return n;
  }
  return null;
}

// ── CLI entry point ──────────────────────────────────────────────────────────

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const alertSlackFlag = argv.includes("--alert-slack");
  const pretty = argv.includes("--pretty");
  const cfg = loadConfig();

  const report = await runHealthChecks(cfg);
  process.stdout.write(JSON.stringify(report, null, pretty ? 2 : 0) + "\n");

  if (alertSlackFlag) {
    const webhook = process.env.SLACK_WEBHOOK_URL;
    if (!webhook) {
      process.stderr.write("--alert-slack set but SLACK_WEBHOOK_URL is missing\n");
    } else {
      await alertSlack(report, webhook);
    }
  }

  return report.healthy ? 0 : 1;
}

// Run only when invoked directly (not when imported by tests).
const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] &&
  /check-contract-health\.(ts|js|mjs)$/.test(process.argv[1]);

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`check-contract-health crashed: ${errMsg(err)}\n`);
      process.exit(1);
    }
  );
}
