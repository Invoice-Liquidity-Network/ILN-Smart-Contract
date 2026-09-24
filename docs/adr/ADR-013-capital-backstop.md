# ADR-013: Insurance Pool Capital Backstop

**Date:** 2026-09-23
**Status:** Accepted

## Context

The insurance pool's solvency analysis ([threat-model G3](threat-model.md#g3-pool-drainage--insolvency-risk))
identified that the pool has no capital buffer beyond the liquid premium
balance: "the pool has no reinsurance mechanism (no capital backstop)". If the
default rate exceeds projections, claims are paid first-come-first-served
until the balance is exhausted and later claims get nothing. Issue #827 asks
to evaluate backstop options and implement the chosen mechanism.

The risk being addressed: the pool is funded only by LP premiums, which are
priced (in the stub) as a flat/risk) schedule that may not match realized
defaults. A sudden default wave can drain the pool before all covered LPs are
compensated.

## Decision

Implement a **protocol-owned capital backstop**: a second accounting balance
on the insurance pool (`DataKey::BackstopBalance`), separate from the liquid
claim `Balance`, drawn on only **after** the liquid balance:

- **Funding sources:**
  - `top_up_backstop(from, amount)` — an explicit, admin-authorised real
    token transfer from a funding source (e.g. the protocol treasury or DAO)
    into the backstop balance.
  - `set_backstop_funding_bps(bps)` — an optional governance-configured share
    of every premium deposit automatically diverted to the backstop
    (`amount * bps / 10_000`). Default `0` = disabled.
- **Payout order:** `claim()` computes
  `available = liquid_balance + backstop`, pays `min(tiered_coverage, available)`,
  drawing from the liquid balance first and the backstop second. The claim
  event remains the total payout; the internal split is visible via
  `get_backstop_balance()`.
- **Views:** `get_backstop_balance()`, `get_backstop_funding_bps()`,
  `get_total_reserve()` (liquid + backstop). The reserve ratio view used by the
  solvency breaker (`get_reserve_ratio_bps`) counts the backstop as part of the
  reserve, so a backstop top-up improves the ratio alongside deposits.

The backstop is **accounting, like the liquid balance** — the pool contract
custodies the whole token balance; the split is a bookkeeping boundary giving
governance a place to park dedicated solvency capital that is not exposed to
regular premium payout flow until the liquid balance is gone.

## Alternatives Considered

| Alternative | Why rejected |
|-------------|--------------|
| **External reinsurance (off-chain insurer)** | Strong long-term option, but requires legal/counterparty due diligence, an off-chain contract, and settlement plumbing that cannot be shipped in-contract now. Documented as future work. Providing the on-chain backstop balance first gives the pool a mechanism that exists regardless of counterparty negotiations. |
| **Explicit no-backstop (rely on breaker only)** | The solvency circuit breaker (Issue #826) pauses payouts under a thin reserve, which protects remaining LPs but does nothing for the pool's *ability to pay* — a backstop directly adds claim capacity. Keeping the two orthogonal (breaker = policy guard, backstop = capital) was judged strictly better. |
| **Automatic backstop funding at a fixed share (non-configurable)** | A hard-coded fee share would change deposit behavior for every pool from day one and could surprise LPs. Making it governance-configurable with a `0` default keeps existing behavior backward-compatible while letting each deployment opt in. |

## Consequences

**Positive:**
- Adds a real capital buffer beyond premiums, directly addressing G3's "no
  capital backstop" finding.
- Governance-configurable and **opt-in** — pools that never arm `BackstopFundingBps`
  or call `top_up_backstop` behave exactly as before (backward compatible).
- The backstop participates in the reserve ratio, so it interacts with the
  solvency breaker (Issue #826) coherently: funding the backstop can pull a
  tripped pool back above its minimum ratio before governance resets it.
- No change to `InsurancePoolInterface` / `INSURANCE_INTERFACE_VERSION = 1`,
  so `invoice_liquidity` integration and its pinned-version tests are unaffected.

**Negative / Trade-offs:**
- Backstop capital is held by the pool contract and only spendable via claims
  (liquid-first); it is not LP-exitable, so it's meant to be protocol/DAO
  capital rather than a user deposit product.
- Backstop capacity is bounded by what governance seeds it with — it
  mitigates, not eliminates, insolvency risk.
- Custody is unchanged (real token transfers in/out), so a backstop top-up
  requires the funding address to hold the underlying token.

## Follow-up (future)

- External reinsurance / DAO-treasury reserve establishment as the backstop's
  institutional funding source.
- Optional use of backstop interest/yield accrual for pool sustainability.