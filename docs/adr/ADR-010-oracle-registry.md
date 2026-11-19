# ADR-010: Governance-Controlled Oracle Registry

**Date:** 2026-07-27
**Status:** Accepted

## Context

`invoice_liquidity` had a single `Config.price_oracle: Option<Address>` field,
set via `set_price_oracle` (admin-only) and consulted in `fund_invoice` for
payer identity/creditworthiness verification (`get_payer_data`). This doesn't
scale for a protocol that wants:

- **Multiple kinds of oracle data** — price feeds (for future USD
  normalisation), identity verification (the existing use case), and credit
  scoring are conceptually different feeds, but the old design only had room
  for one oracle address, total.
- **Different oracle providers per token** — a USDC price feed and an XLM
  price feed are different contracts; a single `price_oracle` field can't
  represent "use oracle A for token X, oracle B for token Y."
- **Health observability** — there was no way to ask "is the currently
  configured oracle actually healthy?" independent of triggering (and
  potentially reverting) a real funding operation.

Governance already controls `invoice_liquidity`'s admin-gated setters via a
cross-contract call pattern established by `update_fee_rate` / `add_token` /
`set_price_oracle` etc: `iln_governance`'s `execute_proposal` invokes these
functions on the ILN contract, whose stored `Admin` address is set to the
governance contract's own address in production, so `require_admin`'s
`admin.require_auth()` auto-authorizes (a contract authorizing its own
outgoing call).

## Decision

Add an `OracleFeedType` enum (`Price`, `Identity`, `Credit`) and a registry
resolved in priority order (see `oracle_registry::resolve_oracle`):

1. **Per-token override** — `TokenOracle(feed_type, token) -> Address`,
   registered via `register_token_oracle` / cleared via
   `remove_token_oracle`.
2. **Feed-type-wide default** — `OracleRegistry(feed_type) -> Address`,
   registered via `register_oracle` / cleared via `remove_oracle`.
3. **Legacy fallback (Identity only)** — the pre-existing
   `Config.price_oracle` field, so contracts/tests that only ever called
   `set_price_oracle` keep working unmodified.

All four registry mutators are `require_admin`-gated, matching the existing
governance-controlled-setter pattern — no new authorization mechanism was
introduced.

`fund_invoice`'s oracle check now resolves through this registry for the
`Identity` feed (keyed by the invoice's token) instead of reading
`Config.price_oracle` directly, so per-token overrides apply automatically
to existing funding flows without any caller-visible change when no
override is configured.

**Health monitoring** is split into two entrypoints because of a Soroban
invocation semantics constraint (see below):

- `fund_invoice` opportunistically records a health snapshot
  (`OracleHealth(feed_type, token) -> OracleHealthStatus`) right before its
  own staleness check, so a *successful* funding call also updates health
  for free.
- `check_oracle_health(feed_type, token, payer)` is a dedicated,
  **never-erroring** entrypoint that queries the resolved oracle for
  `payer`'s record and always records + returns the result, whether the
  data is stale or not. This is the entrypoint off-chain monitors/keepers
  should poll to track oracle staleness over time.

### Why two entrypoints instead of one

Soroban rolls back **all** storage writes made during a contract invocation
that returns `Err` — there is no partial-commit / "write survives despite
the overall call failing" behavior (unlike, say, emitting an event before a
`require()` revert being observable off-chain in some VMs; here the whole
state delta is discarded). `fund_invoice` intentionally returns
`ContractError::OracleDataStale` when data is too old (Issue #93) and must
keep doing so — that's the correct behavior for the funding path. But it
means a health snapshot written just before that `Err` return would be
silently discarded along with everything else in the same invocation. A
health-tracking system that only updates on already-successful funding
calls would never observe (or count) staleness incidents. `check_oracle_health`
solves this by being a call that itself never returns `Err` — it just
reports whatever it observes — so its write always survives, and a
keeper can call it purely to monitor, without needing (or risking) an
actual funding side effect.

There is no on-chain concept of network "response time" (everything
resolves within one transaction), so "oracle health" here specifically
means **data staleness**: how many ledgers old the oracle's returned
timestamp is relative to the max age threshold, plus a
`consecutive_stale_count` that accumulates across repeated stale
observations and resets on a fresh one.

## Alternatives Considered

| Alternative | Why rejected |
|-------------|--------------|
| **Single oracle address per feed type only, no per-token override** | Doesn't satisfy "different oracle providers per token" from the issue — a USDC price feed and an XLM price feed are genuinely different contracts. |
| **Map<OracleFeedType, Address> as one storage value instead of per-key storage entries** | Every registry mutation would need to read-modify-write the whole map, and the codebase's established convention (`Proposal(u64)`, `HasVoted(u64, Address)`, etc.) is per-key storage entries — kept consistent with that. |
| **Record health inside `fund_invoice` only, no `check_oracle_health`** | Cannot observe staleness incidents at all, since the write reverts along with the `OracleDataStale` error — the exact scenario health monitoring exists to catch would be invisible. |
| **Make `fund_invoice` succeed on stale data now that health is tracked** | Changes Issue #93's existing, deliberate behavior (reject stale data) for a reason unrelated to this issue. Out of scope and a regression risk. |
| **Drop the legacy `price_oracle` fallback** | Would silently break every existing deployment/test that only ever called `set_price_oracle` and never touched the new registry. |

## Consequences

**Positive:**
- Governance can register distinct oracles per feed type and per token
  without any new authorization mechanism.
- Existing `set_price_oracle`-only configurations keep working via the
  fallback — no forced migration.
- `check_oracle_health` gives keepers/monitors a reliable, side-effect-free
  way to track staleness trends (`consecutive_stale_count`) even for
  oracles that are currently failing every funding attempt.

**Negative / Trade-offs:**
- Health recorded via `fund_invoice`'s opportunistic path and health
  recorded via `check_oracle_health` can diverge if a keeper never polls
  and funding never succeeds — `get_oracle_health` reflects whichever path
  last wrote successfully, not necessarily the most recent *attempt*.
- The `Price` and `Credit` feed types have no legacy fallback (only
  `Identity` does, since that's the only feed that existed pre-#532) — a
  contract relying on `Price`/`Credit` must register a registry entry
  explicitly; there's no field to fall back to.
- Per-token overrides are stored in persistent storage (unbounded by
  token count) rather than instance storage; a protocol with very many
  tokens each needing a distinct oracle would accumulate persistent
  entries proportional to registrations, though this mirrors how
  `TokenDecimals(Address)` and `ApprovedToken(Address)` already scale.
