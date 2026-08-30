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

## Oracle Swap Semantics for In-Flight Invoices

**Explicit design decision:** replacing a registered oracle (`register_oracle`
/ `register_token_oracle` pointed at a new address — e.g. swapping in a
Reflector-style oracle's upgraded contract) applies **immediately and
retroactively** to every invoice already submitted, including one that has
already received partial funding. There is no grandfathering, no per-invoice
pinning of "the oracle that was current when this invoice was submitted," and
no transition window.

This isn't an accident of implementation to be fixed later — it's the direct
and correct consequence of two things already decided elsewhere in this ADR:

1. `require_oracle_verification` is a **per-call argument to `fund_invoice`**,
   not a field stored on `Invoice` at `submit_invoice` time. There is nothing
   on the invoice itself that could be "broken" by a swap, because the
   invoice never recorded which oracle (or even whether oracle verification)
   would apply — that choice is made fresh by whoever calls `fund_invoice`,
   for that specific call.
2. `resolve_oracle` reads the registry's **current** storage state on every
   call — it has no snapshot, cache, or invoice-scoped memory of a prior
   resolution. Two `fund_invoice` calls against the *same* invoice (e.g. two
   partial-funding tranches from the same or different LPs) can therefore
   resolve to two *different* oracle addresses if a swap happened in between,
   each call correctly reflecting whatever was registered at the moment it
   ran.

**Alternative considered and rejected:** snapshot the resolved oracle address
onto the `Invoice` struct the first time `fund_invoice` is called with
`require_oracle_verification=true`, so every subsequent funding call against
that invoice keeps using the same oracle even after a later swap. Rejected
because:
- It adds a new persisted field to every invoice for a feature most invoices
  never use (oracle verification is opt-in per call).
- It would mean a *known-compromised* oracle (see
  [oracle-attack-economics.md](../oracle-attack-economics.md)) keeps being
  trusted for every invoice that happened to touch it before removal —
  exactly backwards from the intent of being able to swap out a bad oracle.
- Nothing in the codebase's existing conventions snapshots *any* other
  governance-controlled parameter onto an invoice (fee rate, discount cap,
  etc. are also always read live) — a special case here would be
  inconsistent with the rest of the contract.

**Practical implication for operators:** a registered oracle can be swapped
mid-lifecycle, including while invoices are actively being funded against it,
without any special procedure or invoice-side migration — the very next
`fund_invoice` call simply resolves against whatever is registered at that
moment. See [oracle-integration.md](../oracle-integration.md#replacing-an-already-registered-oracle)
for the operational swap procedure, and
`contracts/invoice_liquidity/src/tests_oracle_registry.rs`'s
`test_oracle_swap_mid_lifecycle_*` tests for the behavior verified end-to-end.

## Oracle State Snapshotting for Disputes

**Explicit design decision:** the opposite of the swap semantics above
applies once a dispute is filed. `dispute_invoice()` calls
`oracle_registry::snapshot_oracle_state_for_dispute` and freezes the
result — the `Identity`-feed oracle's resolved address, its `is_verified`
answer and timestamp for this invoice's payer, whether that data was
already stale, and any cross-validated `Price`-feed reading for this
invoice's token — onto the `DisputeRecord` (`DisputeOracleSnapshot`,
`contracts/invoice_liquidity/src/invoice.rs`), exposed via
`get_dispute_details()`. Unlike oracle resolution for funding, **this value
never changes again after it's written**, no matter how the live oracle
moves before governance gets to `resolve_dispute`/`auto_resolve_dispute`.

**Rationale:** disputes reference an off-chain `reason_hash` — the actual
evidence discussion happens off-chain, in governance forums, over a period
that can span the full dispute-resolution timeline. Without a frozen
on-chain anchor, "what did the oracle say" is answerable only by whoever
happens to query it and when, with no guarantee two reviewers looking at
the same dispute on different days see the same answer, and no way to
prove after the fact what the oracle reported at the moment that actually
mattered (when the payer disputed). Freezing the snapshot at filing time
makes the oracle's state at that moment as immutable and independently
verifiable as the `reason_hash` it sits alongside.

**Why filing time, not resolution time:** the dispute is *about* the state
of the world when the payer decided to raise it — freezing at resolution
time would still leave a gap between "what the payer saw when they
disputed" and "what governance reviews," just moved to a different point,
and would make the snapshot dependent on whenever an admin happens to call
`resolve_dispute`, which is an arbitrary, ungoverned delay from the payer's
perspective.

**Never blocks filing:** `snapshot_oracle_state_for_dispute` uses
`try_invoke_contract` rather than the panicking `env.invoke_contract` that
`fund_invoice`/`check_oracle_health` use internally — a misbehaving or
unreachable oracle degrades every affected snapshot field to `None` rather
than aborting `dispute_invoice` itself. A payer's ability to file a dispute
must not depend on the oracle currently working; "the oracle was
unreachable at filing time" (an all-`None` identity snapshot despite
`identity_oracle_gated: true`) is itself meaningful evidence, not a reason
to fail the dispute.

**Not itself oracle-gated:** the snapshot is captured unconditionally,
regardless of whether the invoice's actual funding history ever used
`require_oracle_verification=true`. `identity_oracle_gated` records whether
an oracle is currently registered for this token, independent of whether
any particular funder chose to check it.

See `contracts/invoice_liquidity/src/tests_dispute_oracle_snapshot.rs` for
the behavior verified end-to-end, in particular
`test_dispute_snapshot_frozen_after_live_oracle_value_changes` and
`test_dispute_snapshot_includes_and_freezes_price_feed_reading`.
