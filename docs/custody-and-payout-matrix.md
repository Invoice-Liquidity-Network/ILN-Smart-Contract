# Custody and Payout Matrix

**Issue:** #1160 · **Scope:** `invoice_liquidity`, `insurance_pool`, `iln_distribution`, governance proposal deposits · **Companion:** [authority-matrix.md](authority-matrix.md)

This document maps every path through which ILN contracts receive, hold, transfer or withdraw tokens, the authorization each path requires, the storage that tracks the obligation, and the test or invariant that protects it. It improves repository assurance. **It does not replace an independent professional audit.** See [§5](#5-reserved-for-professional-audit).

## 1. How custody works

- **One pooled balance per token.** `invoice_liquidity` holds every invoice's funds in a single token balance per asset. There are no per-invoice sub-accounts. Per-invoice obligations live only in storage (`Invoice.amount_funded`, `Invoice.amount_paid`, `InvoiceFunders`). A payout that is not backed by its own invoice's deposits is therefore paid from other users' funds, and no token-level check would notice.
- **Outbound guard.** Every outbound ILN payment goes through `token_safety::transfer_out_strict` or `token_safety::pay_or_escrow`. Both refuse to spend below `PendingPayoutTotal(token)`, the escrow reserved for frozen recipients, and fail with `InsufficientContractBalance` rather than trapping. This guard checks the pooled balance, **not** the invoice's own backing.
- **Frozen recipients.** A third party whose trustline is deauthorized is not paid. Their share is escrowed as `PendingPayout(recipient, token)` and withdrawn later with `claim_pending_payout` ([token-safety.md](token-safety.md)).
- **Atomicity.** Soroban reverts every storage write and token transfer of an invocation that returns `Err` or traps. A failed transfer therefore never leaves a half-applied state. The tests in [§3](#3-test-coverage-by-acceptance-criterion) check this explicitly instead of assuming it.
- **Reentrancy.** Token-moving ILN entry points take `lock_reentrancy`; see [threat-model.md](threat-model.md).

## 2. Custody map

`cost(x) = x − x·discount_rate/10 000`, which is what an LP pays to fund `x` of face value.

### 2.1 `invoice_liquidity`

| ID | Entry point | Caller authorization | Token movement | Storage obligation | Accounting invariant | Protected by |
|----|-------------|----------------------|----------------|--------------------|----------------------|--------------|
| C1 | `fund_invoice` | `funder.require_auth()`; queue winner only, if a queue resolved | LP → ILN `cost(fund_amount)`; on the funding that completes the invoice, ILN → freelancer `amount − discount` (strict: fails if the freelancer is frozen) | `amount_funded += fund_amount`; `InvoiceFunders`; status `PartiallyFunded`/`Funded`; `funder` | `amount_funded ≤ amount`; the freelancer is paid once, on the `→ Funded` transition | `failed_lp_transfer_leaves_invoice_unfunded_and_freelancer_unpaid`; `tests_token_safety` (frozen funder/freelancer); `test_err_overfunding_rejected` |
| C2 | `mark_paid` | `invoice.payer.require_auth()` | Payer → ILN `amount`; at full payment ILN → fee recipient `amount·fee/10 000` and ILN → each funder `(amount − fee)·share/amount` (escrowed if frozen) | `amount_paid += amount`; status `Paid` | `amount_paid ≤ amount`; `fee + Σ shares ≤ amount` (truncation dust stays in the contract) | `settlement_pays_exactly_once_and_leaves_no_escrow`; `split_settlement_never_distributes_more_than_collected`; `maximum_fee_settlement_pays_out_exactly_the_payment`; `failed_payer_transfer_leaves_invoice_funded_and_lp_unpaid`; `imposter_cannot_settle_on_behalf_of_payer` |
| C3 | `cancel_invoice` | freelancer (`require_submitter_by_id`) | When `PartiallyFunded`: ILN → each funder `cost(fund_amt)` | status `Cancelled` | Refund equals exactly what each LP paid in C1 | `cancel_refunds_partial_funders_exactly_once`; `imposter_cannot_cancel_and_trigger_refunds` |
| C4 | `resolve_dispute(…, 1)` | admin | ILN → each funder `cost(fund_amt)`; ILN → payer `amount_paid` | status `Cancelled` | Backed when the invoice is `PartiallyFunded`. See **F-04** for the `Funded` case. | `upheld_dispute_on_partial_funding_refunds_exactly_once`; `imposter_cannot_resolve_dispute_into_a_refund` |
| C5 | `claim_default` | `funder.require_auth()` **and** funder ∈ `InvoiceFunders` | ILN → each funder `cost(fund_amt)`; then `insurance_pool.claim` (best effort, `try_`) | status `Defaulted`; pre-default payer score snapshot | Pays once per invoice (status gate). Backing: see **F-04**. | `non_funder_cannot_claim_default`; `test_claim_default_twice_fails`; `tests_insurance_integration` |
| C6 | `claim_yield` | the recorded funder | **None.** Read-only quote. | none | Never moves tokens | `claim_yield_is_a_read_only_quote` |
| C7 | `claim_pending_payout` | `recipient.require_auth()` | ILN → recipient, up to their escrow | `PendingPayout`, `PendingPayoutTotal` decrease | Pays the escrow once; leaves the entry intact on failure | `tests_token_safety::claim_pending_payout_*` |
| C8 | `transfer_lp_position` | current funder | none; redirects future C2/C5 payouts | `funder`, `InvoiceFunders`, LP index | Position moves only with the holder's signature | `imposter_cannot_redirect_an_lp_position`; `tests_nft_transfer_consistency` |
| C9 | `expire_invoice`, `dispute_invoice`, `appeal_default`, `resolve_appeal`, `auto_resolve_dispute` | anyone / payer / payer / admin / anyone | none | status, appeal and dispute records | No token movement | `tests_appeal`, `tests_pause_checks` |
| C10 | `pause` / `unpause` | admin, or a multisig proposal | none | `Paused` | C1, C2, C3, C5 and C7 fail with `ContractPaused` while paused | `pause_blocks_every_token_moving_entrypoint`; `tests_pause_checks` |
| C11 | `update_fee_rate`, `update_fee_tiers`, `propose_set_fee_rate`/`execute_proposal` | admin / admin / multisig threshold | none directly; sets the C2 fee | `FeeRate`, `FeeTiers` | Every path enforces `rate ≤ MAX_PROTOCOL_FEE_BPS` (10 000), so `fee ≤ amount` (**F-01**) | `fee_rate_above_one_hundred_percent_is_rejected_on_every_path`; `g3_governance_cannot_push_a_parameter_past_the_contract_bound` |

### 2.2 `insurance_pool`

| ID | Entry point | Caller authorization | Token movement | Storage obligation | Invariant | Protected by |
|----|-------------|----------------------|----------------|--------------------|-----------|--------------|
| I1 | `deposit_premium` | `lp.require_auth()` | LP → pool `amount` | `Premiums(lp)`; `Balance` (liquid) + `BackstopBalance` split by `backstop_funding_bps`; auto-enrolls | `Balance + BackstopBalance == token balance` | `failed_premium_transfer_books_nothing`; `deposit_premium_*` (test.rs) |
| I2 | `claim(invoice_id, lp)` | pool admin (the ILN contract in production) | pool → `lp`: `min(tiered coverage, Balance + Backstop)`, liquid first | `Claimed(invoice_id)`; balances decrease | Once per invoice; never overdraws the booked reserves | `claim_is_idempotent_per_invoice`; `claims_draw_liquid_then_backstop_and_never_exceed_reserves`; `only_the_admin_can_trigger_a_claim_payout` |
| I3 | `top_up_backstop` | pool admin **and** `from.require_auth()` | `from` → pool | `BackstopBalance` | Booked equals held | `only_the_admin_can_order_a_backstop_top_up` |
| I4 | `enroll` | `lp.require_auth()` | none | `Enrolled(lp)` | No token movement | test.rs |

### 2.3 `iln_distribution`

| ID | Entry point | Caller authorization | Token movement | Invariant | Protected by |
|----|-------------|----------------------|----------------|-----------|--------------|
| D1 | `accrue_lp`, `accrue_settlement` | the configured ILN contract | none (accrual only) | Only ILN can credit volume | `only_the_iln_contract_can_accrue_rewards` |
| D2 | `claim_tokens` | `claimer.require_auth()` | **mint** of governance token to the claimer: `total_earned − Claimed` | Mints at most the unclaimed accrual; repeat calls mint 0 | `lp_earns_on_funding_and_cannot_double_claim`; `nobody_can_claim_another_participants_rewards` |
| D3 | `set_*_reward_rate` | the configured ILN address (see **F-06**) | none | No bound on the new rate (**F-06**) | `reward_rate_setters_accept_only_the_configured_iln_address` |

### 2.4 `iln_governance` (proposal deposits)

| ID | Entry point | Caller | Token movement | Invariant | Protected by |
|----|-------------|--------|----------------|-----------|--------------|
| P1 | `create_proposal` | proposer | proposer → governance: `MinProposalDeposit` of the governance token | `ProposalDeposit(id)` escrowed | `test_deposit_escrowed_on_create` |
| P2 | `execute_proposal` (Passed/Executed), veto, rejection | anyone / veto signers | governance → proposer (refund) **or** → `ProposalDepositSink` (forfeit) | Settled exactly once (`ProposalDepositSettled`) | `test_deposit_settles_exactly_once_across_pass_execute_and_veto`; `test_deposit_not_double_refunded_on_execute` |

## 3. Test coverage by acceptance criterion

| Acceptance criterion | Tests |
|----------------------|-------|
| Failed token transfers do not create a successful invoice or claim state | `failed_lp_transfer_leaves_invoice_unfunded_and_freelancer_unpaid`, `failed_payer_transfer_leaves_invoice_funded_and_lp_unpaid`, `failed_premium_transfer_books_nothing`, `tests_token_safety` (frozen funder/payer/freelancer, clawback), `tests_resource_limit_failure` |
| Repeated payout or withdrawal calls pay at most once | `settlement_pays_exactly_once_and_leaves_no_escrow`, `cancel_refunds_partial_funders_exactly_once`, `upheld_dispute_on_partial_funding_refunds_exactly_once`, `claim_yield_is_a_read_only_quote`, `test_claim_default_twice_fails`, `claim_is_idempotent_per_invoice`, `lp_earns_on_funding_and_cannot_double_claim`, the governance deposit tests |
| Unauthorized payout, refund, insurance, treasury or admin transfer calls fail | `imposter_cannot_*` (custody), `non_funder_cannot_claim_default`, `only_the_admin_can_trigger_a_claim_payout`, `only_the_admin_can_order_a_backstop_top_up`, `only_the_iln_contract_can_accrue_rewards`, `nobody_can_claim_another_participants_rewards`, and the whole [authority-matrix.md](authority-matrix.md) suite |
| Protocol fees and claims stay within collectible balances or obligations | `fee_rate_above_one_hundred_percent_is_rejected_on_every_path`, `maximum_fee_settlement_pays_out_exactly_the_payment`, `split_settlement_never_distributes_more_than_collected`, `claims_draw_liquid_then_backstop_and_never_exceed_reserves`, `max_discount_cannot_exceed_the_submit_hard_cap` |

Files: `contracts/invoice_liquidity/src/tests_custody_accounting.rs`, `contracts/insurance_pool/src/tests_custody.rs`, `contracts/iln_distribution/src/tests_custody.rs`. The custody tests deploy `invoice_liquidity` **without** pre-funding it, unlike `test::setup()`, so every balance assertion is exact.

## 4. Findings

Severity follows [SECURITY.md](../SECURITY.md#severity-levels). "Open" means a maintainer decision is needed; this change does not alter that behavior.

| ID | Severity | Finding | Status |
|----|----------|---------|--------|
| F-01 | High | The protocol fee rate had no upper bound on any path (`update_fee_rate`, `update_fee_tiers`, multisig `SetFeeRate`, and governance `UpdateFeeRate`/`UpdateFeeTiers`, which call the first two). With a rate above 10 000 bps, `mark_paid` sends the fee recipient more than the payer paid in, and the difference comes from other invoices' pooled funds. | **Fixed.** `MAX_PROTOCOL_FEE_BPS = 10 000` is enforced on all paths, including execution of an already-stored multisig proposal; new error `InvalidFeeRate = 84`. |
| F-02 | Medium | `update_max_discount` and multisig `SetMaxDiscount` were unbounded. `submit_invoice` hard-caps the discount at 5 000, but `update_invoice` and batch submission validate against the *stored* maximum, so a discount above 100% gives a negative funding cost. | **Fixed.** Both paths enforce `≤ MAX_DISCOUNT_RATE` (`InvalidDiscountRate`). |
| F-03 | Medium | Multisig `execute` counted every recorded approval, including approvals from signers later removed by `UpdateMultisig` or a finalized rotation. A removed or compromised key kept contributing to the threshold of proposals it had signed. | **Fixed.** Only approvals from current signers count (`multisig::threshold_reached`). |
| F-04 | — | An issue in the default-path refund accounting. | **Withheld pending private disclosure** under [SECURITY.md](../SECURITY.md). Two cross-contract tests are `#[ignore]`d pending the maintainer decision. |
| F-05 | Medium | Governance actions `UpdateInsuranceCoverageCap` and `UpdateInsurancePremiumRate` invoke `set_coverage_via_governance`/`set_premium_rate_via_governance` on the **ILN contract address** (`get_iln_contract`), not the insurance pool. They always fail; only a `proposal_execution_failed` event shows it. | Open. Governance needs an insurance-pool address (new config + migration). |
| F-06 | Medium | `iln_distribution` reward-rate setters authenticate the configured *ILN* address, but governance calls them from the governance contract, so governance proposals can never change reward rates. `UpdateDistributionRewardParams` targets `update_reward_params`, which does not exist. Neither path bounds the new rate (negative or unbounded values are accepted). | Open. Decide which contract owns reward policy, then add bounds. |
| F-07 | Medium | The protocol fee (and any fee escrowed for a frozen recipient) is paid to the ILN **admin** address. After the ADR-012 handoff the admin is the governance contract, which can only move the governance token. Payment-token fees would be stranded there. | Open. Introduce an explicit fee-recipient/treasury address. |
| F-08 | Low | The multisig admin path (`propose_*`/`execute_proposal`) skips the direct-admin rate limits and the `record_admin_action` audit log, and is independent of governance voting and timelock. | Open (by design, but now documented in [authority-matrix.md](authority-matrix.md#3-path-differences)). |
| F-09 | Low | `set_admin` is single-step: a mistyped address permanently loses admin control. | Open. Consider propose/accept. |
| F-10 | Low | `insurance_pool.claim` pays whichever `lp` the admin passes and trusts the ILN contract to have checked enrollment and default. Pool setters gated by the pool admin are unreachable while the admin is the ILN contract, which never forwards them. | Open. Admin-trusted; document deployment. |
| F-11 | Low | `set_distribution_contract` has no rate limit, and ILN notifies distribution with a non-`try` call. Pointing it at a reverting contract blocks funding and settlement until it is reset. | Open. Admin-trusted. |
| F-12 | Info | The #1082 pre-upgrade TTL guard calls `get_ttl`, which soroban-sdk only provides under `testutils`. A release WASM build of `invoice_liquidity` therefore does not compile. | Open (build blocker for `make build`). |

## 5. Reserved for professional audit

These areas need an independent audit and are **not** settled by this document or its tests:

- The economic soundness of default handling, insurance pricing (tiered coverage versus premiums paid), and governance-token emission under adversarial participants.
- Oracle manipulation and quorum assumptions ([oracle-attack-economics.md](oracle-attack-economics.md)).
- Stellar Asset Contract semantics: clawback, `AUTH_REQUIRED`/`AUTH_REVOCABLE`, and fee-on-transfer or non-standard SEP-41 tokens added through `add_token`.
- Storage compatibility of WASM upgrades and `migrate`, including TTL expiry of persistent entries.
- Cross-contract reentrancy and call-ordering beyond the single-contract lock.
- Formal proof of token conservation across all five contracts ([formal-verification-cross-contract.md](formal-verification-cross-contract.md)).
