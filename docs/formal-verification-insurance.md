# Formal Verification Specification — Insurance Pool Solvency

## 1. Overview

This document defines the economic (solvency) invariants for the
default-protection insurance pool and describes how each is verified.
It complements [`docs/formal-verification.md`](formal-verification.md) (invoice
lifecycle) and [`docs/insurance-pool-design.md`](insurance-pool-design.md)
(interface, tiered coverage, and cross-contract integration).

**Target Contract:** `contracts/insurance_pool/src/lib.rs`

Unlike the invoice lifecycle spec, these invariants are economic rather than
state-machine properties: they must hold for *any* sequence of
`deposit_premium` / `claim` calls, not just a fixed set of scripted scenarios.
Sections 2–4 below are each backed by a `proptest`-based property test in
`contracts/insurance_pool/src/test.rs` (module `proptest_invariants`) that
runs randomized operation sequences and asserts the invariant after every
step, in addition to the existing fixed-scenario unit tests.

---

## 2. Invariant S1 — Pool balance is never negative

**Property:** `pool_balance >= 0` holds at every point in the pool's
lifetime, for any sequence of `deposit_premium` / `claim` calls.

**Enforcement:**

- `deposit_premium` (`lib.rs`) only ever adds to `Balance` via checked
  addition (`checked_add`, panicking on overflow rather than wrapping).
- `claim` (`lib.rs`) computes `payout = min(tiered_coverage, balance)` and
  then sets `Balance` to `balance - payout`. Since `payout <= balance` by
  construction, `balance - payout >= 0` always.
- `claim` additionally rejects outright (`PoolEmpty`) when `balance <= 0`,
  so a claim can never even be attempted against a non-positive balance.

**Property test:** `prop_pool_balance_never_negative` — a randomized
sequence of deposits (random LPs, random positive amounts) and claims
(random invoice ids, claiming against enrolled LPs) asserts
`get_pool_balance() >= 0` after every single operation.

---

## 3. Invariant S2 — Claims never exceed cumulative deposits

**Property:** At every point in the pool's lifetime,
`sum(claims_paid) <= sum(premiums_deposited)`.

This is a stronger, cumulative form of S1: it's not just that the *current*
balance can't go negative, it's that the pool can never have paid out more,
in total, than it has ever taken in — i.e. the pool cannot manufacture
value. Because `Balance` is defined as running deposits minus running
payouts, and S1 shows `Balance >= 0` always, S2 follows directly:
`sum(deposits) - sum(payouts) = Balance >= 0` implies
`sum(payouts) <= sum(deposits)`.

**Property test:** `prop_claims_never_exceed_deposits` — tracks
`sum(premiums_deposited)` and `sum(claims_paid)` in the test harness
alongside a randomized deposit/claim sequence and asserts
`total_claimed <= total_deposited` after every operation, independent of
(and as a cross-check against) the contract's own `Balance` accounting.

---

## 4. Invariant S3 — `claim()` is idempotent per invoice

**Property:** For a given `invoice_id`, at most one successful `claim()`
call ever pays out. A second `claim()` for the same `invoice_id` fails with
`AlreadyClaimed` and moves no additional funds, regardless of pool balance
or LP.

**Enforcement:** `claim()` checks `is_claimed(invoice_id)` up front and
panics with `InsuranceError::AlreadyClaimed` before touching `Balance` or
attempting a transfer; `Claimed(invoice_id)` is set to `true` before the
external token transfer (checks-effects-interactions).

**Verified by:**
- `claim_is_idempotent_per_invoice` (existing fixed-scenario unit test in
  `test.rs`) — a direct regression test for the two-call-same-invoice case.
- `prop_claim_idempotent_per_invoice` — a property test that, for a
  randomized number of repeated `claim()` attempts (2–10) against the same
  `invoice_id`, asserts exactly one succeeds and the pool balance decreases
  by exactly one payout's worth, no matter how many additional attempts
  follow.

---

## 5. Residual risks (not guaranteed by the code today)

Per the requirement to document invariants the implementation does *not*
currently guarantee:

- **No protocol-level cap on aggregate enrolled coverage vs. pool
  capacity.** Tier *eligibility* (`get_tiered_coverage`) is a function of an
  LP's own premiums paid, not of remaining pool solvency, so the pool can
  nominally "owe" more in aggregate tiered coverage than it holds. This is a
  known, intentional trade-off — see
  [`docs/insurance-pool-design.md` § Aggregate exposure invariant (Issue
  #662)](insurance-pool-design.md#aggregate-exposure-invariant-issue-662)
  for the chosen pro-rata policy and the stress test that verifies graceful
  degradation rather than panics or incorrect payouts.
- **No global reserve ratio.** There is no enforced minimum
  `pool_balance / enrolled_exposure` ratio; a governance-set `BalanceCap`
  bounds how large the pool can grow, but nothing bounds how many LPs can
  enroll against a small balance.
- **Premium accounting is per-pool, not per-invoice.** `sum(claims_paid) <=
  sum(premiums_deposited)` (S2) holds pool-wide, not per-LP — a heavy
  claimant can be compensated using premiums another LP deposited. This is
  the intended pooled-risk design (see `docs/insurance-pool-design.md`), not
  a bug, but it means no LP is entitled to "their own" premiums back.

---

## 6. Coverage

| Property | Verified by |
|---|---|
| S1 — balance never negative | `prop_pool_balance_never_negative` |
| S2 — claims never exceed deposits | `prop_claims_never_exceed_deposits` |
| S3 — claim idempotency per invoice | `claim_is_idempotent_per_invoice`, `prop_claim_idempotent_per_invoice` |
| Tiered coverage boundaries | see `docs/insurance-pool-design.md` § Tiered coverage boundaries |
| Aggregate exposure vs. pool capacity | see `docs/insurance-pool-design.md` § Aggregate exposure invariant (Issue #662) |
