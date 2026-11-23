# Distribution Pool Funding & Settlement Notifications

**Issue:** #1198 — Audit distribution pool funding and settlement notifications.
**Target contract:** `contracts/iln_distribution/src/lib.rs`
**Related docs:** [`formal-verification-distribution.md`](formal-verification-distribution.md)
(reward-conservation invariant D1), [`event-types.md`](event-types.md).

---

## 1. Scope and non-goals

**In scope.** The consistency between the `iln_distribution` reward ledger —
the cumulative governance-token *pool* it eventually mints from — and the
cross-contract *notifications* (Soroban events) it publishes, on both the
success and the failure/no-op paths. This covers:

- `accrue_lp` (LP funding accrual),
- `accrue_settlement` (freelancer / payer settlement accrual),
- `claim_tokens` (reward claim → mint),
- `set_lp_reward_rate` / `set_freelancer_reward_rate` / `set_payer_reward_rate`
  (reward-rate governance),
- the consumer side in `contracts/invoice_liquidity/src/lib.rs`
  (`notify_distribution_funding`, `notify_distribution_settlement`), which is
  where the ILN core contract raises these notifications.

**Non-goals.** No behavior, storage-layout, entry-point signature or event-shape
change. The reward-rate model (rates are applied to *cumulative* counters at
claim time) is documented, not reworked; that economic property is already
analyzed in [`formal-verification-distribution.md`](formal-verification-distribution.md).
SDK/indexer-side changes are out of scope and belong in a separate PR.

---

## 2. Entry points, data sources and authorization

| Entry point | Authorized caller | State written | Notification |
|---|---|---|---|
| `initialize` | Deployment (once) | `Initialized`, `IlnContract`, `GovToken`, `*RewardRate` | `init` (`ContractInitialized`) |
| `accrue_lp` | `StorageKey::IlnContract` (`require_iln_invoker`) | `LpFundedVolume(lp)` (persistent) | `lp_accr` (`LpVolumeAccrued`) |
| `accrue_settlement` | `StorageKey::IlnContract` (`require_iln_invoker`) | `FreelancerSettled(freelancer)`, optionally `PayerOnTimeSettled(payer)` | `settled` (`SettlementAccrued`) |
| `claim_tokens` | The `claimer` (`claimer.require_auth()`) | `Claimed(claimer)` (persistent); mints via SAC | `claimed` (`TokensClaimed`) |
| `set_lp_reward_rate` | `StorageKey::IlnContract` (`require_governance_invoker`) | `LpRewardRate` | `rw_upd` (`RewardRateUpdated`) |
| `set_freelancer_reward_rate` | `StorageKey::IlnContract` (`require_governance_invoker`) | `FreelancerRewardRate` | `rw_upd` |
| `set_payer_reward_rate` | `StorageKey::IlnContract` (`require_governance_invoker`) | `PayerRewardRate` | `rw_upd` |
| `get_accrual` / `get_*_reward_rate` | Anyone (read-only) | — | — |

**Data sources.** `total_earned(participant)` is derived **live** from three
persistent counters (`LpFundedVolume`, `FreelancerSettled`, `PayerOnTimeSettled`)
multiplied by the **current** instance-scoped reward rates. Nothing snapshots
the rate at accrual time.

**Authorization note.** `require_governance_invoker` and `require_iln_invoker`
are identical (`StorageKey::IlnContract.require_auth()`): there is no separate
governance contract, so reward-rate changes require the *ILN core contract's*
authorization. The previous `/// Access: Anyone` doc comment on the three
setters was wrong and has been corrected (see VF-2).

---

## 3. Reward ledger (pool balance) model

`iln_distribution` does not custody tokens; it **mints** reward tokens on
demand through a Stellar Asset Contract that it administers itself (Issue
#861). The "distribution pool balance" is therefore definitionally the
cumulative supply minted by `claim_tokens`, and the ledger that determines
future minting is the set of persistent counters above.

For a participant:
```
total_earned = (LpFundedVolume / 1_000_000_000) * lp_rate
             + FreelancerSettled   * freelancer_rate
             + PayerOnTimeSettled  * payer_rate
claimable    = saturating_sub(total_earned, Claimed)      // 0 ⇒ no-op
mint(claimable); Claimed += claimable
```
Because `Claimed` is set to exactly the live `total_earned` on every
successful claim, cumulative minted ≤ the high-water mark of `total_earned`
(invariant D1, see the formal-verification doc).

---

## 4. Notifications (events)

All topics are `symbol_short!` and all payloads are `#[contracttype]` structs.

| Entry point | Topics | Payload |
|---|---|---|
| `initialize` | `("init",)` | `ContractInitialized { iln_contract, gov_token }` |
| `accrue_lp` | `("lp_accr", lp)` | `LpVolumeAccrued { lp, amount_usdc_equivalent }` |
| `accrue_settlement` | `("settled", freelancer, payer)` | `SettlementAccrued { freelancer, payer, settled_on_time }` |
| `claim_tokens` | `("claimed", claimer)` | `TokensClaimed { claimer, amount }` |
| `set_*_reward_rate` | `("rw_upd",)` | `RewardRateUpdated { rate_type, old_rate, new_rate }` |

Notifications are published **after** the corresponding storage write, and only
on the paths that actually mutate state (see §5).

---

## 5. Failure and no-op behavior

| Situation | State change | Notification | Notes |
|---|---|---|---|
| `accrue_lp` with `amount <= 0` | none | **none** | Silent early `return` (VF-1) |
| `accrue_lp` with `amount > MAX_LP_ACCRUAL_PER_CALL` | none | **none** | Silent early `return` (VF-1) |
| `accrue_lp` accepted (incl. exact ceiling) | volume `+= amount` | one `lp_accr` | Event carries the input amount |
| `accrue_lp` for `< 100 USDC` (below `1e9` stroops) | volume recorded | one `lp_accr` | Reward floors to 0 (VF-3) |
| `accrue_settlement` (any value) | freelancer `+1`, payer `+1` iff on-time | one `settled` | No dedup (VF-4) |
| `claim_tokens` with `claimable <= 0` | none | **none** | Returns `0` (VF-5) |
| `claim_tokens` with `claimable > 0` | mints + `Claimed` | one `claimed` | Mint is the SAC sub-call |
| `claim_tokens` before `initialize` | — | — | Panics on `GovToken.unwrap()` (RR-4) |
| Non-ILN caller on accrual / rate setter | none | none | `require_auth` panics; whole call reverts |
| Wrong `claimer` on `claim_tokens` | none | none | `require_auth` panics; whole call reverts |

**Cross-contract propagation.** The consumer helpers in
`contracts/invoice_liquidity/src/lib.rs` invoke `accrue_lp` / `accrue_settlement`
with `env.invoke_contract` (not `try_invoke_contract`). A panic in the
distribution accrual therefore **aborts the whole `fund_invoice` /
`mark_paid` transaction** — the notification is not best-effort (VF-7).

---

## 6. Invariants

- **INV-DIST-1 (notification ⇔ mutation, success):** every accepted
  state-mutating entry point publishes exactly one notification whose payload
  equals the state change it announces.
- **INV-DIST-2 (no phantom notification, failure):** an entry point that makes
  no state change (rejected `accrue_lp`; `claim_tokens` with nothing
  claimable) publishes no notification.
- **INV-DIST-3 (claim ⇔ mint):** for each claimer, cumulative minted tokens =
  Σ `TokensClaimed.amount` = that claimer's token balance.
- **INV-DIST-4 (pool conservation):** aggregate minted supply = Σ participant
  balances = Σ all `TokensClaimed.amount`.
- **INV-DIST-5 (settlement counters):** an on-time settlement increments
  exactly the freelancer and payer counters; a late settlement increments only
  the freelancer counter.
- **INV-DIST-6 (reward conservation):** cumulative claims never exceed the
  high-water mark of `total_earned` (inherits D1).

---

## 7. Verified findings (observed behavior)

- **VF-1 — rejected `accrue_lp` is a silent no-op.** Non-positive and
  over-ceiling amounts `return` before any write or event. Indexers that rely
  solely on `lp_accr` cannot distinguish "no funding" from "notification
  dropped"; reconciliation must read `get_accrual`.
- **VF-2 — rate setters are ILN-gated, not "anyone".** `require_governance_invoker`
  is identical to `require_iln_invoker` (both `IlnContract.require_auth()`);
  there is no separate governance contract. Corrected the misleading doc
  comments.
- **VF-3 — sub-100-USDC volume notifies but earns nothing.** `lp_volume /
  1_000_000_000` floors, so `< 1e9` stroops of funded volume produces a
  `lp_accr` event yet `0` reward. The notification volume is not
  reward-bearing volume.
- **VF-4 — settlements are per-call, no dedup; self-settlement double-credits.**
  Each `accrue_settlement` call increments the freelancer counter and, when
  on-time, the payer counter, with no idempotency. When `freelancer == payer`
  and on-time, one call accrues both rewards to the same address (2 counters,
  1 event).
- **VF-5 — `claim_tokens` emits only on a non-empty claim.** No-op claims
  return `0` with no event, so minted supply equals Σ successful `claimed`
  events.
- **VF-6 — rates re-price unclaimed volume (live).** `total_earned` uses the
  *current* rate against cumulative counters: a rate increase mints an extra
  delta on the next claim; a rate cut can drop live `total_earned` below an
  already-claimed mark, blocking further claims without clawback. Claims never
  exceed the live `total_earned`, preserving D1.
- **VF-7 — notification failure is fatal to the economic operation.** The ILN
  core notifies the distribution contract via `invoke_contract`; a panic in
  `accrue_lp` / `accrue_settlement` reverts `fund_invoice` / `mark_paid`
  entirely.

---

## 8. Residual risks

- **RR-1** — No notification on rejected accruals (VF-1): off-chain systems
  cannot detect a dropped/ignored funding notification from the event stream
  alone.
- **RR-2** — Settlement idempotency depends entirely on the ILN core contract
  calling `accrue_settlement` exactly once per settlement (VF-4); a duplicate
  call silently inflates counters and rewards.
- **RR-3** — The `lp_accr` payload carries the *input* volume, not the applied
  delta. If `LpFundedVolume` saturated at `i128::MAX` (practically unreachable
  given the per-call ceiling) the event would over-report versus stored state.
- **RR-4** — `claim_tokens` uses `.unwrap()` on `StorageKey::GovToken`; calling
  it before `initialize` panics instead of returning a typed error (no partial
  state, but an operator-visible panic).
- **RR-5** — Because the notification is fatal (VF-7), a misconfigured /
  upgraded / mismatched distribution contract address can block funding and
  settlement until an admin calls `set_distribution_contract`.

---

## 9. Test mapping

Implemented in `contracts/iln_distribution/src/tests_distribution_notifications.rs`
(all `#[test]`, direct client calls under `mock_all_auths`).

| Invariant / finding | Test |
|---|---|
| INV-DIST-1 (accrue_lp success) | `funding_accrual_updates_balance_and_emits_matching_notification` |
| INV-DIST-1 (accumulation) | `funding_accrual_accumulates_balance_across_successive_notifications` |
| boundary (exact ceiling) | `exact_ceiling_funding_amount_is_accepted_and_notified` |
| INV-DIST-2 (zero / negative) | `zero_funding_amount_is_a_silent_no_op_without_notification`, `negative_funding_amount_is_a_silent_no_op_without_notification` |
| INV-DIST-2 (over ceiling) | `over_ceiling_funding_amount_is_a_silent_no_op_without_notification` |
| VF-1 (no stale notification) | `rejected_funding_after_a_successful_one_still_notifies_nothing` |
| VF-3 (truncation) | `sub_hundred_usdc_volume_notifies_but_truncates_to_zero_reward` |
| INV-DIST-1 / 5 (on-time settlement) | `on_time_settlement_notifies_and_rewards_freelancer_and_payer` |
| INV-DIST-5 (late settlement) | `late_settlement_notifies_and_rewards_freelancer_only` |
| VF-4 (no dedup) | `repeated_settlements_are_not_deduplicated_and_each_notifies` |
| VF-4 (self-settlement) | `self_settlement_credits_the_same_address_twice` |
| INV-DIST-3 (claim ⇔ mint) | `claim_mints_notifies_and_balance_matches_minted_amount` |
| INV-DIST-2 / VF-5 (empty claim) | `second_claim_with_nothing_claimable_returns_zero_without_notification`, `claim_without_any_accrual_mints_nothing_and_notifies_nothing` |
| INV-DIST-4 (pool conservation) | `pool_minted_supply_equals_sum_of_all_claimed_rewards` |
| rate notification shape | `reward_rate_updates_notify_with_old_and_new_rate` |
| VF-6 (re-price up) | `rate_increase_re_prices_unclaimed_volume_and_notifies` |
| VF-6 (re-price down, no clawback) | `rate_cut_after_claim_does_not_claw_back_and_blocks_further_claim` |

Existing coverage that this complements: `mod test` (funding/settlement/claim
regressions, auth, sanity ceiling, mint-authority) and `mod proptest_invariants`
(high-water-mark conservation). The consumer-side propagation in VF-7 is
exercised by `contracts/invoice_liquidity/src/tests_distribution.rs`.

---

## 10. Compatibility

No storage keys, entry-point signatures, error codes or event shapes changed.
The only source edits are the corrected authorization doc comments on the three
`set_*_reward_rate` functions (§2, VF-2) and the new `#[cfg(test)]` module
registration; all other changes are additive tests and this document.
