# ILN Technical Architecture

> **Design rationale:** The major design choices behind this architecture are
> documented as Architecture Decision Records in [`docs/adr/`](adr/README.md).

## Table of Contents

- [System Overview](#system-overview)
- [Component Descriptions](#component-descriptions)
- [Data Flows](#data-flows)
- [Technology Decisions](#technology-decisions)
- [Deployment Topology](#deployment-topology)
- [Smart Contracts (detailed)](#smart-contracts-detailed)

---

## System Overview

Invoice Liquidity Network is a two-sided protocol on Stellar that connects invoice holders (freelancers, SMEs) with liquidity providers (DeFi users). The system consists of multiple components that work together:

```ascii
                           ┌──────────────────────────────────────────────────┐
                           │                   Frontend                       │
                           │        (Web dApp / Mobile App / Dashboard)       │
                           └──────────────┬───────────────────────────────────┘
                                          │
                                          │
            ┌─────────────────────────────┼─────────────────────────────┐
            │               ┌─────────────▼─────────────┐               │
            │               │        @iln/sdk           │               │
            │               │    TypeScript SDK         │               │
            │               │  (typed contract client)  │               │
            │               └─────────────┬─────────────┘               │
            │                             │                             │
            │          ┌──────────────────┼──────────────────┐          │
            │          ▼                  ▼                  ▼          │
            │  ┌────────────┐    ┌──────────────┐    ┌──────────────┐  │
            │  │ @iln/cli   │    │   Soroban    │    │ @iln/indexer│  │
            │  │ Terminal   │    │ Smart        │    │ REST API    │  │
            │  │ Interface  │◄──►│ Contracts    │◄──►│ Event       │  │
            │  │            │    │ (WASM)       │    │ Indexer     │  │
            │  └────────────┘    └──────┬───────┘    └──────┬───────┘  │
            │                          │                    │          │
            └──────────────────────────┼────────────────────┼──────────┘
                                       │                    │
                              ┌────────▼────────┐   ┌───────▼────────┐
                              │  Stellar Network │   │  @iln/notify  │
                              │  (Horizon + RPC) │   │  Webhook &    │
                              │                  │   │  Email Service│
                              └──────────────────┘   └───────────────┘
```

### Component Map

| Component | Location | Role |
|-----------|----------|------|
| **Smart Contracts** | `contracts/` | On-chain escrow, governance, distribution, reputation |
| **TypeScript SDK** | `sdk/` | Typed client library for contract interaction |
| **CLI** | `cli/` | Terminal-based wallet and invoice management |
| **Indexer** | `indexer/` | REST API indexing Horizon events into a queryable database |
| **Notifications** | `notifications/` | Webhook and email delivery for on-chain events |
| **Frontend** | External | Web/mobile dApps consuming SDK and indexer APIs |

---

## Component Descriptions

### Smart Contracts (Soroban WASM)

Four Soroban contracts deployed to each Stellar network. See [Contracts](#smart-contracts-detailed) for full details.

- **invoice_liquidity** — Core escrow: submit, fund, settle, cancel, default invoices; multi-token support; reputation scoring.
- **iln_governance** — On-chain governance: proposals, voting, delegation, quorum, admin veto.
- **iln_distribution** — Yield and incentive distribution for LPs, freelancers, and payers.
- **reputation_bonus** — Reputation-based discount bonuses and invoice hooks.

### TypeScript SDK (`@iln/sdk`)

A typed client library that wraps raw Soroban RPC calls. It provides:
- Typed functions for every contract operation (`submitInvoice`, `fundInvoice`, `markPaid`, `claimDefault`, etc.)
- Query helpers (`getInvoice`, `listInvoicesBySubmitter`, `listInvoicesByLP`, `getReputation`)
- Error type hierarchy (`ILNError` subclasses for every contract error code)
- Works in both browser (Freighter wallet) and Node.js (keypair) environments
- Full TypeScript types exported for `Invoice`, `ReputationProfile`, `ContractStats`

Why a dedicated SDK? The Soroban RPC uses raw XDR ScVal encoding which is error-prone. The SDK provides a type-safe layer that converts between native JS types and ScVal, so integrators never touch XDR directly.

### CLI (`@iln/cli`)

A terminal application that wraps the SDK for direct interaction:
- Wallet management (generate, import, show balances, fund via Friendbot)
- Invoice operations (submit, list, cancel)
- Reputation queries
- JSON output mode for CI/scripting
- Shell completion (bash, zsh, fish)

### Indexer (`@iln/indexer`)

A REST API service that listens to Stellar Horizon for contract events and indexes them into a SQLite database. It exists because:
- Soroban contract storage is not directly queryable by field — you must know the exact key
- The indexer provides SQL-powered queries: list all invoices by status, aggregate stats, leaderboards, reputation scores
- Reduces RPC load on Soroban endpoints

Endpoints: `GET /invoices`, `GET /stats`, `GET /leaderboard`, `GET /reputation`, `GET /health`.

### Notifications (`@iln/notifications`)

A webhook and email notification service that delivers real-time alerts for on-chain events. Features:
- Webhook delivery with HMAC-SHA256 payload signing
- Per-endpoint circuit breaker (5 failures → 10 min cooldown → half-open probe)
- Per-endpoint sliding-window rate limiter (1000 deliveries/hour default)
- Subscription CRUD (create, list, delete webhooks)
- Email delivery via Resend SDK adapter

### Frontend (External)

Web and mobile applications that consume the SDK and indexer APIs. Not part of this repository but referenced to show the full architecture.

---

## Data Flows

### Invoice Submission Flow

```ascii
Freelancer                @iln/sdk              Soroban Contract          Indexer
    │                        │                        │                     │
    │  submitInvoice(payer,  │                        │                     │
    │   amount, dueDate,     │                        │                     │
    │   discountRate, token) │                        │                     │
    │───────────────────────►│                        │                     │
    │                        │  submit_invoice()      │                     │
    │                        │───────────────────────►│                     │
    │                        │                        │─ validate inputs    │
    │                        │                        │─ assign ID          │
    │                        │                        │─ save (Pending)     │
    │                        │                        │─ emit "submitted"   │
    │                        │                        │                     │
    │                        │  return InvoiceId      │                     │
    │                        │◄───────────────────────│                     │
    │  return InvoiceId      │                        │                     │
    │◄───────────────────────│                        │                     │
    │                        │                        │  poll/subscribe     │
    │                        │                        │◄────────────────────│
    │                        │                        │  "submitted" event  │
    │                        │                        │────────────────────►│
    │                        │                        │                     │─ persist to DB
```

### LP Funding Flow

```ascii
LP                      @iln/sdk              Soroban Contract          Indexer
 │                         │                        │                     │
 │  fundInvoice(invoiceId, │                        │                     │
 │   amount)               │                        │                     │
 │────────────────────────►│                        │                     │
 │                         │  fund_invoice()        │                     │
 │                         │───────────────────────►│                     │
 │                         │                        │─ assert Pending     │
 │                         │                        │─ transfer LP→contract│
 │                         │                        │─ transfer→freelancer │
 │                         │                        │─ save (Funded)       │
 │                         │                        │─ emit "funded"       │
 │                         │                        │                     │
 │                         │  return confirmed      │                     │
 │                         │◄───────────────────────│                     │
 │  return txHash + yield  │                        │                     │
 │◄────────────────────────│                        │                     │
 │                         │                        │  poll/subscribe      │
 │                         │                        │◄─────────────────────│
 │                         │                        │  "funded" event      │
 │                         │                        │─────────────────────►│
 │                         │                        │                      │─ persist to DB
```

### Event Indexing Flow

```ascii
Soroban Contract         Stellar Network          Indexer               Client App
       │                        │                    │                      │
       │─ emit "funded"         │                    │                      │
       │───────────────────────►│                    │                      │
       │                        │─ Horizon ingest    │                      │
       │                        │───────────────────►│                      │
       │                        │                    │─ parse event XDR     │
       │                        │                    │─ update SQLite       │
       │                        │                    │                      │
       │                        │                    │  GET /invoices       │
       │                        │                    │◄─────────────────────│
       │                        │                    │─────────────────────►│
       │                        │                    │  return JSON         │
       │                        │                    │◄─────────────────────│
```

### Notification Delivery Flow

```ascii
Soroban Contract         Stellar Network          Indexer             Notifications
       │                        │                    │                     │
       │─ emit "paid"           │                    │                     │
       │───────────────────────►│                    │                     │
       │                        │─ Horizon ingest    │                     │
       │                        │───────────────────►│                     │
       │                        │                    │─ detect new event   │
       │                        │                    │─ push to SNS/queue  │
       │                        │                    │────────────────────►│
       │                        │                    │                     │─ look up webhooks
       │                        │                    │                     │─ sign payload
       │                        │                    │                     │─ POST to endpoint
       │                        │                    │                     │─ send email (if configured)
```

---

## Technology Decisions

### Why Stellar / Soroban?

- **Low fees** — Soroban transactions cost fractions of a cent, making micro-invoice financing viable.
- **Fast finality** — 3–5 second confirmation, versus minutes on other chains.
- **Built-in asset support** — USDC, EURC, and other Stellar assets are natively supported via the Stellar Asset Contract (SAC) interface.
- **No MEV** — Stellar's consensus protocol does not allow frontrunning or transaction reordering.
- **Rust-based contracts** — Soroban contracts are written in Rust, providing memory safety and the WASM compilation target.

See [ADR-001: Soroban Chain Choice](adr/ADR-001-soroban-chain-choice.md).

### Why the TypeScript SDK?

- **Developer experience** — The Soroban RPC communicates in raw XDR ScVal; the SDK provides a typed, documented API that handles encoding/decoding automatically.
- **Universal runtime** — Works in browsers (via Freighter wallet) and Node.js, enabling both dApps and backend integrations.
- **Error type hierarchy** — Maps every contract error code to a typed `ILNError` subclass for precise error handling.

### Why the Indexer alongside Horizon?

- **Query flexibility** — Horizon only exposes raw operations and effects; the indexer provides SQL-level queries (list invoices by status, aggregate stats, leaderboards).
- **Reduced RPC cost** — Soroban RPC has rate limits and per-request costs; the indexer caches contract state and serves reads without RPC calls.
- **Off-chain aggregation** — Reputation scoring, leaderboards, and historical analytics require data that is expensive to compute from raw on-chain state.

### Why SQLite for the Indexer?

- **Zero infrastructure** — No database server to manage; the indexer is a single binary with a file-based database.
- **Good enough performance** — For a protocol at the scale of ILN, SQLite handles millions of invoice records easily.
- **Easy deployment** — Works with Docker volumes, no separate Postgres setup required for most deployments.

---

## Deployment Topology

### Production Deployment

```ascii
                          ┌──────────────────────┐
                          │   Cloudflare / DNS    │
                          └──────────┬───────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                 ▼
            ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
            │  Indexer     │ │ Notifications│ │  Frontend    │
            │  (Container) │ │ (Container)  │ │ (CDN/SPA)    │
            └──────┬───────┘ └──────┬───────┘ └──────────────┘
                   │                │
                   ▼                ▼
            ┌──────────────┐ ┌──────────────┐
            │   SQLite     │ │  PostgreSQL  │
            │   (Volume)   │ │  (Volume)    │
            └──────────────┘ └──────────────┘
                   │                │
                   └────────────────┘
                            │
                            ▼
                  ┌─────────────────────┐
                  │  Stellar Network     │
                  │  (Horizon + RPC)     │
                  └─────────────────────┘
                            │
                            ▼
                  ┌─────────────────────┐
                  │  Soroban Contracts  │
                  │  (WASM instances)   │
                  └─────────────────────┘
```

### Hosting Recommendations

| Component | Hosting | Scaling Strategy |
|-----------|---------|------------------|
| Indexer | Container (Docker/K8s) | Horizontal scaling behind load balancer |
| Notifications | Container (Docker/K8s) | Horizontal scaling, requires shared queue |
| Frontend | Static CDN (Cloudflare Pages, Vercel) | Automatic CDN scaling |
| SQLite | Volume mount | Vertical scaling, or migrate to Postgres |
| PostgreSQL | Managed DB (RDS, Cloud SQL) | Read replicas for notifications |

### Network Separation

- **Testnet** — All components deployed in a single staging environment for integration testing.
- **Mainnet** — Production deployment with separate database instances, stricter access controls, and monitoring.

---

## Smart Contracts (detailed)

### System actors

|             Actor           |       Role       |                  What they do                |
|-----------------------------|------------------|----------------------------------------------|
|         **Freelancer**      | Invoice holder   | Submits unpaid invoices, receives immediate liquidity |
|           **Payer**         | Invoice debtor   | The client who owes the money, settles the invoice on-chain |
| **Liquidity provider (LP)** | Funder           | Funds invoices at a discount, earns yield when payer settles |
|        **ILN Contract**     | Trustless escrow | Holds funds, enforces rules, routes payments |

### Contract storage model

The contract uses Soroban's persistent storage with two key types:

```
StorageKey::InvoiceCount       → u64 (auto-incrementing ID counter)
StorageKey::Invoice(id: u64)   → Invoice struct
```

Each `Invoice` struct holds the full state of one invoice:

```rust
Invoice {
    id:            u64,
    freelancer:    Address,
    payer:         Address,
    amount:        i128,      // full invoice value in stroops
    due_date:      u64,       // Unix timestamp
    discount_rate: u32,       // basis points (e.g. 300 = 3%)
    status:        InvoiceStatus,
    funder:        Option<Address>,
    funded_at:     Option<u64>,
}
```

Invoice status follows a strict one-way state machine:

```
Pending → Funded → Paid
                 → Defaulted
```

No status transition can go backwards. A Paid or Defaulted invoice is terminal.

### Contract flow

#### Step 1 — submit_invoice()

Called by the freelancer to register an unpaid invoice.

```ascii
Freelancer
    │
    ├─ require_auth()                  freelancer must sign
    ├─ validate amount > 0
    ├─ validate discount_rate 1–5000 bps
    ├─ validate due_date > now
    ├─ assign next invoice ID
    ├─ save Invoice { status: Pending }
    └─ emit "submitted" event
```

No funds move at this step. The invoice sits in `Pending` state until an LP funds it.

#### Step 2 — fund_invoice()

Called by a liquidity provider to fund a Pending invoice.

```ascii
LP
 │
 ├─ require_auth()
 ├─ load invoice, assert status == Pending
 ├─ calculate:
 │     discount_amount  = amount × discount_rate / 10_000
 │     freelancer_payout = amount − discount_amount
 │
 ├─ token.transfer(LP → contract, amount)
 │     LP sends the full invoice value to the contract
 │
 ├─ token.transfer(contract → freelancer, freelancer_payout)
 │     Contract immediately pays out (amount − discount) to freelancer
 │     Freelancer has their liquidity. Invoice is now funded.
 │
 ├─ contract holds: discount_amount in escrow
 ├─ update Invoice { status: Funded, funder, funded_at }
 └─ emit "funded" event
```

After this step:
- The freelancer has received their money (minus the discount)
- The LP has committed funds and is waiting for the payer to settle
- The contract holds the discount amount in escrow

#### Step 3a — mark_paid() — happy path

Called by the payer to settle the invoice in full.

```ascii
Payer
 │
 ├─ require_auth()                     only the registered payer can call this
 ├─ load invoice, assert status == Funded
 ├─ assert due_date has not passed (optional: allow late payment)
 │
 ├─ token.transfer(payer → contract, amount)
 │     Payer sends the full invoice value to the contract
 │
 ├─ token.transfer(contract → funder, amount)
 │     Contract releases the full amount to the LP
 │     LP receives: their principal back + the escrowed discount = yield
 │
 ├─ update Invoice { status: Paid }
 └─ emit "paid" event
```

After this step the LP has earned the discount spread as yield:

```ascii
LP sent:        1,000 USDC  (at fund_invoice time)
LP received:    1,000 USDC  (from payer settlement)
Escrowed yield:    30 USDC  (3% discount, returned alongside principal)
Net yield:          3.00%
```

#### Step 3b — claim_default() — unhappy path

Called by the LP after the due date passes without payment.

```ascii
LP (original funder)
 │
 ├─ require_auth()
 ├─ load invoice, assert status == Funded
 ├─ assert env.ledger().timestamp() > due_date
 │
 ├─ token.transfer(contract → funder, discount_amount)
 │     LP recovers only the escrowed discount
 │     The freelancer's payout cannot be reversed
 │
 ├─ update Invoice { status: Defaulted }
 └─ emit "defaulted" event
```

In a default the LP loses `amount − discount_amount` (the freelancer's payout). The discount amount is returned as partial recourse. This is the core risk LPs accept — it is why discount rates exist.

### Money flow diagram

```ascii
                    fund_invoice()
                   ┌─────────────────────────────────────────────┐
                   │                                             │
                   ▼                                             │
LP ──── 1,000 USDC ──▶ CONTRACT ──── 970 USDC ──▶ FREELANCER   │
                         │                                       │
                         │ holds 30 USDC (discount escrow)       │
                         │                                       │
                    mark_paid()                                  │
                         │                                       │
PAYER ── 1,000 USDC ──▶ CONTRACT ──── 1,000 USDC ──▶ LP        │
                                       (principal + yield)       │
                                                                 │
                    claim_default() (if payer misses due_date)   │
                         │                                       │
                       CONTRACT ──── 30 USDC ──▶ LP             │
                                     (partial recourse only)     │
                                                                 └─
```

### Token handling

ILN uses USDC on Stellar, accessed via Soroban's native token interface:

```rust
use soroban_sdk::token::Client as TokenClient;

fn usdc_client(env: &Env) -> TokenClient {
    let address = Address::from_str(env, USDC_TOKEN);
    TokenClient::new(env, &address)
}
```

All amounts are stored and transferred in **stroops** (Stellar's base unit). 1 USDC = 10,000,000 stroops. The contract never converts — all arithmetic is in stroops to avoid rounding errors.

Discount calculation uses integer basis points to avoid floating point:

```rust
let discount_amount = invoice.amount
    .checked_mul(invoice.discount_rate as i128)
    .unwrap_or(0)
    / 10_000;
```

### Event emissions

The contract emits events at each state transition so indexers, frontends, and analytics tools can track activity without polling storage:

|    Event    |     Emitted by     |   Payload  |
|-------------|--------------------|------------|
| `submitted` | `submit_invoice()` | invoice ID |
|   `funded`  |   `fund_invoice()` | invoice ID |
|    `paid`   |    `mark_paid()`   | invoice ID |
| `defaulted` |  `claim_default()` | invoice ID |

### Security properties

**No admin key.** There is no privileged address that can pause the contract, drain funds, or alter invoice state. Once an invoice is funded, only the registered payer can trigger `mark_paid()` and only the original funder can trigger `claim_default()`.

**Auth on every state transition.** Every function that moves funds calls `require_auth()` on the relevant party before doing anything else. Unsigned calls revert immediately.

**Integer-only arithmetic.** No floating point anywhere in the contract. All amounts are `i128` in stroops. Discount calculations use basis points and integer division. Overflow is caught with `checked_mul`.

**Immutable invoice terms.** Once submitted, the amount, payer, due date, and discount rate cannot be changed. The LP knows exactly what they are funding when they call `fund_invoice()`.

**One funder per invoice.** An invoice can only be funded once. The second call to `fund_invoice()` on a Funded invoice returns `AlreadyFunded` immediately.

### File structure

```
contracts/invoice_liquidity/src/
├── lib.rs        — contract entry point, all public functions
├── invoice.rs    — Invoice struct, InvoiceStatus enum, storage helpers
├── errors.rs     — ContractError enum
└── tests.rs      — unit tests (native target only)
```

### Deployment

The contract is compiled to `.wasm` and deployed to Stellar's network via the Stellar CLI:

```bash
# Build
cargo build --target wasm32v1-none --release

# Deploy to testnet
stellar contract deploy \
  --wasm target/wasm32v1-none/release/invoice_liquidity.wasm \
  --source alice \
  --network testnet
```

Testnet contract ID: `CD3TE3IAHM737P236XZL2OYU275ZKD6MN7YH7PYYAXYIGEH55OPEWYJC`

There is one contract instance per network. All invoices across all users are stored within that single contract's persistent storage, keyed by invoice ID.

### Known limitations (v1)

**Default risk is unmitigated.** If a payer defaults, the LP loses the principal they advanced to the freelancer. There is no insurance pool, no credit scoring, and no collateral requirement. LPs should assess payer quality manually.

**Payer verification is on-chain only.** `mark_paid()` requires the registered payer address to sign the transaction. There is no mechanism to verify that the on-chain payer address corresponds to the real-world client. Invoice submission is currently trust-based between freelancer and payer.

**No dispute mechanism.** If a freelancer submits a fraudulent invoice, the LP has no on-chain recourse beyond `claim_default()` after the due date. Dispute resolution is out of scope for v1.

**Single asset.** Only USDC is supported. Multi-asset support is on the roadmap.
