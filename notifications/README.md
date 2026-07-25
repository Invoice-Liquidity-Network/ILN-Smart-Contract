# @iln/notifications

Webhook, Slack, and email notification service for the Invoice Liquidity
Network. It receives invoice lifecycle events and fans them out to registered
subscribers — signing every webhook payload with HMAC-SHA256 so integrators can
verify authenticity.

This guide is the complete integrator reference: architecture, configuration,
webhook registration, the event catalogue, HMAC signature verification in three
languages, and email delivery setup.

---

## Table of contents

- [Overview & architecture](#overview--architecture)
- [Local development](#local-development)
- [Environment variables](#environment-variables)
- [HTTP API](#http-api)
- [Registering a webhook (walkthrough)](#registering-a-webhook-walkthrough)
- [Event types & payloads](#event-types--payloads)
- [Verifying the HMAC signature](#verifying-the-hmac-signature)
  - [TypeScript / Node.js](#typescript--nodejs)
  - [Python](#python)
  - [Go](#go)
- [Reliability: circuit breaker & rate limiting](#reliability-circuit-breaker--rate-limiting)
- [Slack notifications](#slack-notifications)
- [Email delivery](#email-delivery)
- [Docker](#docker)

---

## Overview & architecture

The service is a small Express app (`src/index.ts`) that wires together a few
focused components:

```
                        ┌────────────────────────────────────────────┐
   invoice lifecycle    │              @iln/notifications             │
   event  ───────────►  │                                            │
                        │  SubscriptionStore  (SQLite: who wants what)│
                        │          │                                  │
                        │          ▼                                  │
                        │  WebhookDeliveryService                     │
                        │    ├─ HMAC-SHA256 sign  (x-iln-signature)   │
                        │    ├─ CircuitBreaker    (per endpoint)      │
                        │    ├─ RateLimiter       (per endpoint)      │
                        │    ├─ RetryQueue        (failed deliveries) │
                        │    └─ DeliveryHistory   (audit log)         │
                        │                                            │
                        │  SlackRouter        (Block Kit messages)    │
                        │  EmailDeliveryService (Resend adapter)      │
                        └───────────────┬────────────────────────────┘
                                        │  POST <subscriber URL>
                                        ▼
                              subscriber HTTPS endpoint
```

| Component | File | Responsibility |
|-----------|------|----------------|
| Subscription store | `src/subscriptions/subscriptionStore.ts` | CRUD for webhook subscriptions, persisted in SQLite. |
| Webhook delivery | `src/delivery/webhookDelivery.ts` | Signs and POSTs payloads; coordinates breaker, limiter, retries, history. |
| Signature | `src/delivery/signature.ts` | HMAC-SHA256 sign/verify (`x-iln-signature`). |
| Circuit breaker | `src/delivery/circuitBreaker.ts` | Stops hammering a failing endpoint. |
| Rate limiter | `src/delivery/rateLimiter.ts` | Sliding-window per-endpoint cap. |
| Retry queue | `src/queue/retryQueue.ts` | Re-attempts failed deliveries with backoff. |
| Delivery history | `src/delivery/deliveryHistory.ts` | Audit log queryable per webhook. |
| Slack router/delivery | `src/api/slack.ts`, `src/delivery/slack.ts` | Slack subscriptions and Block Kit message delivery. |
| Email delivery | `src/delivery/emailDelivery.ts` | Transactional email via the Resend SDK adapter. |

---

## Local development

```bash
cd notifications
npm install
npm run dev            # tsx src/index.ts — starts the service (default :3001)
npm run test           # vitest
npm run test:coverage  # vitest with 90% threshold + lcov report
```

---

## Environment variables

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `PORT` | `3001` | no | HTTP listen port (also serves `GET /health`). |
| `RESEND_API_KEY` | — | for email | API key for the [Resend](https://resend.com) SDK used by `EmailDeliveryService`. |
| `EMAIL_FROM` | — | for email | `From` address for outbound email (e.g. `notifications@iln.example`). |

> Per-subscription secrets are **not** environment variables — each webhook
> subscription carries its own `secret` (see below), which is used both to sign
> that subscription's payloads and to authorize reads of its delivery history.

---

## HTTP API

Base URL defaults to `http://localhost:3001`. All bodies are JSON.

### Webhooks

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/webhooks` | Register a subscription. |
| `GET` | `/webhooks` | List subscriptions. |
| `GET` | `/webhooks/:id` | Fetch one subscription. |
| `PUT` | `/webhooks/:id` | Update `url`, `secret`, and/or `eventTypes`. |
| `DELETE` | `/webhooks/:id` | Remove a subscription. |
| `GET` | `/webhooks/:id/deliveries` | Paginated delivery history (**auth required**). |

### Slack

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/subscriptions/slack` | Register a Slack incoming-webhook subscription. |
| `GET` | `/subscriptions/slack` | List Slack subscriptions. |
| `DELETE` | `/subscriptions/slack/:id` | Remove a Slack subscription. |
| `POST` | `/notify/slack` | Fan an event out to matching Slack subscribers. |

### Service

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness probe → `{ "status": "ok" }`. |

**`POST /webhooks` request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | yes | HTTPS endpoint that will receive `POST` deliveries. |
| `secret` | string | yes | Shared secret used to HMAC-sign payloads to this endpoint. Store it safely. |
| `eventTypes` | string[] | yes | Non-empty list of [event types](#event-types--payloads) to receive. |
| `endpointId` | string | no | Stable id used to key the circuit breaker / rate limiter (defaults to `url`). |

**Responses**

| Status | Body | When |
|--------|------|------|
| `201` | `{ id, url, eventTypes, createdAt }` | Created. |
| `400` | `{ "error": "invalid_body" }` | Missing `url`/`secret`, or empty/`non-array` `eventTypes`. |
| `400` | `{ "error": "invalid_url" }` | `url` failed validation. |
| `404` | `{ "error": "not_found" }` | Unknown id (GET/PUT/DELETE one). |
| `401` | `{ "error": "unauthorized" }` | Missing/invalid `x-api-key` on `/deliveries`. |

---

## Registering a webhook (walkthrough)

**1. Create the subscription.** Pick a strong `secret` (you'll verify signatures
with it) and the events you care about:

```bash
curl -X POST http://localhost:3001/webhooks \
  -H "content-type: application/json" \
  -d '{
    "url": "https://my-app.example/hooks/iln",
    "secret": "whsec_3f8c0c2a9b6e4d1f...",
    "eventTypes": ["invoice.funded", "invoice.paid"]
  }'
```

```json
{
  "id": "sub_lq3x9f_a1b2c3",
  "url": "https://my-app.example/hooks/iln",
  "eventTypes": ["invoice.funded", "invoice.paid"],
  "createdAt": 1733184000000
}
```

**2. Receive deliveries.** The service `POST`s each matching event to your `url`
with these headers:

| Header | Value |
|--------|-------|
| `content-type` | `application/json` |
| `x-iln-signature` | `HMAC-SHA256(secret, rawRequestBody)` as lowercase hex |

**3. Verify the signature** on every request before trusting it (see
[Verifying the HMAC signature](#verifying-the-hmac-signature)).

**4. Inspect/update the subscription** as needed:

```bash
# List
curl http://localhost:3001/webhooks

# Fetch one (includes current circuit-breaker state)
curl http://localhost:3001/webhooks/sub_lq3x9f_a1b2c3

# Change the subscribed events
curl -X PUT http://localhost:3001/webhooks/sub_lq3x9f_a1b2c3 \
  -H "content-type: application/json" \
  -d '{"eventTypes": ["invoice.submitted", "invoice.funded", "invoice.paid"]}'

# Delete
curl -X DELETE http://localhost:3001/webhooks/sub_lq3x9f_a1b2c3
```

**5. Audit deliveries.** The delivery history is protected — pass the
subscription's `secret` as `x-api-key`:

```bash
curl -H "x-api-key: whsec_3f8c0c2a9b6e4d1f..." \
  "http://localhost:3001/webhooks/sub_lq3x9f_a1b2c3/deliveries?page=1&pageSize=20"
```

---

## Event types & payloads

Each webhook delivery body has a stable envelope:

```json
{
  "event": "invoice.funded",
  "invoiceId": 42,
  "data": { "...": "event-specific fields" },
  "timestamp": "2025-12-03T00:00:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `event` | string | The event type (table below). |
| `invoiceId` | number | The invoice the event concerns. |
| `data` | object | Event-specific payload. |
| `timestamp` | string | ISO-8601 UTC time the event was emitted. |

**Supported event types**

| Event | Emitted when | Example `data` |
|-------|--------------|----------------|
| `invoice.submitted` | A freelancer submits a new invoice. | `{ "freelancer": "GAAA...", "payer": "GBBB...", "token": "USDC", "amount": "1000000", "dueDate": 1735689600 }` |
| `invoice.funded` | A liquidity provider funds an invoice. | `{ "funder": "GCCC...", "token": "USDC", "amount": "950000", "dueDate": 1735689600 }` |
| `invoice.paid` | The payer settles the invoice. | `{ "payer": "GBBB...", "token": "USDC", "amount": "1000000" }` |
| `invoice.expiring_soon` | An invoice is approaching its due date. | `{ "token": "USDC", "amount": "1000000", "dueDate": 1735689600 }` |

> Amounts are integer **stroop** strings; `dueDate` is Unix seconds. Additional
> lifecycle events (e.g. cancellation, dispute, default) follow the same
> envelope — subscribe by listing their event names in `eventTypes`.

**Full delivery example** (what lands at your endpoint):

```http
POST /hooks/iln HTTP/1.1
content-type: application/json
x-iln-signature: 9f1d4c0b8a7e6f5d4c3b2a1908f7e6d5c4b3a2910f8e7d6c5b4a39281706f5e4

{"event":"invoice.paid","invoiceId":42,"data":{"payer":"GBBB...","token":"USDC","amount":"1000000"},"timestamp":"2025-12-03T00:00:00.000Z"}
```

---

## Verifying the HMAC signature

The `x-iln-signature` header is `HMAC-SHA256` of the **exact raw request body
bytes**, keyed by the subscription's `secret`, encoded as lowercase hex. Always:

1. Read the **raw** body bytes — verify **before** JSON parsing/re-serialising,
   because re-serialisation can change the bytes and break the signature.
2. Use a **constant-time** comparison to avoid timing attacks.

### TypeScript / Node.js

This mirrors `src/delivery/signature.ts` exactly.

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(
  secret: string,
  rawBody: string | Buffer,
  signature: string,
): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// Express: capture the raw body so the signed bytes are preserved.
import express from 'express';
const app = express();
app.post(
  '/hooks/iln',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const signature = req.header('x-iln-signature') ?? '';
    if (!verifySignature(process.env.ILN_WEBHOOK_SECRET!, req.body, signature)) {
      return res.status(401).send('bad signature');
    }
    const event = JSON.parse(req.body.toString('utf8'));
    // ... handle event ...
    res.sendStatus(200);
  },
);
```

### Python

```python
import hmac
import hashlib

def verify_signature(secret: str, raw_body: bytes, signature: str) -> bool:
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    # constant-time comparison
    return hmac.compare_digest(expected, signature)

# Flask example
from flask import Flask, request, abort

app = Flask(__name__)

@app.post("/hooks/iln")
def hook():
    signature = request.headers.get("x-iln-signature", "")
    if not verify_signature(SECRET, request.get_data(), signature):
        abort(401)
    event = request.get_json()
    # ... handle event ...
    return "", 200
```

### Go

```go
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
)

func verifySignature(secret string, body []byte, signature string) bool {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	// constant-time comparison
	return hmac.Equal([]byte(expected), []byte(signature))
}

func handler(secret string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "read error", http.StatusBadRequest)
			return
		}
		if !verifySignature(secret, body, r.Header.Get("x-iln-signature")) {
			http.Error(w, "bad signature", http.StatusUnauthorized)
			return
		}
		// ... json.Unmarshal(body, &event); handle ...
		w.WriteHeader(http.StatusOK)
	}
}
```

---

## Reliability: circuit breaker & rate limiting

Delivery to each endpoint is protected independently:

- **Circuit breaker** (`circuitBreaker.ts`): opens after **5 consecutive
  failures**, stays open for a **10-minute cooldown**, then allows a **single
  half-open probe** before closing again. While open, deliveries are skipped
  with reason `circuit_open`. The current state (`closed` / `open` /
  `half-open`) is returned in `GET /webhooks/:id` as `circuitState`.
- **Rate limiter** (`rateLimiter.ts`): a sliding window allowing **1000
  deliveries per hour** per endpoint by default. Over-limit deliveries are
  skipped with reason `rate_limited` (HTTP `429` semantics).
- **Retry queue** (`retryQueue.ts`): transient failures (e.g. `5xx`) are
  re-attempted with backoff; the outcome of each attempt is recorded in the
  delivery history.

A delivery is considered successful on a `2xx` response. Non-`2xx` and network
errors count as failures toward the circuit breaker.

---

## Slack notifications

Register a Slack [incoming webhook](https://api.slack.com/messaging/webhooks)
URL to receive richly-formatted Block Kit messages:

```bash
curl -X POST http://localhost:3001/subscriptions/slack \
  -H "content-type: application/json" \
  -d '{
    "url": "https://hooks.slack.com/services/T000/B000/XXXX",
    "eventTypes": ["invoice.funded", "invoice.paid"]
  }'
```

Only these event types are accepted for Slack: `invoice.submitted`,
`invoice.funded`, `invoice.paid`, `invoice.expiring_soon` (anything else returns
`400 unsupported_event_types`). Messages are colour-coded per event and include
token, amount, parties, and due date.

---

## Email delivery

Transactional email is sent through the `EmailDeliveryService`
(`src/delivery/emailDelivery.ts`), which wraps the [Resend](https://resend.com)
SDK. To enable it:

1. Set `RESEND_API_KEY` and `EMAIL_FROM` (see
   [Environment variables](#environment-variables)).
2. Construct the service with a Resend-backed client and your `From` address:

```ts
import { Resend } from 'resend';
import { EmailDeliveryService } from './delivery/emailDelivery.js';

const resend = new Resend(process.env.RESEND_API_KEY!);

const email = new EmailDeliveryService(
  {
    async send(msg) {
      const { data } = await resend.emails.send({
        from: process.env.EMAIL_FROM!,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
      });
      return { id: data?.id ?? '' };
    },
  },
  process.env.EMAIL_FROM!,
);

const result = await email.send({
  to: 'freelancer@example.com',
  subject: 'Your invoice #42 was funded',
  html: '<p>Invoice <b>#42</b> was funded for 0.95 USDC.</p>',
});
// result -> { ok: true, id: '...' }  |  { ok: false, error: '...' }
```

`send()` never throws — it returns `{ ok: false, error }` on failure so callers
can decide whether to retry or alert. Subscribe an email address to invoice
events by routing the relevant webhook/event into `email.send(...)` with your
own templating.

---

## Docker

```bash
# Build the image (multi-stage; final image runs as non-root)
docker build -t iln/notifications:latest ./notifications

# Run standalone
docker run --rm -p 3001:3001 \
  -e RESEND_API_KEY=... -e EMAIL_FROM=notifications@iln.example \
  iln/notifications:latest

# Or via docker-compose (includes Postgres dependency)
docker compose up -d notifications
```

The image exposes a `HEALTHCHECK` against `GET /health` and listens on port
`3001`.
