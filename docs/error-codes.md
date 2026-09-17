# Contract Error Codes

This reference documents all error codes returned by the ILN smart contracts across all crates, including common causes, recommended remediations, and cross-references to unit tests verifying reachability (Pre-Audit Checklist Item 1.6).

---

## 1. `invoice_liquidity` — `ContractError`

Source of truth: [`contracts/invoice_liquidity/src/errors.rs`](../contracts/invoice_liquidity/src/errors.rs)

| Code | Variant | Description | Common Cause | Recommended Remediation | Verifying Test |
|------|---------|-------------|--------------|--------------------------|----------------|
| 1 | `InvoiceNotFound` | The requested invoice ID does not exist in contract storage. | Caller supplied an invalid or deleted invoice ID. | Check the invoice ID before calling, or load it from a prior successful `submit_invoice` response. | `tests_error_cases::test_err_invoice_not_found` |
| 2 | `AlreadyFunded` | The invoice is already funded and cannot be funded again. | A second LP attempted to fund an invoice that already reached the funded state. | Read the invoice status first and stop funding once the invoice is funded. | `tests_error_cases::test_err_already_funded` |
| 3 | `AlreadyPaid` | The invoice has already been paid. | A payer or LP retried a payment flow after settlement completed. | Treat the invoice as terminal and skip any additional payment, funding, or collection attempts. | `tests_error_cases::test_err_already_paid` |
| 4 | `NotFunded` | The invoice has not been funded yet. | A caller tried to settle, claim, or resolve a flow that requires an active funded invoice. | Fund the invoice first, or wait until the correct state transition has occurred. | `tests_error_cases::test_err_not_funded` |
| 5 | `Unauthorized` | The caller does not have the required role or authorization for the action. | Wrong account signed the transaction, or the contract has not been configured with the expected admin/role mapping. | Verify the signing account and required role, then retry with the correct address or permissions. | `tests_error_cases::test_err_unauthorized` |
| 6 | `InvalidAmount` | The provided amount is not acceptable to the contract. | Zero, negative, or otherwise malformed payment/funding amount. | Send a positive amount that matches the invoice rules and token decimals. | `tests_error_cases::test_err_invalid_amount` |
| 7 | `InvalidDiscountRate` | The discount rate is outside the allowed range. | Admin or caller supplied a rate above the contract maximum or in the wrong units. | Use the documented basis-point format and keep the value within the configured bounds. | `tests_error_cases::test_err_invalid_discount_rate` |
| 8 | `InvalidDueDate` | The due date is not valid for invoice creation or update. | Due date is in the past, malformed, or violates contract invariants. | Provide a future due date that satisfies the contract's validation rules. | `tests_error_cases::test_err_invalid_due_date` |
| 9 | `InvoiceDefaulted` | The invoice has already defaulted. | Caller tried to fund, pay, cancel, or otherwise act on an invoice that is already in default. | Use the default/appeal flows instead of settlement or funding flows. | `tests_error_cases::test_err_invoice_defaulted` |
| 10 | `NothingToClaim` | There is no yield or claimable amount available. | LP tried to claim before yield accrued or before funds became claimable. | Wait until the invoice has generated claimable yield, then retry the claim. | `tests_error_cases::test_err_nothing_to_claim` |
| 11 | `NotYetDefaulted` | The invoice has not reached the default threshold yet. | A default-claim or default-handling function was called too early. | Wait until the invoice is actually defaulted before using the default recovery flow. | `tests_error_cases::test_err_not_yet_defaulted` |
| 12 | `OverfundingRejected` | The funding attempt would exceed the invoice's remaining amount. | LP sent more than the unpaid principal or attempted to top up beyond the cap. | Fund only the remaining unpaid amount, or read the remaining balance first. | `tests_error_cases::test_err_overfunding_rejected` |
| 13 | `InvoiceExpired` | The invoice has expired and cannot proceed through normal settlement. | Caller tried to fund or pay after the invoice passed its allowed lifecycle window. | Create a fresh invoice or use the appropriate default/closure flow if supported. | `tests_error_cases::test_err_invoice_expired` |
| 14 | `BatchTooLarge` | The submitted batch exceeds the contract's maximum batch size. | Bulk action included too many invoices in one call. | Split the request into smaller batches and retry. | `tests_error_cases::test_err_batch_too_large` |
| 15 | `AlreadyCancelled` | The invoice was already cancelled. | A caller retried a cancel flow or attempted another action after cancellation. | Treat the invoice as terminal and stop sending state-changing actions for it. | `tests_error_cases::test_err_already_cancelled` |
| 16 | `AlreadyInitialized` | The contract was initialized more than once. | A deployment or setup script ran initialization again after state already existed. | Run initialization only once per deployment and guard scripts against duplicate setup. | `tests_error_cases::test_err_already_initialized` |
| 17 | `AlreadyAppealed` | An appeal already exists for this invoice. | The payer submitted a second appeal for the same defaulted invoice. | Check whether an appeal is already open before creating another one. | `tests_error_cases::test_err_already_appealed` |
| 18 | `AppealWindowClosed` | The appeal deadline has passed. | The appeal was submitted after the configured appeal window elapsed. | Submit the appeal before the deadline, or update the contract configuration if the window needs to change. | `tests_error_cases::test_err_appeal_window_closed` |
| 19 | `NotDefaulted` | The invoice is not currently in the defaulted state required by this action. | A caller attempted to appeal or resolve a default-specific flow before default existed. | Wait until the invoice is defaulted, then retry the default-specific action. | `tests_error_cases::test_err_not_defaulted` |
| 20 | `AlreadyInQueue` | The LP has already joined the funding queue for this invoice. | Duplicate queue enrollment request from the same LP. | Skip re-joining if the LP is already queued, or remove the existing queue entry first. | `tests_error_cases::test_err_already_in_queue` |
| 21 | `NotApprovedFunder` | The LP is not the funder approved by the priority queue. | A different LP attempted to fund before queue resolution selected them. | Wait for queue resolution and fund only when the contract assigns that LP as the approved funder. | `tests_error_cases::test_err_not_approved_funder` |
| 22 | `InvoiceAppealed` | The invoice is currently in the appealed state. | Another action was attempted while appeal review is still in progress. | Wait for the appeal to resolve before retrying settlement or closure flows. | `tests_error_cases::test_err_invoice_appealed` |
| 23 | `AlreadyDisputed` | The invoice is already disputed. | A caller attempted to open a second dispute on the same invoice. | Check dispute status before filing and avoid re-opening an active dispute. | `tests_error_cases::test_err_already_disputed` |
| 24 | `NotDisputed` | The invoice is not in a disputed state. | A dispute-resolution function was called before a dispute existed. | Open a dispute first, or call the correct function for the current invoice state. | `tests_error_cases::test_err_not_disputed` |
| 25 | `InvoiceDisputed` | The invoice is under dispute and cannot proceed through normal settlement. | A user attempted to fund, pay, or finalize an invoice while a dispute is active. | Resolve or dismiss the dispute before retrying normal invoice actions. | `tests_error_cases::test_err_invoice_disputed` |
| 26 | `ContractPaused` | The contract is currently paused. | An admin paused the protocol for maintenance, incident response, or governance action. | Wait until the contract is unpaused, or ask the admin/governance process to resume it. | `tests_error_cases::test_err_contract_paused` |
| 27 | `DueDateTooSoon` | The due date is earlier than the minimum allowed horizon. | Invoice due date was set too close to the current ledger time. | Choose a later due date that satisfies the contract's minimum lead time. | `tests_error_cases::test_err_due_date_too_soon` |
| 28 | `DueDateTooFar` | The due date is later than the maximum allowed horizon. | Invoice due date was set too far in the future. | Reduce the due date to fall within the contract's configured maximum range. | `tests_error_cases::test_err_due_date_too_far` |
| 29 | `SelfInvoice` | The payer and invoice creator are the same address. | A caller attempted to create an invoice against themselves. | Use distinct payer and submitter addresses, or fix the invoice data before resubmitting. | `tests_error_cases::test_err_self_invoice` |
| 30 | `OverpaymentRejected` | The payment amount exceeds the remaining amount due. | Payer attempted to pay more than the invoice balance. | Pay exactly the remaining amount or query the outstanding balance first. | `tests_error_cases::test_err_overpayment_rejected` |
| 31 | `PayerReputationTooLow` | The payer's reputation is below the configured minimum threshold. | Reputation gate is enabled and the payer score does not meet the contract requirement. | Improve the payer's reputation score, or adjust the minimum threshold through the approved governance/admin path. | `tests_error_cases::test_err_payer_reputation_too_low` |
| 32 | `ArithmeticOverflow` | A checked arithmetic operation overflowed. | Large amounts, counters, or computed values exceeded `u64`/`i128` limits during processing. | Re-check inputs for unreasonable values and investigate the caller data or contract math path. | `tests_error_cases::test_err_arithmetic_overflow` |
| 33 | `FeeOnTransferToken` | The token charges a transfer fee, so the received amount differs from the amount sent. | An unsupported fee-on-transfer asset was added or used for settlement. | Use a standard token that transfers the full amount, or remove the fee-on-transfer asset from configuration. | `tests_error_cases::test_err_fee_on_transfer_token` |
| 34 | `PayerUnverified` | The oracle did not verify the payer when verification was required. | Oracle verification is enabled, but the payer is not present or not verified in the oracle response. | Use a verified payer account, or disable payer verification if that policy is not required. | `tests_error_cases::test_err_payer_unverified` |
| 35 | `OracleDataStale` | The oracle response is older than the configured freshness window. | The payer-verification oracle data has exceeded `max_oracle_age_ledgers`. | Refresh oracle data and retry, or increase the freshness window only if that tradeoff is acceptable. | `tests_error_cases::test_err_oracle_data_stale` |
| 36 | `AmountTooSmall` | The invoice amount is below the configurable minimum threshold. | The submitted invoice amount is too low to be economically viable. | Increase the invoice amount to meet the minimum required by the contract configuration. | `tests_error_cases::test_err_amount_too_small` |
| 37 | `Reentrancy` | Reentrant call detected. | Function was invoked while another state-mutating execution frame is already active. | Eliminate nested calls across untrusted boundaries. | `tests_error_cases::test_err_reentrancy` |
| 38 | `RateLimited` | Rate-limited function called before cooldown elapsed. | Rapid successive administrative or economic configuration changes. | Wait for the required cooldown interval between administrative calls. | `tests_error_cases::test_err_rate_limited` |
| 39 | `QueueNotMature` | Queue resolution attempted prior to the mandatory maturity delay. | Invoking `resolve_fund_queue` before `QUEUE_DELAY_LEDGERS` have passed since initial queue join. | Wait until the queue delay window matures before resolving. | `tests_error_cases::test_err_queue_not_mature` |

---

## 2. `insurance_pool` — `InsuranceError`

Source of truth: [`contracts/insurance_pool/src/lib.rs`](../contracts/insurance_pool/src/lib.rs)

| Code | Variant | Description | Common Cause | Recommended Remediation | Verifying Test |
|------|---------|-------------|--------------|--------------------------|----------------|
| 1 | `NotInitialized` | Contract has not been initialised with an admin. | `initialize()` was never called, or was called and failed. | Call `initialize()` with a valid admin address and positive coverage cap. | `test::test_err_not_initialized` |
| 2 | `AlreadyClaimed` | A claim has already been processed for this invoice. | Duplicate claim attempt for the same invoice ID. | Check `is_claimed()` before filing; each invoice can only be claimed once. | `test::claim_cannot_be_called_twice_for_same_invoice` |
| 3 | `InvalidAmount` | Premium / coverage amount must be positive. | Zero or negative amount passed to `deposit_premium` or `initialize`. | Send a positive stroop amount. | `test::initialize_requires_positive_coverage_cap` |
| 4 | `PoolEmpty` | Pool has no balance available to pay a claim. | All premiums have been paid out or the pool was never funded. | LPs must deposit premiums before claims can be paid. | `test::claim_rejected_when_pool_is_empty` |
| 5 | `AlreadyInitialized` | Contract is already initialised. | `initialize()` called more than once. | Initialisation is one-shot; redeploy if a fresh pool is needed. | `test::initialize_cannot_be_called_twice` |
| 6 | `NoPendingProposal` | No pending proposal exists for the requested admin action. | `execute_coverage_change` / `execute_admin_transfer` / `cancel_*` called with no queued proposal. | Queue a proposal first via `propose_coverage_change` or `propose_admin_transfer`. | `test::execute_coverage_change_rejects_when_no_pending_proposal` |
| 7 | `TimelockNotExpired` | The proposal's timelock has not yet expired. | Attempted to execute a timelocked action before the delay elapsed. | Wait until `env.ledger().timestamp() >= eta` and retry. | `test::execute_coverage_change_rejects_before_timelock_expires` |
| 8 | `ArithmeticOverflow` | A checked arithmetic operation overflowed. | Accumulation of balances exceeding `i128::MAX`. | Ensure deposit amounts are within sane bounds. | `test::test_err_arithmetic_overflow` |
| 9 | `BalanceCapExceeded` | Premium deposit would push pool balance above cap. | Admin has set a `BalanceCap` and deposit exceeds it. | Reduce deposit amount or raise balance cap. | `test::test_err_balance_cap_exceeded` |

---

## 3. `iln_governance` — `GovernanceError`

Source of truth: [`contracts/iln_governance/src/lib.rs`](../contracts/iln_governance/src/lib.rs)

| Code | Variant | Description | Common Cause | Recommended Remediation | Verifying Test |
|------|---------|-------------|--------------|--------------------------|----------------|
| 1 | `AlreadyInitialized` | Contract was initialized more than once. | Deployment script ran initialization twice. | Run initialization only once per deployment. | `test::test_err_already_initialized` |
| 2 | `ProposalNotFound` | The specified proposal ID does not exist. | Invalid proposal ID or proposal was never created. | Verify proposal ID via `get_proposal`. | `test::test_proposal_not_found` |
| 3 | `VotingEnded` | Voting period for this proposal has ended. | Attempted to cast vote after window closed. | Vote within configured voting period. | `test::test_err_voting_ended` |
| 4 | `ProposalNotActive` | Proposal is not in `Active` status. | Action requires active status but proposal is resolved/vetoed. | Check proposal status before acting. | `test::test_err_proposal_not_active` |
| 5 | `NoVotingPower` | Voter has no governance token balance at snapshot. | Voter held no tokens when proposal was created. | Acquire governance tokens before proposal creation. | `test::test_err_no_voting_power` |
| 6 | `AlreadyVoted` | Address has already voted on this proposal. | Double-vote attempt on same proposal. | Each address may vote once per proposal. | `test::test_err_already_voted` |
| 7 | `VotingOngoing` | Proposal's voting period is still in progress. | Attempted to execute proposal before voting ended. | Wait for voting period to end. | `test::test_err_voting_ongoing` |
| 8 | `QuorumNotReached` | Proposal did not meet minimum participation threshold. | Insufficient total votes relative to token supply. | Encourage more token holders to vote. | `test::test_quorum_not_reached_rejects_execution` |
| 9 | `ProposalRejected` | Proposal was rejected (more votes against than for). | More weight voted against proposal. | Revise proposal and resubmit. | `test::test_err_proposal_rejected` |
| 10 | `AlreadyResolved` | Proposal has already been resolved. | Action on a proposal in a terminal state. | No further action is possible on resolved proposal. | `test::test_already_resolved` |
| 11 | `CannotDelegateToSelf` | Delegating to self is not allowed. | `delegate_votes` called with `to == caller`. | Delegate to a different address. | `test::test_err_cannot_delegate_to_self` |
| 12 | `DelegationCyclePrevented` | Delegation would create a circular dependency. | Delegating A → B → A. | Break delegation chain before delegating. | `test::test_err_delegation_cycle_prevented` |
| 13 | `TimelockNotExpired` | Execution timelock has not yet expired. | Executing passed proposal before execution delay. | Wait for timelock delay before executing. | `test::test_timelock_not_expired` |
| 14 | `Unauthorized` | Caller does not have required role. | Wrong account signed transaction. | Verify signing account matches required role. | `test::test_unauthorized_action` |
| 15 | `InvalidQuorumBps` | Invalid quorum basis points (must be 1..=10,000). | Admin set quorum outside valid range. | Set quorum between 1 and 10,000 basis points. | `test::test_err_invalid_quorum_bps` |
| 16 | `NotAdmin` | Caller is not the contract admin. | Non-admin attempted admin-only action. | Use admin account. | `test::test_err_not_admin` |
| 17 | `NotVetoable` | Proposal cannot be vetoed in its current status. | Admin attempted to veto inactive proposal. | Veto only active proposals. | `test::test_veto_non_active_proposal` |
| 18 | `VetoPowerDisabled` | Admin veto power has been disabled by governance. | Admin veto disabled via governance action. | Re-enable veto via governance before using. | `test::test_veto_power_disabled` |
| 19 | `InsufficientProposerBalance` | Proposer does not hold minimum required tokens. | Proposer balance below `MinProposalBalance`. | Acquire sufficient governance tokens. | `test::test_insufficient_proposer_balance` |
| 20 | `ExecutionFailed` | Target contract call failed during proposal execution. | Action reverted on downstream contract. | Investigate downstream failure cause. | `test::test_execute_proposal_failure_emits_event` |

---

## 4. `reputation_bonus` — `ContractError`

Source of truth: [`contracts/reputation_bonus/src/errors.rs`](../contracts/reputation_bonus/src/errors.rs)

| Code | Variant | Description | Common Cause | Recommended Remediation | Verifying Test |
|------|---------|-------------|--------------|--------------------------|----------------|
| 1 | `ArithmeticError` | Arithmetic overflow/underflow during score computation. | Extreme value ranges. | Maintain inputs within standard bounds. | `reputation_bonus::test_err_reputation_arithmetic_errors` |
| 2 | `InvoiceNotFound` | Invoice ID not found in reputation bonus storage. | Querying or paying invalid invoice ID. | Submit invoice first or check invoice ID. | `reputation_bonus::test_err_reputation_invoice_not_found` |
| 3 | `IllegalState` | Invoice is not in the required state for the action. | Marking paid on already settled invoice. | Verify invoice status before settlement. | `reputation_bonus::test_err_reputation_illegal_state` |
| 4 | `ConfigErrorUnauthorized` | Caller is not authorized to update configuration. | Non-admin attempting to update parameters. | Use configured admin address. | `reputation_bonus::test_err_reputation_config_unauthorized` |
| 5 | `ConfigErrorInvalidBonusBps` | Bonus basis points exceed configured ceiling. | Supplying `bonus_bps > 500`. | Keep bonus BPS $\le 500$. | `reputation_bonus::test_err_reputation_invalid_bonus_bps` |
| 6 | `ConfigErrorInvalidMinDiscountRate` | Minimum discount rate is zero or invalid. | Supplying `min_discount_rate_bps == 0`. | Set minimum discount rate $> 0$. | `reputation_bonus::test_err_reputation_invalid_min_discount` |
| 7 | `RateErrorArithmeticUnderflow` | Arithmetic underflow in rate calculation. | Calculations resulting in negative rates. | Ensure bonus does not exceed rate floor. | `reputation_bonus::test_err_reputation_arithmetic_errors` |
| 8 | `RateErrorArithmeticOverflow` | Arithmetic overflow in rate calculation. | Mathematical overflow on large values. | Ensure parameters remain within bounds. | `reputation_bonus::test_err_reputation_arithmetic_errors` |

---

## 5. `iln_distribution`

`iln_distribution` implements continuous reward accrual and distribution math using native Soroban invariants and panic guards (`panic_with_error!` / checked arithmetic). Coverage is verified by `tests/` in the crate root.
