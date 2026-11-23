# Distribution Replay & Duplicate-Event Behavior

**Issue:** #1199 — Add distribution replay and duplicate-event tests.
**Target contract:** `contracts/iln_distribution/src/lib.rs`
**Related docs:** [`distribution-funding-settlement.md`](distribution-funding-settlement.md)
(notification↔state consistency), [`formal-verification-distribution.md`](formal-verification-distribution.md)
(reward-conservation invariant D1).

---

## 1. Scope and non-goals

**In scope.** What happens when the *same* funding/settlement notification is
delivered more than once, and whether replayed claims or duplicated events can
inflate the distribution totals (the reward ledger and the governance-token
supply it eventually mints).

**Non-goals / explicit budget.** This issue is a **test + documentation**
change. No entry point, storage key, error code or event shape is modified, so
`contracts/iln_distribution/Cargo.toml` needs **no change** — `proptest` and the
`soroban-sdk` `testutils` feature are already dev-dependencies. The upstream
ILN-core replay guard (invoice lifecycle state machine) is documented here but
implemented in `contracts/invoice_liquidity`, and any indexer/SDK reconciliation
changes belong in a separate PR.

---

## 2. Assumptions and data sources

- **Single authorized notifier.** `accrue_lp` / `accrue_settlement` are gated to
  `StorageKey::IlnContract`; the ILN core contract is the only intended caller.
  "Replay" here means that authorized caller (or a re-executed/duplicated
  message) delivering the same notification twice.
- **Counters, not balances.** The ledger is a set of persistent counters
  (`LpFundedVolume`, `FreelancerSettled`, `PayerOnTimeSettled`) plus a per-claimer
  `Claimed` high-water mark. `total_earned` is recomputed from those counters
  against the *current* reward rates.
- **Delivered message identity is not modelled.** The contract stores no
  invoice id, sequence number, nonce or content hash for accruals, so it has no
  way to recognise a duplicate.

---

## 3. Authorization rules

| Entry point | Authorized caller | Replay relevance |
|---|---|---|
| `accrue_lp` | ILN core (`require_iln_invoker`) | Additive; a replay re-applies the amount |
| `accrue_settlement` | ILN core (`require_iln_invoker`) | Additive; a replay re-increments counters |
| `claim_tokens` | The `claimer` | Idempotent via the `Claimed` high-water mark |
| `set_*_reward_rate` | ILN core (`require_governance_invoker`, identical to `require_iln_invoker`) | Idempotent at the delivered-rate level (last write wins per rate) |

`claim_tokens` is the only entry point that is inherently replay-safe.

---

## 4. Replay model

| Delivered twice | Effect on ledger | Effect on minted supply | Replay-safe? |
|---|---|---|---|
| `accrue_lp(lp, amount)` | `LpFundedVolume(lp) += 2·amount` | none by itself | **No** |
| `accrue_settlement(f, p, true)` | `FreelancerSettled(f) += 2`, `PayerOnTimeSettled(p) += 2` | none by itself | **No** |
| `claim_tokens(lp)` | `Claimed(lp)` unchanged on the 2nd call | **once only** (2nd call mints `0`) | **Yes** |

So replay protection is **layered**:

1. **Claim layer (in this contract, enforced).** `claimable = total_earned −
   Claimed`, minted only when `> 0`; a repeated claim returns `0`, mints
   nothing and emits no event. Replayed claim attempts/events therefore cannot
   double-count the minted pool.
2. **Accrual layer (NOT enforced here).** A duplicated accrual notification is
   applied verbatim. Correctness depends on the caller.
3. **Upstream caller layer (out of scope, but the real guard).** The ILN core
   contract emits `accrue_lp` from `fund_invoice` and `accrue_settlement` from
   `mark_paid`, both of which are gated by the invoice lifecycle state machine
   (`Funded`/`Paid` transitions reject repeats). End-to-end replay is blocked
   there — **not** by `iln_distribution`.

---

## 5. Failure and no-op behavior under replay

| Situation | State change | Notification |
|---|---|---|
| Replayed `accrue_lp` with valid amount | ledger grows again | one `lp_accr` per delivery |
| Replayed `accrue_lp` with invalid amount | none | none (silent, see VF-1 of #1198) |
| Replayed `accrue_settlement` | counters grow again | one `settled` per delivery |
| Replayed `claim_tokens` (nothing new earned) | none | none (returns `0`) |
| `claim_tokens` for a different / wrong `claimer` | none | none (auth reverts whole call) |

Events stay in lock-step with the ledger: exactly one notification per
delivered-and-applied accrual, and no notification on a no-op claim.

---

## 6. Invariants

- **INV-DR1 (accrual is linear, not idempotent):** N deliveries of the same
  funding/settlement notification produce exactly N× the per-delivery ledger
  delta.
- **INV-DR2 (claim idempotency):** the cumulative amount minted to a claimer is
  independent of the number of claim attempts, and equals that claimer's live
  `total_earned` at the last successful claim.
- **INV-DR3 (no phantom mint on replay):** a claim that would mint `≤ 0` mints
  nothing and emits no `claimed` event.
- **INV-DR4 (event/ledger agreement):** for accruals, the number of
  notifications equals the number of applied deliveries; totals equal
  notifications × per-notification rate.
- **INV-DR5 (pool conservation under replay):** aggregate minted supply equals
  the sum of each participant's earned total, regardless of how many claims are
  replayed.
- **INV-DR6 (reward conservation, inherits D1):** cumulative claims never exceed
  the high-water mark of `total_earned`.

---

## 7. Verified findings (observed behavior)

- **VF-1 — `accrue_lp` has no replay guard.** The same funding notification
  delivered twice adds the volume twice; there is no stored delivery id, nonce
  or hash to detect the duplicate.
- **VF-2 — `accrue_settlement` has no replay guard.** Each delivery increments
  the freelancer counter (and the payer counter when on-time); duplicates
  inflate both.
- **VF-3 — `claim_tokens` is replay-safe.** The `Claimed` high-water mark makes
  repeat claims `0`-returning no-ops with no mint and no event — the sole
  in-contract double-count guard for the minted pool.
- **VF-4 — events track applied deliveries.** Accruals emit exactly one event
  per applied delivery and none for rejected/no-op paths, so a replay-aware
  indexer can reconcile against `get_accrual` without divergence from on-chain
  totals.
- **VF-5 — replay protection is layered upstream.** Because `fund_invoice` /
  `mark_paid` are lifecycle-gated in the ILN core contract, an accrual replay
  is not reachable end-to-end; the distribution contract itself does not and
  cannot enforce this.

---

## 8. Residual risks

- **RR-1** — A replayed accrual notification (from a faulty/duplicated upstream
  message, a re-org, or a future caller that does not deduplicate) **double-counts
  the distribution totals** at the accrual layer. There is no on-chain guard in
  `iln_distribution`; mitigation must live in the caller.
- **RR-2** — Because accruals are not idempotent, the *reward* for a duplicated
  settlement is also duplicated once claimed (INV-DR2 caps claims at the
  inflated `total_earned`, it does not detect the inflation).
- **RR-3** — There is no in-contract way to correct an already-applied duplicate
  accrual (no decrement / reversal entry point); remediation would require
  governance action at a higher layer.
- **RR-4** — The replay boundary is implicit: nothing in `iln_distribution`
  signals "already applied", so indexers cannot distinguish a genuine second
  event from a replay without cross-referencing invoice state upstream.

---

## 9. Test mapping

Implemented in `contracts/iln_distribution/src/tests_distribution_replay.rs`.

| Invariant / finding | Test |
|---|---|
| INV-DR1 / VF-1 | `replayed_funding_notification_is_additive_not_idempotent` |
| INV-DR1 / VF-2 | `replayed_settlement_notification_is_additive_not_idempotent` |
| INV-DR4 / VF-4 | `each_replayed_notification_emits_exactly_one_event_so_totals_track_events` |
| INV-DR2 / VF-3 | `repeated_claim_is_idempotent_and_never_double_mints` |
| INV-DR3 | `noop_claim_emits_no_duplicate_notification` |
| INV-DR2 (N attempts) | `many_claim_attempts_mint_total_earned_exactly_once` |
| INV-DR2 + rate change | `replayed_claim_after_rate_increase_mints_only_the_delta_once` |
| INV-DR5 | `pool_totals_equal_sum_of_unique_claims_under_replay` |
| INV-DR2 / DR6 (randomised) | `prop_replayed_claims_never_exceed_earned` |

Complements `tests_distribution_notifications.rs` (#1198) and the existing
`mod proptest_invariants` (D1). The upstream lifecycle gate in VF-5 is covered
by `contracts/invoice_liquidity/src/tests_distribution.rs`.

---

## 10. Compatibility

Additive tests and this document only. `contracts/iln_distribution/Cargo.toml`
is unchanged (no new dependencies). No storage, entry-point, error-code or
event-shape changes; the notification behavior described here matches the
current implementation.
