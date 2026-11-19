/**
 * Tests for check-contract-health.ts.
 *
 * Uses Node's built-in test runner (no extra dependencies) with a fake `fetch`
 * so no network access is required. Run with:
 *
 *   npx tsx --test scripts/check-contract-health.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type Deps,
  type HealthConfig,
  checkContractRpc,
  checkIndexer,
  checkLedgerLag,
  checkNotifications,
  runHealthChecks,
  alertSlack,
  loadConfig,
} from "./check-contract-health.ts";

const cfg: HealthConfig = {
  sorobanRpcUrl: "https://rpc.example",
  horizonUrl: "https://horizon.example",
  indexerUrl: "http://indexer.example",
  notificationsUrl: "http://notify.example",
  ledgerLagThreshold: 100,
  timeoutMs: 1000,
};

/** Build a Deps whose fetch dispatches on URL via the supplied route table. */
function depsWith(routes: Record<string, () => Partial<Response> & { json?: () => any }>): Deps {
  let clock = 1000;
  return {
    now: () => (clock += 5),
    fetch: (async (url: string) => {
      const key = Object.keys(routes).find((k) => String(url).includes(k));
      if (!key) throw new Error(`no route for ${url}`);
      const r = routes[key]();
      return {
        ok: r.ok ?? true,
        status: r.status ?? 200,
        json: r.json ?? (async () => ({})),
      } as unknown as Response;
    }) as unknown as typeof fetch,
  };
}

test("checkContractRpc reports ok and latest ledger", async () => {
  const deps = depsWith({
    "rpc.example": () => ({ json: async () => ({ result: { sequence: 555 } }) }),
  });
  const r = await checkContractRpc(cfg, deps);
  assert.equal(r.status, "ok");
  assert.equal(r.details.latestLedger, 555);
  assert.ok((r.latencyMs ?? 0) >= 0);
});

test("checkContractRpc fails on HTTP error", async () => {
  const deps = depsWith({ "rpc.example": () => ({ ok: false, status: 502 }) });
  const r = await checkContractRpc(cfg, deps);
  assert.equal(r.status, "fail");
  assert.match(r.error!, /502/);
});

test("checkIndexer extracts last indexed ledger", async () => {
  const deps = depsWith({
    "indexer.example": () => ({ json: async () => ({ status: "ok", lastIndexedLedger: 480 }) }),
  });
  const r = await checkIndexer(cfg, deps);
  assert.equal(r.status, "ok");
  assert.equal(r.lastIndexedLedger, 480);
});

test("checkLedgerLag flags an indexer that is too far behind", async () => {
  const deps = depsWith({
    "horizon.example": () => ({
      json: async () => ({ _embedded: { records: [{ sequence: 1000 }] } }),
    }),
  });
  const r = await checkLedgerLag(cfg, 800, deps); // lag 200 > 100
  assert.equal(r.status, "fail");
  assert.equal(r.details.lag, 200);
  assert.equal(r.critical, true);
});

test("checkLedgerLag passes when within threshold", async () => {
  const deps = depsWith({
    "horizon.example": () => ({
      json: async () => ({ _embedded: { records: [{ sequence: 1000 }] } }),
    }),
  });
  const r = await checkLedgerLag(cfg, 950, deps); // lag 50
  assert.equal(r.status, "ok");
});

test("checkLedgerLag is non-critical unknown when indexer ledger is missing", async () => {
  const deps = depsWith({
    "horizon.example": () => ({
      json: async () => ({ _embedded: { records: [{ sequence: 1000 }] } }),
    }),
  });
  const r = await checkLedgerLag(cfg, null, deps);
  assert.equal(r.status, "unknown");
  assert.equal(r.critical, false);
});

test("checkNotifications failure does not fail the overall run", async () => {
  const deps = depsWith({ "notify.example": () => ({ ok: false, status: 500 }) });
  const r = await checkNotifications(cfg, deps);
  assert.equal(r.status, "fail");
  assert.equal(r.critical, false);
});

test("runHealthChecks is healthy when all critical checks pass", async () => {
  const deps = depsWith({
    "rpc.example": () => ({ json: async () => ({ result: { sequence: 1000 } }) }),
    "indexer.example": () => ({ json: async () => ({ status: "ok", lastIndexedLedger: 990 }) }),
    "horizon.example": () => ({
      json: async () => ({ _embedded: { records: [{ sequence: 1010 }] } }),
    }),
    "notify.example": () => ({ json: async () => ({ status: "ok" }) }),
  });
  const report = await runHealthChecks(cfg, deps);
  assert.equal(report.healthy, true);
  assert.equal(report.metrics.ledger_lag, 20);
  assert.ok("contract_rpc_latency_ms" in report.metrics);
});

test("runHealthChecks is unhealthy when a critical check fails", async () => {
  const deps = depsWith({
    "rpc.example": () => ({ ok: false, status: 500 }),
    "indexer.example": () => ({ json: async () => ({ status: "ok", lastIndexedLedger: 990 }) }),
    "horizon.example": () => ({
      json: async () => ({ _embedded: { records: [{ sequence: 1010 }] } }),
    }),
    "notify.example": () => ({ json: async () => ({ status: "ok" }) }),
  });
  const report = await runHealthChecks(cfg, deps);
  assert.equal(report.healthy, false);
});

test("alertSlack posts only when there are failures", async () => {
  let posted = 0;
  const deps: Deps = {
    now: () => 0,
    fetch: (async () => {
      posted++;
      return { ok: true } as Response;
    }) as unknown as typeof fetch,
  };
  const healthy = { timestamp: "t", healthy: true, checks: [], metrics: {} };
  assert.equal(await alertSlack(healthy as any, "http://hook", deps), false);
  assert.equal(posted, 0);

  const failing = {
    timestamp: "t",
    healthy: false,
    checks: [{ name: "contract_rpc", status: "fail", critical: true, error: "boom" }],
    metrics: {},
  };
  assert.equal(await alertSlack(failing as any, "http://hook", deps), true);
  assert.equal(posted, 1);
});

test("loadConfig applies defaults and overrides", () => {
  const c = loadConfig({ LEDGER_LAG_THRESHOLD: "42", INDEXER_URL: "http://x/" } as any);
  assert.equal(c.ledgerLagThreshold, 42);
  assert.equal(c.indexerUrl, "http://x"); // trailing slash trimmed
  assert.match(c.sorobanRpcUrl, /soroban-testnet/);
});
