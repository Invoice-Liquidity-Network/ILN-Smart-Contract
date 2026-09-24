# Observability Standards

**Status:** Adopted — foundation landed (Issue #776); per-file `console.*` migration is tracked as follow-up (see [§6](#6-migration-status)).
**Scope:** Structured logging and cross-service correlation for the ILN **indexer** and **notifications** services. Contract-side observability is on-chain events (`docs/events.md`) and is out of scope here.

Effective incident response depends on correlating logs across services quickly ([incident-response-runbook.md §8, §11](incident-response-runbook.md#8-off-chain-service-incidents-indexer--notifications)). This document is the standard that makes that possible.

---

## 1. Audit of the pre-#776 state

| Service | What logging looked like |
|---------|--------------------------|
| **indexer** | Ad-hoc `console.log` / `console.warn` / `console.error` in `index.ts`, the ingestion loop, reconciliation, and websocket code. Free-text messages, no timestamps beyond what the log shipper adds, no request or event identifier, no consistent level field. Grepping for "what happened to event X" meant substring-matching prose. |
| **notifications** | `console.log` in `index.ts`; `logger: (msg) => console.log(msg)` handed to `WebhookDeliveryService`; `logger: console` handed to the email client. Same problems, plus: a delivery could not be tied back to the on-chain event that triggered it. |

Neither service emitted a correlation ID, so a single logical flow — *ledger event → indexer ingestion → notification dispatch → webhook/email delivery* — produced log lines in two places with nothing linking them.

---

## 2. The standard: one-line JSON

Every log line is a single JSON object, one per line (JSONL), written to `stdout` (`debug`/`info`) or `stderr` (`warn`/`error`).

### Required fields

| Field | Type | Meaning |
|-------|------|---------|
| `ts` | string | ISO-8601 UTC timestamp (`new Date().toISOString()`). |
| `level` | `"debug" \| "info" \| "warn" \| "error"` | Severity. |
| `service` | `"indexer" \| "notifications"` | Emitting service (`LOG_SERVICE` env override). |
| `msg` | string | Short, stable, human-readable event description. Lowercase, no trailing punctuation, no interpolated values — put values in fields. |

### Contextual fields (added automatically when a context is active)

| Field | Meaning |
|-------|---------|
| `correlationId` | See [§3](#3-correlation-ids). Present on every line emitted inside a request/event scope. |
| `method`, `path` | HTTP method and route, for request-scoped lines. |

### Ad-hoc fields

Anything else is a caller-supplied field: `logger.info('ingestion leader acquired', { ledger: 12345, leaseId })`. Prefer typed, queryable fields over embedding values in `msg`.

### Levels

- `error` — an operation failed and needs attention (delivery permanently failed, ingestion loop crashed, DB unreachable).
- `warn` — degraded but recovering, or a misconfiguration (circuit breaker opened, contract id not set, retry scheduled).
- `info` — lifecycle and significant state changes (service listening, leader acquired/released, reconciliation run complete).
- `debug` — verbose tracing, off by default. `LOG_LEVEL=debug` to enable.

`LOG_LEVEL` (default `info`) sets the minimum level emitted.

---

## 3. Correlation IDs

A `correlationId` identifies **one logical flow** end to end. It is a UUID v4 unless an upstream supplied one.

### Propagation within a service

Each service has a logger backed by Node's `AsyncLocalStorage`:

```ts
import { logger, runWithContext, newCorrelationId } from './lib/logger.js';

runWithContext({ correlationId: newCorrelationId() }, async () => {
  logger.info('processing event', { eventId });   // line carries correlationId automatically
  await handle(event);                             // ...and so does every log line inside handle()
});
```

`bindContext({ eventId })` merges more fields into the active scope after the fact.

### Propagation between services

The HTTP boundary carries the id in the **`x-correlation-id`** header (falling back to `x-request-id` on read):

- **Inbound:** `createRequestIdMiddleware()` (registered first in both `app`s) reads the header if it matches `^[A-Za-z0-9_.:-]{1,128}$`, otherwise mints a new id, echoes it on the response, and runs the request inside `runWithContext`.
- **Outbound:** when the notifications service is triggered by an indexed on-chain event, the caller sends `x-correlation-id: <ledger event id>` so a webhook/email delivery log line and the ingestion log line share an id. When the notifications service makes its own outbound webhook call, it forwards the current `correlationId` on that request.

### The canonical flow

```
ledger event  ──(x-correlation-id: evt_<ledgerSeq>_<idx>)──▶  indexer ingestion
     │                                                              │
     │  logger.info('event ingested', { correlationId: evt_..., eventId })
     ▼
notifications dispatch  ──(same x-correlation-id)──▶  webhook / email delivery
     │
     │  logger.info('webhook delivered', { correlationId: evt_..., subscriptionId, status })
```

Grep one `correlationId` across both services' logs and you have the whole timeline.

---

## 4. What to log (minimum, for incident readiness)

**Indexer**
- Ingestion: leader lease acquired/released, Horizon stream (re)connect and errors, each processed ledger range at `debug`, catch-up start/finish.
- Reconciliation: run start/finish, every mismatch found (with invoice id and both values), alert dispatched.
- API: 5xx responses (with `correlationId`, `method`, `path`, `status`), rate-limit rejections at `warn`.
- Lifecycle: service listening, DB open failure, config gaps (`contractId` unset).

**Notifications**
- Delivery: attempt, success (`subscriptionId`, `channel`, `status`, `attempt`), permanent failure, retry scheduled.
- Circuit breaker: opened / half-open / closed (with the target).
- Security: HMAC verification failure, SSRF-blocked URL, email header/URL sanitization rejection — at `warn`, retained per [monitoring-runbook.md §3](monitoring-runbook.md#3-log-retention) for abuse review.
- Lifecycle: service listening, DB open failure.

Never log: full webhook payloads or email bodies (PII; see the retention policy in `deliveryHistory`), API keys, HMAC secrets, `auth_token`-equivalent values, raw signer key material.

---

## 5. Retention and shipping

Governed by [monitoring-runbook.md §3](monitoring-runbook.md#3-log-retention): indexer application logs ≥ 30 days hot / ≥ 90 days cold; notifications delivery logs ≥ 30 days hot with HMAC failures retained for abuse review; ship to a centralized store (CloudWatch / Loki / Datadog) — never rely on container ephemeral disk. JSONL lines ingest directly into all of these with `correlationId` as an indexed field.

---

## 6. Migration status

| Done (#776) | Follow-up |
|-------------|-----------|
| `indexer/src/lib/logger.ts`, `notifications/src/lib/logger.ts` — the structured logger. | Convert remaining `console.*` call sites in both services file-by-file to `logger.*` with typed fields. |
| `createRequestIdMiddleware` wired first in both `app`s; `x-correlation-id` in/out. | Forward `x-correlation-id` on the notifications service's own outbound webhook calls. |
| `indexer/src/index.ts` and `notifications/src/index.ts` lifecycle logs converted; `WebhookDeliveryService` logger routed through the structured logger. | Route the email client's `logger: console` through the structured logger once its logger type is confirmed. |
| This document. | Add a lint rule (`no-console` in `src/`, excluding the logger module) once the migration is complete. |

---

## 7. Cross-references

- [`docs/incident-response-runbook.md`](incident-response-runbook.md) — where correlation IDs are used during a live incident and in the post-incident review.
- [`docs/monitoring-runbook.md`](monitoring-runbook.md) — health checks, alert thresholds, log retention.
- [`docs/indexer-incident-runbook.md`](indexer-incident-runbook.md) · [`docs/notifications-operations.md`](notifications-operations.md) — the service-specific recovery procedures these logs support.
