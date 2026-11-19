# ADR-014: Per-Pair Default Tracking for Collusion Detection

**Date:** 2026-09-23
**Status:** Accepted

## Context

The insurance pool's fraud/moral-hazard analysis ([threat-model G2](threat-model.md#g2-claim-fraud--moral-hazard))
flagged a specific undetectable pattern: *repeated small defaults by the same
payer pair*. Today the pool tracks per-LP default counts
(`DefaultCount(lp)` from Issue #528) and a pool-wide rollup
(`TotalDefaultCount`) — enough to assess an *individual LP's* risk, but a
colluding LP and payer could repeatedly default small invoices without any
signal, because nothing correlates defaults *across an (LP, payer) pair*.

Issue #829 asks to track defaults per (LP, payer) pair on-chain, compute a
heuristic for concentration, and make the data queryable so an off-chain
monitoring/alerting service can act on it.

## Decision

Add per-pair default tracking and a lightweight on-chain concentration
heuristic to `contracts/insurance_pool`:

- **Data:** `PairDefaultCount(lp, payer)` — a running counter of confirmed
  defaults keyed by both the funding LP and the defaulting payer.
- **Write path:** `record_pair_default(lp, payer)` (admin-only, matching
  `increment_default_count`'s auth). It increments the pair counter *and*
  delegates to the existing `increment_default_count` so the per-LP and
  pool-wide rollups from Issue #528 stay in sync from a single call — no
  double bookkeeping.
- **Read path:** `get_pair_default_count(lp, payer)` returns the raw count;
  `get_pair_collusion_flag(lp, payer)` applies the documented heuristic
  on-chain.
- **Heuristic:** flag a pair when
  `pair_default_count >= MIN_PAIR_DEFAULTS_TO_FLAG` (3) **and** the pair's
  defaults are at least `COLLUSION_PAIR_SHARE_FLAG_BPS` (50%) of the LP's
  total defaults. Both constants are module-level `pub const`s so off-chain
  monitors and future governance tuning can reference them.
- **Event:** `PairDefaultRecorded { lp, payer, pair_count }` is emitted on
  every pair default, giving indexers a stream to consume.

Design intent: **raw, simple on-chain data; computed judgment off-chain.**
The pair counter is deliberately stored without any pre-aggregation so any
future detector (time-windowed rate, address clustering, cross-LP payer
fan-out) can be built from the same primitive. The heuristic flag is a cheap
view for monitoring, not an enforcement gate — defaults are not rejected
automatically, because rejecting by concentration would be a heuristic
judgment call best left to human/DAO review with the flag as evidence.

## Alternatives Considered

| Alternative | Why rejected |
|-------------|--------------|
| **Off-chain only (index defaults from events, no on-chain pair state)** | Workable for alerts, but loses the source of truth on-chain: the flag and raw counts become un-auditable, and any actor (including the pool itself) can't query pair history without their own indexer. Keeping raw counts on-chain makes the *data* trustless while still computing judgment off-chain. |
| **Heuristic as an automatic enforcement gate (reject future claims for flagged pairs)** | Auto-rejecting a claim because historical defaults concentrate would create a false-positive trap for a legitimately active payer, and introduces an admin (un)flagging loop. Keeping the heuristic informational preserves the pool's admin-gated claim flow (which already requires a confirmed default) while surfacing the signal. |
| **Protocol-average baseline on-chain (compare pair rate vs global rate in-contract)** | More elaborate math in-contract for marginal value; the protocol-wide default rate is already observable off-chain and the same raw per-pair data supports it. Kept out to avoid over-fitting the heuristic in contract code. |

## Consequences

**Positive:**
- Directly closes G2's "repeated small defaults by same payer pair may not be
  detected" gap with queryable on-chain data.
- Single write path keeps Issue #528 rollups consistent without drift.
- Backward compatible: `InsurancePoolInterface` and
  `INSURANCE_INTERFACE_VERSION = 1` are unchanged; all new methods live on the
  full `InsurancePoolClient`.
- Purely additive for existing pools — no storage migration, no behavior
  change until `record_pair_default` is called.

**Negative / Trade-offs:**
- The heuristic is a coarse signal (threshold + concentration). A payer who is
  simply a frequent business partner of one LP can accumulate pair defaults
  without fraud; the flag is guidance, not proof.
- `record_pair_default` is an **extra admin-invoked call**; the pool itself
  does not learn the payer from `claim(invoice_id)` (claims carry only the LP),
  so the liquidity contract must pass both addresses when reporting a default.
- Per-pair state grows linearly with distinct (LP, payer) pairs — acceptable
  for the pool's scale, but noted for Soroban storage cost budgeting.

## Follow-up (future)

- Wire `record_pair_default` into `invoice_liquidity`'s default path where the
  payer is known, so pair tracking is automatic rather than a separate call.
- Off-chain alerting on `PairDefaultRecorded`/`get_pair_collusion_flag`,
  e.g. flag recently-enrolled LPs first flagged by the heuristic.