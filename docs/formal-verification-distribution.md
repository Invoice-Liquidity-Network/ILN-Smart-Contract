# Formal Verification Specification — iln_distribution Reward Accounting

## 1. Overview

This document defines the reward-conservation invariant for `iln_distribution`
and describes how it's verified. It complements
[`docs/formal-verification.md`](formal-verification.md) (invoice lifecycle)
and [`docs/formal-verification-insurance.md`](formal-verification-insurance.md)
(insurance pool solvency).

**Target Contract:** `contracts/iln_distribution/src/lib.rs`

`iln_distribution` accrues governance-token rewards for LPs (proportional to
funded volume), freelancers, and payers (flat, per settlement) as the ILN
contract reports activity, then mints those rewards on demand via
`claim_tokens`. Reward *rates* (`set_lp_reward_rate`,
`set_freelancer_reward_rate`, `set_payer_reward_rate`) are governance-configurable
and can change at any point in a participant's lifecycle, including between
when volume/settlements accrue and when they're claimed.

---

## 2. Invariant D1 — Cumulative claims never exceed the high-water mark of earned rewards

**Property:** For any participant and any interleaving of `accrue_lp` /
`accrue_settlement` (accrual), `set_*_reward_rate` (rate updates), and
`claim_tokens` (claims), the total amount ever minted to that participant via
`claim_tokens` never exceeds the *highest* value `total_earned()` has ever
taken on up to that point — i.e. `claim_tokens` never mints value that wasn't
earned under *some* reward rate that was live at the time, no matter how many
times rates change mid-lifecycle. This is the "rewards are conserved — no
value created" property the source issue asks for, made precise.

Note this is a high-water-mark bound, not a *live* one: `total_earned()` is
recomputed from the *current* reward rate against cumulative historical
volume/settlement counts, not a rate frozen at accrual time, so a rate cut
can transiently drop the live `total_earned()` below an amount already
claimed under a higher earlier rate (see [Residual risks](#3-residual-risks-not-guaranteed-by-the-code-today)
below) — a genuine property test run against a naive "claimed <= live
total_earned" formulation of D1 reproduces this immediately (`SetPayerRate`
high, `AccrueSettlement`, `Claim`, `SetPayerRate(0)` — the claim is now larger
than the freshly-recomputed `total_earned`), which is what motivated stating
D1 against the high-water mark instead.

**Enforcement (`lib.rs::claim_tokens`):**
```rust
let total_earned = Self::total_earned(&env, &claimer);
let already_claimed = ...; // cumulative, persisted per claimer
let claimable = total_earned.saturating_sub(already_claimed);
if claimable <= 0 { return 0; }
// ... mint `claimable` ...
already_claimed = already_claimed.saturating_add(claimable); // == total_earned
```
Each call sets `already_claimed` to exactly `total_earned` at that moment
(via `already_claimed + claimable = already_claimed + (total_earned -
already_claimed) = total_earned`), so cumulative minted amount tracks
`total_earned` as a monotonically non-decreasing high-water mark and can
never exceed it.

**Property test:** `prop_cumulative_claims_never_exceed_earned` (in
`contracts/iln_distribution/src/lib.rs`, `mod test`) — a randomized sequence
of `accrue_lp`, `accrue_settlement`, rate updates, and `claim_tokens` calls
for a single participant asserts, after every operation, that the
participant's on-chain token balance (= cumulative minted) never exceeds
`get_accrual()` (`total_earned`) evaluated immediately afterward.

**Property test:** `prop_claimed_high_water_mark_is_monotonic` — the same
kind of randomized sequence asserts the *cumulative claimed* amount itself
never decreases across successive `claim_tokens` calls, even when an
intervening rate cut temporarily drops `total_earned` below what's already
been claimed (see Residual risk below) — a later rate increase or further
accrual must "catch up" past the existing high-water mark before any further
minting occurs, it can never mint negative or roll the mark backwards.

**Regression coverage (existing, fixed-scenario):**
`updated_rates_affect_reward_calculation` and
`update_reward_params_affects_lp_rewards` cover single, specific rate-change
sequences; the property tests above generalize this to arbitrary sequences
and interleavings.

---

## 3. Residual risks (not guaranteed by the code today)

- **Rewards are not frozen at accrual time.** `total_earned()` is computed
  live, from the *current* reward rate applied to *cumulative* historical
  volume/settlement counts — it does not snapshot the rate at the moment
  each unit of volume was accrued. A rate increase therefore retroactively
  re-prices any already-accrued-but-unclaimed volume upward (and a rate cut
  re-prices it downward) the next time `total_earned` is evaluated. This
  means the reward for a given unit of settled volume is **not** bounded by
  "the settlement amount times the rate in effect when it settled" — it's
  bounded only by "the settlement amount times whatever rate is in effect
  the next time someone claims." D1 still holds (claims never exceed the
  live `total_earned`), but the *live* total itself is not pinned to a
  historical rate.
- **No protocol-level ceiling on reward rates.** `set_lp_reward_rate` /
  `set_freelancer_reward_rate` / `set_payer_reward_rate` accept any `i128`
  (including values far larger than the volume they're applied to); nothing
  in `iln_distribution` bounds a reward rate relative to the settlement
  amounts it will be multiplied against. Governance/caller discipline (the
  `iln_contract` address, which gates every rate-setter via
  `require_governance_invoker`) is the only guard today.
- **A high-water mark that outruns a lowered rate stalls future claims,
  not just refunds a shortfall.** If `already_claimed` is pushed above a
  newly-lowered `total_earned` (per the rate-cut scenario above),
  `claimable` (`total_earned.saturating_sub(already_claimed)`) stays `0`
  until fresh accrual or a rate increase pushes `total_earned` back past the
  existing mark — the participant is never refunded the "overpaid" amount,
  but they also aren't asked to give it back; they simply can't claim
  further until the live total catches back up.

---

## 4. Coverage

| Property | Verified by |
|---|---|
| D1 — cumulative claims never exceed cumulative earned | `prop_cumulative_claims_never_exceed_earned` |
| Claimed high-water mark is monotonic | `prop_claimed_high_water_mark_is_monotonic` |
| Fixed-scenario rate-change regression | `updated_rates_affect_reward_calculation`, `update_reward_params_affects_lp_rewards` |
| No double-claim without new accrual | `lp_earns_on_funding_and_cannot_double_claim` |
