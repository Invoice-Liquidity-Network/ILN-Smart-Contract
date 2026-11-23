# Claim Prioritization — Tie-Breaking, Stale Claims & Repeated Selection (Issue #1197)

Audit and regression record for `contracts/insurance_pool/src/claim_prioritization.rs`
— the pure, deterministic allocator that decides **how a constrained pool
balance is split between many simultaneous claims** (Issue #825 threat G3:
pool drainage / insolvency).

Behaviour-descriptive: every claim below is backed by an executable test in
the inline `mod tests`, or labelled as residual risk (RR-*). No vulnerability
is asserted unless verified (VF-*).

---

## 1. Scope and non-goals

**In scope**

* Strategy ordering (`ProRata`, `RiskWeighted`, `FIFO`).
* Tie-breaking when two claims have equal sort keys.
* Stale / old claims — whether they expire or are deprioritized.
* Repeated claim selection — duplicate `(lp, invoice_id)` and one LP with
  several invoices.
* Failure behaviour of `calculate_payout` / `allocate_payouts` and the
  documented invariants P1–P3.

**Out of scope / non-goals**

* The on-chain `InsurancePool::claim` gate (idempotency, solvency circuit,
  review window, reserve availability) — see
  `docs/insurance-coverage-gate.md`. This allocator is **not** wired into that
  path yet (§8 VF-6, §9 RR-1).
* Premium pricing / risk multipliers applied before a claim exists.
* No API, storage-layout, event or error-code change.

---

## 2. The allocator model

Two public entry points, both in the `alloc` (heap) domain — no `Env`
storage is touched, so they are pure and unit-testable:

```text
calculate_payout(claim, strategy, pool_balance, total_pending_claims, total_lp_premiums)
    -> Result<i128, ClaimPrioritizationError>

allocate_payouts(claims: &[PendingClaim], strategy, pool_balance)
    -> Result<Vec<(Address, i128)>, ClaimPrioritizationError>
```

`allocate_payouts` sorts the claims by strategy, then walks them
**sequentially**, feeding the *remaining* balance into `calculate_payout` for
each claim and subtracting the awarded amount. This makes the result
**order-sensitive**: a claim's payout depends on how much earlier claims
already consumed.

### Payout formula

```text
base_payout = min(coverage_cap, remaining_balance)
ProRata      : base_payout * lp_total_premiums / total_lp_premiums
RiskWeighted : ProRata * 100 / (100 + lp_default_count)
FIFO         : base_payout
```

Result is clamped to `>= 0` (Invariant P1) and, per claim, never exceeds
`remaining_balance` (Invariant P2).

---

## 3. Priority ordering

| Strategy | Sort key | Direction | First served |
|----------|----------|-----------|--------------|
| `FIFO` | `claim_timestamp` | ascending | oldest claim |
| `ProRata` | `lp_total_premiums` | descending | largest premium |
| `RiskWeighted` | `lp_total_premiums` | descending | largest premium |

Pinned facts:

* **VF-1 — `ProRata`/`RiskWeighted` order by premium, not by outcome.** The
  name suggests a single proportional split, but because each claim draws
  from the shrinking remaining balance, the ordering is effectively
  *greedy-by-premium-share*. The highest-premium LP is paid first from the
  largest base and can starve smaller claims.
* **VF-2 — `RiskWeighted` ordering ignores the risk profile.** Default
  history only scales the per-claim multiplier; it never reorders claims. A
  high-premium, high-default LP is still served before a low-premium clean LP
  (`risk_weighted_ordering_ignores_risk_profile`).
* **VF-3 — Pro-rata does not fully distribute a constrained pool.** Integer
  truncation plus the shrinking base leave a remainder unallocated
  (`pro_rata_orders_by_descending_premiums` leaves 167 of 600 undistributed),
  even though every claim was processed.
* **Strategy discriminants are frozen** (`ProRata = 0`, `RiskWeighted = 1`,
  `FIFO = 2`) for storage/event compatibility
  (`strategy_discriminants_are_stable`).

---

## 4. Tie-breaking

Both sort calls use the **stable** `slice::sort_by_key` / `slice::sort_by`.
Therefore, when two claims share the same key, their **relative input order
is preserved** — the tie-break is the caller-supplied order of the `claims`
slice, not any field of the claim record.

Pinned facts:

* `FIFO` equal timestamps → first-in-input wins the constrained slot
  (`fifo_ties_break_on_input_order`).
* Reversing the input reverses the winner set
  (`fifo_tie_break_follows_reversed_input`) — proof the tie-break is input
  order, not e.g. address ordering.
* `ProRata` equal premiums → input order decides who is paid from the larger
  base first; payouts are strictly decreasing in input position
  (`pro_rata_ties_break_on_input_order`).

**Implication for callers (RR-2):** determinism (Invariant P3) is only
guaranteed *for a fixed input order*. A caller that builds the `claims` slice
from an unordered source (e.g. a storage map iteration) yields a
deterministic-but-arbitrary tie-break. Production callers should pass claims
in a stable, documented order.

---

## 5. Stale claims

The allocator takes **no `now` argument** and performs **no expiry check**.
`claim_timestamp` is used *only* as the `FIFO` sort key.

Pinned facts:

* A very old claim is neither rejected nor deprioritized; under `FIFO` it is
  paid *first* (`stale_claims_are_paid_first_and_never_expire`).
* A stale claim that consumes the whole reserve causes later claims to be
  omitted entirely — the allocator never zero-fills unpaid claims
  (same test).

**RR-3:** there is no on-chain staleness bound. If/integrated, a caller that
queues claims without expiring them could have an ancient claim hold priority
indefinitely. Bounding this is the caller's responsibility.

---

## 6. Repeated claim selection

The allocator performs **no de-duplication** and holds **no idempotency
state**.

Pinned facts:

* Two entries with the **same `(lp, invoice_id)`** are funded twice
  (`repeated_claims_are_not_deduplicated`).
* One LP with **two invoices** produces two allocations carrying the same
  `Address`; consumers must aggregate per LP
  (`one_lp_with_multiple_invoices_appears_once_per_claim`).

**VF-4 / RR-4:** the allocator is unaware of the contract's `Claimed(u64)`
idempotency marker (which lives in the `InsurancePool::claim` gate). Any
future wiring **must** filter already-claimed invoices *before* calling this
function; otherwise duplicate entries would double-pay.

---

## 7. Failure behaviour and invariants

| Input | Result |
|-------|--------|
| `pool_balance < 0` | `Err(InvalidPoolBalance)` |
| `claims` empty | `Ok(vec![])` (even with a positive balance) |
| `pool_balance == 0` | `Ok(vec![])` — loop breaks before any allocation |
| `coverage_cap <= 0` | payout `0`, omitted from allocations |
| `total_lp_premiums <= 0` (pro-rata) | payout `0` |
| `lp_default_count == -100` (risk-weighted) | **panics** — `saturating_div(0)` |

Invariants asserted by the suite:

| ID | Invariant |
|----|-----------|
| **P1** | Every payout is `>= 0`; the final result is clamped with `.max(0)`. |
| **P2** | Sum of all allocations `<= pool_balance`; no claim is paid more than the remaining balance. |
| **P3** | Allocation is deterministic for identical input (and input order). |
| **P4 (new)** | An allocation is emitted iff its computed payout is `> 0`; unpaid claims are absent (not zero-valued). |
| **P5 (new)** | Winner selection under a constrained pool is determined by the strategy sort and — on ties — by input order. |
| **P6 (new)** | The allocator is stateless and performs no de-duplication or idempotency checks. |

---

## 8. Verified findings

| ID | Finding | Evidence |
|----|---------|----------|
| **VF-1** | `ProRata`/`RiskWeighted` are greedy-by-premium, not a whole-set proportional split; order changes payouts and a high-premium LP can starve smaller claims. | `pro_rata_orders_by_descending_premiums` |
| **VF-2** | `RiskWeighted` orders by premium, not risk; risk only scales the payout. | `risk_weighted_ordering_ignores_risk_profile` |
| **VF-3** | A constrained pool is not fully distributed (integer truncation + shrinking base). | `pro_rata_orders_by_descending_premiums` (167 left over) |
| **VF-4** | No de-duplication: duplicate `(lp, invoice_id)` and multi-invoice LPs are each allocated independently. | `repeated_claims_are_not_deduplicated`, `one_lp_with_multiple_invoices_appears_once_per_claim` |
| **VF-5** | Tie-break is the caller-supplied input order (stable sort); reversing input reverses winners. | `fifo_tie_break_follows_reversed_input`, `pro_rata_ties_break_on_input_order` |
| **VF-6** | `total_pending_claims` is accepted but never read — dead parameter. | `total_pending_claims_argument_does_not_affect_payout` |
| **VF-7** | Negative `lp_default_count` *inflates* the risk-weighted payout (divisor `100 + count`). | `negative_default_count_inflates_risk_weighted_payout` |
| **VF-8** | `ClaimPrioritizationError::PayoutOverflow` and `NoClaimsToPrioritize` are declared but never returned. | code inspection (`claim_prioritization.rs` §errors) |
| **VF-9** | This module is declared in `lib.rs` but **not called** by `InsurancePool::claim`; the live claim path is single-claim `min(coverage, available)`. | `grep` across `insurance_pool` |

---

## 9. Residual risks

| ID | Risk | Mitigation status |
|----|------|-------------------|
| **RR-1** | The allocator is unintegrated (VF-9): behaviour here does not affect live payouts yet. | Design-forward stub (Issue #825); wiring is separate work. |
| **RR-2** | Determinism holds only for a fixed input order; an unordered caller produces an arbitrary-confirmable tie-break. | Callers must build `claims` in a documented order; not enforced in code. |
| **RR-3** | No staleness bound on `claim_timestamp` (§5). | Caller responsibility; the contract gate's own guards apply once wired. |
| **RR-4** | No de-duplication / idempotency (VF-4); wiring must filter already-claimed invoices. | The contract's `Claimed` marker covers this *only if* the caller honours it. |
| **RR-5** | `lp_default_count` is unvalidated: a negative value inflates payouts (VF-7) and `-100` panics (divide by zero). | The field originates from an on-chain monotonic default counter (`>= 0`); treated as an internal invariant, not validated in this pure fn. |
| **RR-6** | `ProRata` under-distribution (VF-3) leaves reserve idle during a shortage. | Acceptable conservative bias for a default-insurance pool (favours solvency); documented, not "fixed". |

---

## 10. Test mapping

All tests live in the inline `mod tests` of
`contracts/insurance_pool/src/claim_prioritization.rs` (existing tests for
P1/P2, pro-rata and FIFO are retained).

| Area | Tests |
|------|-------|
| Encoding | `strategy_discriminants_are_stable` |
| Priority ordering | `fifo_orders_by_timestamp_ascending_regardless_of_input`, `pro_rata_orders_by_descending_premiums`, `risk_weighted_ordering_ignores_risk_profile` |
| Ties | `fifo_ties_break_on_input_order`, `fifo_tie_break_follows_reversed_input`, `pro_rata_ties_break_on_input_order` |
| Stale claims | `stale_claims_are_paid_first_and_never_expire` |
| Repeated selection | `repeated_claims_are_not_deduplicated`, `one_lp_with_multiple_invoices_appears_once_per_claim` |
| Bounds / failure | `zero_pool_balance_funds_nothing_and_negative_is_rejected`, `empty_claim_set_returns_empty_allocations`, `fifo_payout_is_bounded_by_coverage_cap_and_reserve` |
| Risk-weight edge | `negative_default_count_inflates_risk_weighted_payout`, `risk_weighted_panics_when_default_count_cancels_the_divisor` |
| Determinism / dead param | `allocation_is_deterministic_for_identical_input`, `total_pending_claims_argument_does_not_affect_payout` |

---

## 11. Compatibility

* **API:** unchanged — only test-only code and this document are added.
* **Storage layout:** unchanged — no `DataKey` / struct change.
* **Events / error codes:** unchanged — the same `ClaimPrioritizationError`
  variants are asserted.
* **Production code:** no change; `calculate_payout` / `allocate_payouts`
  behaviour is untouched.
