# End-to-End (E2E) Tests

This directory contains the cross-component end-to-end suite for the Invoice
Liquidity Network. Unlike the per-package unit tests (`contracts/`, `sdk/`,
`indexer/`, `notifications/`), these tests exercise **several components
together** — the SDK, the smart contracts on a real Stellar node, and the
indexer's REST API — to prove the full system behaves as designed.

> **New contributor?** Read this whole file before adding a test. It explains
> the Docker node setup, the global setup/teardown sequence, the shared helpers,
> and how to debug a failing run. Following it keeps the suite green and avoids
> duplicating helper utilities that already exist.

---

## Table of contents

- [What lives here](#what-lives-here)
- [Prerequisites](#prerequisites)
- [Running the tests locally](#running-the-tests-locally)
- [How the Docker node setup works](#how-the-docker-node-setup-works)
- [Global setup & teardown sequence](#global-setup--teardown-sequence)
- [Test helpers](#test-helpers)
- [Writing a new test](#writing-a-new-test)
- [Debugging a failing test](#debugging-a-failing-test)

---

## What lives here

| File | Purpose |
|------|---------|
| `setup/globalSetup.ts` | Boots the Dockerised Stellar node once before the suite and exports contract IDs / RPC URL into the environment. |
| `setup/globalTeardown.ts` | Tears the node (and its volume) down once after the suite. |
| `setup/helpers.ts` | Shared helpers: account funding, ledger fast-forward, indexer polling. |
| `smoke.test.ts` | Sanity check that the node is reachable and env vars are wired. |
| `lifecycle.test.ts` | Submit → fund → pay an invoice and confirm the indexer reflects each state. |
| `governance.test.ts` | Propose → vote → timelock → execute a parameter change and verify it takes effect. |
| `reputation.test.ts` | Reputation score/history surfaced through the indexer API. |
| `indexerConsistency.test.ts` | On-chain state vs. indexed state agree. |
| `webhookDelivery.test.ts` | Notification webhooks fire on lifecycle events. |
| `multiToken.test.ts` | Multi-token invoice flows. |
| `cli.test.ts` | CLI surface smoke tests. |
| `jest.config.ts` | Jest config (ESM + ts-jest, global setup/teardown, 120 s timeout, `--runInBand`). |
| `package.json` | `test:e2e` script and dependencies. |

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 20+ | The suite is ESM + `ts-jest`. |
| npm | 10+ | |
| Docker + Docker Compose v2 | recent | `docker compose` (v2 syntax) must be on `PATH`. The global setup shells out to it. |
| Free ports | `8000`, `11626` | The Stellar quickstart container binds these (see `docker-compose.test.yml`). |

Install dependencies once:

```bash
cd tests/e2e
npm install
```

Some tests talk to **public testnet** instead of the local node and are
**skipped automatically** unless you supply funded secret keys via environment
variables (see [Writing a new test](#writing-a-new-test)). This keeps the
default `npm run test:e2e` run hermetic and free of flakiness from external
networks.

---

## Running the tests locally

From `tests/e2e`:

```bash
# Full suite (boots Docker node, runs all tests serially, tears node down)
npm run test:e2e

# Watch mode while iterating
npm run test:e2e:watch
```

Run a single file or test while developing:

```bash
# One file
npm run test:e2e -- governance.test.ts

# One test by name
npm run test:e2e -- -t "full invoice lifecycle"
```

> Tests run with `--runInBand` (serially). They share a single Stellar node and
> bind fixed ports, so running them in parallel would cause port and state
> collisions. Do not remove `--runInBand`.

Tests that require testnet secrets are opt-in:

```bash
TEST_SUBMITTER_SECRET=S... \
TEST_LP_SECRET=S... \
npm run test:e2e -- lifecycle.test.ts
```

---

## How the Docker node setup works

The suite runs against a **Stellar quickstart** container defined in
[`docker-compose.test.yml`](../../docker-compose.test.yml) at the repo root:

```yaml
services:
  stellar:
    image: stellar/stellar-quickstart:latest
    ports:
      - "8000:8000"     # Horizon / RPC / Friendbot
      - "11626:11626"   # Core admin (manual close, info)
    environment:
      - NETWORK_MODE=standalone
      - STELLAR_NETWORK_ID=local
      - FAST_START=true
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/ledger"]
```

Key points:

- **`standalone` network mode** gives you a private, single-validator chain that
  closes ledgers automatically — no testnet rate limits, resettable on every run.
- **Port `8000`** serves the HTTP surface the tests use: `GET /ledger` for the
  latest header and `GET /friendbot?addr=G...` to fund accounts.
- **Port `11626`** is Stellar Core's admin port (used for advanced flows such as
  manual ledger close — see [Ledger fast-forward](#ledger-fast-forward)).
- The healthcheck polls `GET /ledger`; global setup waits on the same endpoint
  before handing control to the tests.
- A named volume (`stellar-e2e-data`) holds chain state and is **removed on
  teardown** (`docker compose down -v`) so every run starts from genesis.

You can drive the node by hand while debugging:

```bash
# Start just the node
docker compose -f docker-compose.test.yml up -d stellar

# Tail logs
docker compose -f docker-compose.test.yml logs -f stellar

# Latest ledger
curl -s http://localhost:8000/ledger | jq .sequence

# Tear everything down (and wipe the volume)
docker compose -f docker-compose.test.yml down -v
```

---

## Global setup & teardown sequence

Jest runs `setup/globalSetup.ts` **once** before any test file and
`setup/globalTeardown.ts` **once** after the whole suite (wired via
`globalSetup` / `globalTeardown` in `jest.config.ts`).

**Setup ([`setup/globalSetup.ts`](setup/globalSetup.ts)):**

1. `docker compose -f docker-compose.test.yml up -d stellar` — start the node.
2. Poll `GET http://localhost:8000/ledger` until it returns `200` (up to 60 s).
3. Resolve the deployed contract IDs (`INVOICE_LIQUIDITY`, `ILN_GOVERNANCE`,
   `ILN_DISTRIBUTION`, `INSURANCE_POOL`, `REPUTATION_BONUS`).
4. Write them plus `STELLAR_RPC_URL` / `STELLAR_NETWORK` to `tests/.env.e2e`
   **and** `process.env`, so every test file reads the same configuration.

**Teardown ([`setup/globalTeardown.ts`](setup/globalTeardown.ts)):**

1. `docker compose -f docker-compose.test.yml down -v` — stop the node and
   delete its volume, leaving no state behind for the next run.

```
globalSetup ──> [ docker up ] ──> [ wait healthy ] ──> [ export env ]
                                                            │
                          test1 ─ test2 ─ … ─ testN  (──runInBand──)
                                                            │
globalTeardown ◄── [ docker down -v ] ◄─────────────────────┘
```

Because setup/teardown run once for the whole suite, **never** start or stop the
shared node from inside an individual test. Per-test resources (an in-memory
indexer DB, an Express server on a unique port) are created in `beforeAll` and
released in `afterAll` within each file — follow that pattern.

---

## Test helpers

Reusable helpers live in [`setup/helpers.ts`](setup/helpers.ts). **Use these
instead of re-implementing them** — duplicated polling/funding logic is the most
common source of flaky E2E tests.

### Funding accounts

```ts
import { fundAccount } from './setup/helpers.js';

// Credit a fresh keypair from Friendbot so it can pay fees.
await fundAccount(keypair.publicKey());
```

`fundAccount(publicKey, friendbotUrl?)` hits `GET <friendbot>?addr=...`. The
Friendbot URL defaults to `${STELLAR_RPC_URL}/friendbot` and can be overridden
with the `FRIENDBOT_URL` env var.

### Ledger fast-forward

```ts
import { advanceLedger, getLatestLedger } from './setup/helpers.js';

const before = await getLatestLedger();
const after = await advanceLedger(10); // resolves once 10 more ledgers have closed
```

`advanceLedger(count, opts?)` blocks until the ledger **sequence** has advanced
by `count`. Governance timelocks (`eta_ledger`) are measured in ledger sequence
numbers, so advancing by ledger count — not wall-clock time — is what unblocks a
passed proposal for execution.

On the default `standalone` node ledgers close automatically every few seconds,
so this returns quickly. If you start the node in **manual-close** mode (for
deterministic timing), drive closes via the Core admin port and `advanceLedger`
will still resolve as each close lands:

```bash
# Close one ledger on demand (manual-close mode only)
curl -s "http://localhost:11626/manualclose"
```

### Indexer polling

The indexer ingests Horizon events asynchronously, so on-chain writes appear in
the REST API a few seconds later. Poll rather than `sleep`-and-hope:

```ts
import { pollIndexer } from './setup/helpers.js';
import request from 'supertest';

const invoice = await pollIndexer(
  () => request('http://localhost:3000').get(`/invoices/${id}`).then((r) => r.body),
  (body) => body?.status === 'Funded',
  { description: `invoice ${id} to become Funded`, timeoutMs: 30_000 },
);
```

`pollIndexer(produce, predicate, opts?)` calls `produce()` until `predicate`
holds (or it times out), then returns the matching value.

---

## Writing a new test

Tests are plain Jest specs (`*.test.ts`). There are two flavours in this suite;
pick the one that fits what you're verifying.

### A. Indexer-only tests (hermetic, always run)

For behaviour that doesn't need a live chain, stand up an **in-memory** indexer
and seed it with the shared fixtures — no Docker node, no secrets, fast and
deterministic. `reputation.test.ts` is the model:

```ts
import { createApp } from '../../indexer/src/app.js';
import { getDb } from '../../indexer/src/database/db.js';
import { initializeSchema } from '../../indexer/src/database/schema.js';
import { seedReputation } from '../../indexer/tests/helpers.js';
import request from 'supertest';

describe('E2E - my new indexer behaviour', () => {
  let db, appServer;

  beforeAll(() => {
    db = getDb(':memory:');
    initializeSchema(db);
    appServer = createApp(db).listen(3005); // pick a port no other file uses
  });

  afterAll((done) => {
    db?.close();
    appServer ? appServer.close(done) : done();
  });

  it('returns the seeded value', async () => {
    seedReputation(db, { address: 'GTEST...', new_score: 42, /* … */ });
    const res = await request('http://localhost:3005').get('/reputation/GTEST...');
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(42);
  });
});
```

> **Port discipline:** each file that starts an Express server must use a unique
> port (`lifecycle`=3001, `reputation`=3002, …). Reusing a port across files
> causes `EADDRINUSE` under `--runInBand`.

### B. On-chain tests (opt-in, skipped without secrets)

For flows that must touch the chain (lifecycle, governance), guard the test on
funded secrets so the default run stays hermetic. `lifecycle.test.ts` is the
model — note the early-return skip:

```ts
it('does the on-chain thing', async () => {
  // Skip unless the caller supplied funded keys.
  if (!process.env.TEST_SUBMITTER_SECRET || !process.env.TEST_LP_SECRET) {
    console.log('Skipping: TEST_SUBMITTER_SECRET / TEST_LP_SECRET not set');
    return;
  }

  // 1. Act on-chain via the SDK.
  // 2. Advance ledgers if a timelock is involved:  await advanceLedger(n);
  // 3. Assert via the SDK (source of truth) …
  // 4. … then poll the indexer to confirm it caught up:
  //      await pollIndexer(fetchFromApi, (v) => v.status === 'Expected');
}, 240_000); // on-chain tests need a long timeout
```

Annotated checklist for a good on-chain test:

1. **Skip cleanly** when its secrets/contract IDs are absent — never fail the
   default run.
2. **Fund** any fresh account with `fundAccount` before using it.
3. **Use the SDK** (`sdk/src/...`) for contract calls rather than hand-rolling
   Soroban XDR.
4. **Advance ledgers** with `advanceLedger` for anything gated by a timelock.
5. **Assert on-chain first** (the contract is the source of truth), then
   **`pollIndexer`** to assert the API reflects it.
6. Give the test a generous `testTimeout` (the global default is 120 s; on-chain
   tests often pass `240_000`).

---

## Debugging a failing test

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Stellar node did not become ready within timeout` | Docker not running, port `8000` busy, or image still pulling. | `docker ps`; free port 8000; pre-pull `docker pull stellar/stellar-quickstart:latest`. |
| `EADDRINUSE` | Two files bound the same Express port, or a previous run left a server up. | Give each file a unique port; kill stray `node` processes. |
| `pollIndexer timed out` | The indexer never reached the expected state. | Confirm the on-chain action actually succeeded (assert via SDK first); raise `timeoutMs`; check the event subscription in the test. |
| `advanceLedger timed out` | Node not closing ledgers (manual-close mode with nothing driving closes). | Drive a close via `curl http://localhost:11626/manualclose`, or use the default auto-closing `standalone` node. |
| On-chain test silently does nothing | It skipped because secrets are unset. | Export `TEST_SUBMITTER_SECRET` / `TEST_LP_SECRET` (funded testnet keys). |
| Transaction failures (`txFAILED`, fee/seq errors) | Account unfunded or stale sequence number. | `await fundAccount(pk)`; refetch the account/sequence immediately before building the tx. |

Useful commands while debugging:

```bash
# Is the node healthy?
curl -s http://localhost:8000/ledger | jq .

# Watch node logs in another terminal
docker compose -f docker-compose.test.yml logs -f stellar

# Run a single test with full output and open handle detection
npm run test:e2e -- governance.test.ts --verbose --detectOpenHandles

# Start fresh if state looks corrupt
docker compose -f docker-compose.test.yml down -v && npm run test:e2e
```

If a test leaks (Jest warns about open handles), make sure every `beforeAll`
resource — DB connection, Express server, event subscription — is released in
the matching `afterAll`.
