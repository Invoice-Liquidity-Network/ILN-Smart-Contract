# Insurance Coverage Gate — Edge Cases & Invariants (Issue #1196)

Audit and regression record for the **coverage gate** of the
`insurance_pool` contract (`contracts/insurance_pool/src/lib.rs`): the set of
conditions that decide *whether* a default claim pays out, and *how much* it
pays.

This document is deliberately behaviour-descriptive. Every claim below is
either backed by an executable test in
`contracts/insurance_pool/src/tests_coverage_gate.rs`, or explicitly labelled
as residual risk (RR-*). No vulnerability is asserted unless it is verified
(VF-*).

---

## 1. Scope and non-goals

**In scope**

* Tier selection thresholds used to derive an LP's payout cap
  (`get_tiered_coverage`).
* The payout formula and reserve bounds in `claim`.
* Gate ordering inside `claim` (idempotency → solvency → review → reserve).
* Solvency circuit breaker state machine (trip / sticky / reset).
* Review-window + evidence gate timing semantics.
* Deposit / enrollment / backstop behaviour while a gate is closed.
* Balance-cap enforcement and its rollback behaviour.

**Out of scope / non-goals**

* Premium pricing (base rate, risk multipliers, reputation read) — covered by
  the existing `test` suite and `docs/premium-rate-validation.md`.
* Cross-contract integration from `invoice_liquidity` (its own `claim` call
  site) — tracked separately.
* No API, storage-layout, event or error-code change is made by this issue.

Target crate: `contracts/insurance_pool`. (The issue text named
`contracts/invoice_liquidity/src/tests_coverage_gate.rs`, but that file
contains only generic invoice-liquidity coverage tests and no insurance
logic; the actual gate lives in `insurance_pool`, which is where this work is
scoped.)

---

## 2. Gate inventory and call order

`claim(invoice_id, lp)` evaluates gates in this fixed order, before any
storage write:

| # | Gate | Check | Error | Notes |
|---|------|-------|-------|-------|
| 0 | Auth | `require_admin` — only the configured admin (the liquidity contract in production) may report a default | `NotInitialized` if unset | Not LP-gated: the *caller* is the gate |
| 1 | Idempotency | `Claimed(invoice_id)` absent | `AlreadyClaimed` | Checked first, so a replay reports this even when other gates are closed |
| 2 | Solvency | Breaker flag clear (`gate_solvency_circuit`) | `SolvencyCircuitOpen` | Sticky; only admin reset clears |
| 3 | Review | Window disabled, **or** evidence present **and** window elapsed (`enforce_claim_review_gate`) | `EvidenceRequired` / `ReviewWindowNotElapsed` | Runs before reserve is inspected |
| 4 | Availability | `balance + backstop > 0` | `PoolEmpty` | Reserve, not entitlement, decides payout |
| 5 | Payout | `min(tiered_coverage, available)`, drawn liquid-first then backstop | — | `trip_circuit_if_breached` runs last, before returning `Ok` |

Ordering facts pinned by tests:

* `AlreadyClaimed` outranks the solvency *and* review gates
  (`claim_gate_precedence_is_claimed_then_solvency_then_review`).
* `SolvencyCircuitOpen` outranks the review gate for a fresh invoice (same
  test).
* `EvidenceRequired` outranks `PoolEmpty`
  (`review_gate_precedes_pool_availability_check`).

---

## 3. Tier thresholds (`get_tiered_coverage`)

Tiers are derived from `premiums_paid` against fractions of the coverage cap
`C`:

| Condition (`premiums_paid` vs `C`) | Coverage granted |
|------------------------------------|------------------|
| `>= C/2` | `C * 150 / 100` (150%) |
| `>= C/4` | `C` (100%) |
| `>= C/10` | `C * 75 / 100` (75%) |
| otherwise | `C * 50 / 100` (50%) |

Semantics pinned:

* Comparisons are `>=`, so a value *equal* to a threshold belongs to the tier
  **above** it (`exact_threshold_values_select_the_upper_tier`).
* A zero-premium address resolves to the base 50% tier at normal coverage
  (`zero_premium_lp_defaults_to_base_tier_at_normal_coverage`). There is no
  enrollment precondition in the tier math.
* **Truncation edge (VF-1):** when `C < 10`, integer division collapses one
  or more thresholds to `0`, so the `>= 0` arms short-circuit and a
  zero-premium LP can be placed in a *higher* tier than the base one. At
  `C == 10` behaviour is normal; at `C == 9` a zero-premium LP gets 75%; at
  `C == 3`, 100%; at `C == 1`, 150%. Pinned by
  `tier_thresholds_collapse_below_ten_stroops`. Operationally irrelevant
  (see RR-1).

---

## 4. Payout and reserve bounds

`available = liquid_balance + backstop_balance`; `payout = min(tier, available)`.
The paid amount is drawn from the liquid balance first, then the backstop.
Pinned by:

* `payout_is_minimum_of_tier_cap_and_available_reserve` — `tier < reserve`
  (capped by tier), `tier == reserve` (equals both), then no reserve
  (`PoolEmpty`).
* `payout_is_capped_by_available_reserve_when_tier_exceeds_it` — `tier >
  reserve` (floored to reserve).
* `claim_draws_from_backstop_when_liquid_balance_is_zero` — a backstop-only
  reserve funds the payout with the liquid balance left at 0.
* `claim_rejects_on_empty_pool_even_for_entitled_lp` — entitlement without
  availability is denied.

---

## 5. Solvency circuit breaker

* **Arming:** `set_min_reserve_ratio_bps(bps)` — `0..=10_000`; out of range →
  `InvalidReserveRatio`. Default `0` **disables** automatic tripping
  (`circuit_never_trips_while_min_reserve_ratio_is_zero`).
* **Ratio:** `reserve * 10_000 / coverage`, where `reserve = balance +
  backstop` and `coverage` is the flat cap.
* **Trip point:** evaluated *after* a successful payout
  (`trip_circuit_if_breached`). A write followed by a panic in the same
  invocation would be rolled back, so the tripping claim pays its boundary
  payout and the flag persists for *subsequent* claims.
* **Stickiness:** once open, funding/enrollment does **not** clear it; only
  `reset_solvency_circuit` (admin) does
  (`solvency_circuit_is_sticky_until_admin_reset`). Resetting an
  already-closed breaker is a safe no-op.
* **Manual override semantics:** a reset while the ratio is *still* below the
  threshold buys exactly one more payout, after which the breaker re-trips
  (`reset_below_threshold_allows_one_payout_then_re_trips`).

---

## 6. Review window and evidence

* **Enable/disable:** `set_review_window_seconds(seconds)`; `0` disables the
  gate and restores the automatic flow
  (`disabling_review_window_restores_automatic_payout_flow`).
* **Evidence:** `submit_claim_evidence(invoice_id, hash)` records
  `{hash, submitted_at}` **per invoice**; evidence for one invoice does not
  unlock another (`review_window_evidence_is_scoped_per_invoice`).
* **Timing semantics (VF-2 — "stale" config):** the gate reads the
  *current* window and the *stored* `submitted_at` on every claim. Therefore:
  * Raising the window after submission retroactively delays an
    already-submitted claim
    (`raising_review_window_after_evidence_submission_delays_payout`).
  * Lowering the window after submission lets the same evidence mature
    sooner (`lowering_review_window_after_evidence_submission_expedites_payout`).
* **Maturity overflow:** `submitted_at + window` is `checked_add` with a
  `u64::MAX` fallback, so an enormous window can never make a claim mature
  early; it makes it mature never (RR-2).

---

## 7. Denied funding / claims

* **While the breaker is open, funding continues:** `enroll` and
  `deposit_premium` succeed and grow the reserve; only `claim` is paused
  (`circuit_open_denies_claims_without_moving_state_but_allows_funding`).
* **A denied claim moves no state:** pool balance, the pool's token balance
  and the `Claimed` marker are untouched (same test).
* **Balance cap:** `set_balance_cap(cap)`; `0` clears it. The cap bounds the
  **liquid** balance only. A deposit whose liquid share would exceed the cap
  panics with `BalanceCapExceeded` and the entire invocation rolls back —
  including the earlier `Premiums` write
  (`balance_cap_rejection_rolls_back_all_state`).
* **Backstop is not bounded by the cap (VF-3):** with
  `backstop_funding_bps == 10_000` the entire premium is routed to the
  backstop, so the liquid balance (and therefore the cap check) never binds,
  regardless of deposit size. A partial split still enforces the cap on the
  liquid portion (`balance_cap_bounds_liquid_balance_only_not_backstop`).

---

## 8. Invariants

| ID | Invariant |
|----|-----------|
| **INV-CG1** | `payout = min(tiered_coverage(lp), balance + backstop)`; `payout >= 0`. |
| **INV-CG2** | A claim's gates are evaluated in the order declared in §2; the first failing gate's error is reported. |
| **INV-CG3** | `Claimed(invoice_id)` is set iff a payout for `invoice_id` succeeded; a second claim for the same invoice fails `AlreadyClaimed`. |
| **INV-CG4** | Reserve accounting is conserved: `balance` (and `backstop`) decrease by exactly the drawn amount, never below 0. |
| **INV-CG5** | The solvency flag is monotone-open within an epoch: once `true`, it stays `true` until an explicit admin `reset_solvency_circuit`. |
| **INV-CG6** | A review-window payout satisfies `now >= submitted_at + review_window_seconds`; missing evidence yields `EvidenceRequired`. |
| **INV-CG7** | A rejected `deposit_premium` (cap / non-positive / auth) leaves all state — `Balance`, `BackstopBalance`, `Premiums`, `Enrolled`, token balances — unchanged. |
| **INV-CG8** | Rejected claims (`AlreadyClaimed`, `SolvencyCircuitOpen`, `EvidenceRequired`, `ReviewWindowNotElapsed`, `PoolEmpty`) leave all state unchanged. |

---

## 9. Verified findings

| ID | Finding | Evidence |
|----|---------|----------|
| **VF-1** | Tier thresholds truncate below `C < 10`, so a zero-premium LP can land above the base tier. | `tier_thresholds_collapse_below_ten_stroops` |
| **VF-2** | Review-window config is re-read at claim time against the stored `submitted_at`; changing the window retroactively re-times pending claims. | `raising_…` / `lowering_…` tests |
| **VF-3** | The balance cap bounds only the liquid balance; backstop-routed premiums are unbounded by it. | `balance_cap_bounds_liquid_balance_only_not_backstop` |
| **VF-4** | `claim` is not gated on the claiming LP being enrolled or having paid a premium — the tier math has no enrollment precondition, and availability is the only economic check. Compensating control: `claim` requires **admin** auth, and in production the admin is the liquidity contract, which only files claims for LPs that actually funded the defaulted invoice. | `zero_premium_lp_defaults_to_base_tier_at_normal_coverage`, `claim_rejects_on_empty_pool_even_for_entitled_lp` |
| **VF-5** | The solvency breaker trips *after* a payout, not before: a tripping claim still pays its boundary amount; the breaker protects *subsequent* claims. | `solvency_circuit_is_sticky_until_admin_reset`, `reset_below_threshold_allows_one_payout_then_re_trips` |

---

## 10. Residual risks

| ID | Risk | Mitigation status |
|----|------|-------------------|
| **RR-1** | Tiny coverage caps (`C < 10`) produce threshold truncation (VF-1). | Not reachable under `insurance-pool-launch-parameters.md` (caps are ≥ 1e7 stroops). `initialize` and `set_coverage_via_governance` reject non-positive caps, so `C == 0` cannot occur; only unrealistically tiny positive caps are affected. |
| **RR-2** | An arbitrarily large `ReviewWindowSeconds` (up to `u64::MAX`) can indefinitely block claims for a given invoice until governance lowers the window. | Governance-controlled parameter; the value is emitted on `set_review_window_seconds` for off-chain monitoring. No bounded maximum is enforced on-chain. |
| **RR-3** | The balance cap does not constrain the backstop (VF-3); backstop growth is bounded only by the total premium inflow. | Backstop is protocol capital under admin/governance control and is intended to grow; documented rather than capped. |
| **RR-4** | `claim` is admin-gated rather than LP-gated (VF-4); correctness of "who may claim" depends on the integrated liquidity contract enforcing funder membership before calling. | Out of scope for the pool; the `invoice_liquidity` default path enforces the funder check (see `docs/default-appeal-authorization.md`). |

---

## 11. Test mapping

All tests live in `contracts/insurance_pool/src/tests_coverage_gate.rs`
(registered as `mod tests_coverage_gate;` in `lib.rs`).

| Area | Tests |
|------|-------|
| Tier thresholds | `zero_premium_lp_defaults_to_base_tier_at_normal_coverage`, `tier_thresholds_collapse_below_ten_stroops`, `exact_threshold_values_select_the_upper_tier` |
| Pool availability | `claim_rejects_on_empty_pool_even_for_entitled_lp`, `payout_is_minimum_of_tier_cap_and_available_reserve`, `payout_is_capped_by_available_reserve_when_tier_exceeds_it`, `claim_draws_from_backstop_when_liquid_balance_is_zero` |
| Gate precedence | `claim_gate_precedence_is_claimed_then_solvency_then_review`, `review_gate_precedes_pool_availability_check` |
| Stale state | `raising_review_window_after_evidence_submission_delays_payout`, `lowering_review_window_after_evidence_submission_expedites_payout`, `review_window_evidence_is_scoped_per_invoice`, `disabling_review_window_restores_automatic_payout_flow`, `solvency_circuit_is_sticky_until_admin_reset`, `circuit_never_trips_while_min_reserve_ratio_is_zero`, `reset_below_threshold_allows_one_payout_then_re_trips` |
| Denied funding / claims | `circuit_open_denies_claims_without_moving_state_but_allows_funding`, `balance_cap_rejection_rolls_back_all_state`, `balance_cap_bounds_liquid_balance_only_not_backstop` |

---

## 12. Compatibility

* **API:** unchanged. Only test-only code and this document are added.
* **Storage layout:** unchanged — no new `DataKey` variants.
* **Events / error codes:** unchanged — the same `InsuranceError` variants
  (`PoolEmpty`, `SolvencyCircuitOpen`, `EvidenceRequired`,
  `ReviewWindowNotElapsed`, `AlreadyClaimed`) are asserted.
* **Gas / resource envelope:** no production code path is modified.
