# Governance parameter-setter ILN gating audit

**Scope:** `contracts/iln_governance/src/lib.rs` (`execute_proposal` and the
`set_*` setters) and the callee-side gates it depends on in
`invoice_liquidity`, `iln_distribution`, `insurance_pool` and
`reputation_bonus`.

**Question:** when an ILN parameter changes through governance, is it
*governance execution* that authorizes the change, or could an unrelated admin
signature do it?

Findings are split into **verified** (read in code and/or covered by a test)
and **residual risk** (depends on deployment wiring, not enforced by code).

## 1. Authorization model

Soroban gives a contract implicit authorization for its own direct
sub-invocations. `execute_proposal` calls the target with
`env.try_invoke_contract` and passes no signature, so the **callee** decides
whether "governance contract as direct caller" is enough. The callee only
accepts it if the address it checks with `require_auth()` *is* the governance
contract address.

| Path | Gate in governance | Gate in callee | Who must be the governance contract |
| --- | --- | --- | --- |
| `UpdateFeeRate`, `UpdateMaxDiscountRate`, `UpdateDecayParams`, `UpdateFeeTiers`, `Upgrade`, `AddToken`, `RemoveToken`, `UpdateMaxInvoiceAmount`, `UpdateTokenVolumeCap` | proposal state machine (below) | `invoice_liquidity::access::require_admin` → stored `Admin.require_auth()` | ILN `Admin` |
| `RegisterOracle`, `RemoveOracle`, `RegisterTokenOracle` | same | oracle registry admin check | ILN `Admin` |
| `UpdateReputationBonusParams` | same | `reputation_bonus::update_config`: `caller.require_auth()` **and** `caller == stored admin`; governance passes its own address as `caller` | `reputation_bonus` admin |
| `UpdateLpRewardRate`, `UpdateFreelancerRewardRate`, `UpdatePayerRewardRate` | same | `iln_distribution::require_governance_invoker` → bound `IlnContract.require_auth()` | the address bound as `IlnContract` in the distribution contract |
| `UpdateInsuranceCoverageCap`, `UpdateInsurancePremiumRate` | same | `insurance_pool` stored `Admin.require_auth()` | insurance pool `Admin` |

`execute_proposal` has **no caller authentication by design**: any account may
trigger a due proposal. Authority comes from the proposal reaching `Passed`
and the timelock having elapsed, not from who submits the transaction.

### Execution preconditions (all verified in `execute_proposal`)

1. Not paused (`ContractPaused`).
2. Not `Vetoed` (`ProposalCancelled`) and not already `Executed`
   (`ProposalAlreadyExecuted`).
3. `now >= voting_end` (`VotingOngoing` otherwise).
4. `Active -> Passed` only with a valid tally, quorum from the stored
   `GovTokenTotalSupply` (never caller-supplied) and `votes_for > votes_against`.
5. `Passed -> Executed` only when `ledger.sequence >= effective_eta_ledger`
   (`TimelockNotExpired` otherwise).

## 2. Verified findings

| # | Finding | Evidence |
| --- | --- | --- |
| V1 | With ILN `Admin` == governance contract, governance execution authorizes the setter and nothing else is needed; with all mocked auths dropped the change still applies. | `governance_as_iln_admin_executes_without_mocked_auths` |
| V2 | With ILN `Admin` == governance contract, a direct call to the setter from anyone else is rejected. | `direct_call_to_admin_setter_without_governance_is_rejected` |
| V3 | If ILN `Admin` is *not* governance, governance execution fails closed: proposal stays `Passed`, `proposal_execution_failed` is emitted, ILN state is unchanged, retries have no side effects. | `governance_not_iln_admin_cannot_execute_and_emits_failure_event`, `rejected_execution_can_be_retried_without_side_effects` |
| V4 | A proposal rejected by voters never reaches ILN and cannot be re-executed (`AlreadyResolved`). | `rejected_proposal_never_calls_iln` |
| V5 | Timelock boundary: `eta - 1` refused, `eta` accepted, under real cross-contract auth. | `execution_delay_boundary_with_real_cross_contract_auth` |
| V6 | **The ILN setters authorize "the stored admin", not "governance".** If that admin is an externally-owned key, that key's signature changes ILN parameters with no proposal, vote or timelock. The code cannot tell the two apart. | `externally_owned_iln_admin_can_bypass_governance` (documents the behaviour) |
| V7 | The governance contract's own setters (`set_min_quorum_bps`, `set_max_delegation_depth`, `set_gov_token_total_supply`, `set_min_proposal_deposit`, `set_min_proposal_balance`, `set_quadratic_voting_enabled`, `set_proposal_deposit_sink`) are gated on `iln_contract.require_auth()`, i.e. they can only be authorized by the ILN contract acting as direct caller. `set_execution_delay`, `pause`, `unpause` use the stored governance `Admin` signature instead. | `contracts/iln_governance/src/lib.rs` |

## 3. Residual risk and follow-ups (not changed in this PR)

These are observed in code but depend on deployment wiring or touch other
contracts, so they are reported rather than fixed here.

- **R1 – admin/governance split is a deployment invariant, not enforced.**
  Mainnet must set ILN `Admin`, `reputation_bonus` admin and insurance pool
  `Admin` to the governance contract address (V6). Add it to the launch
  checklist and verify it on-chain after deployment.
- **R2 – distribution wiring.** The reward-rate setters require auth of the
  address bound as `IlnContract` in `iln_distribution`. Governance is not the
  ILN contract, so `UpdateLpRewardRate` / `UpdateFreelancerRewardRate` /
  `UpdatePayerRewardRate` only succeed if the distribution contract was
  initialised with the governance address in that slot. Otherwise they fail
  closed (proposal stays `Passed`).
- **R3 – `UpdateDistributionRewardParams` targets `update_reward_params`,
  which does not exist in `iln_distribution`.** Execution can never succeed
  against the real contract; it fails closed (V3 behaviour). Existing
  governance tests pass only because `MockIln` defines the function.
- **R4 – insurance actions are routed to the ILN contract address.**
  `UpdateInsuranceCoverageCap` / `UpdateInsurancePremiumRate` call
  `set_coverage_via_governance` / `set_premium_rate_via_governance` on
  `get_iln_contract`, but those functions exist on `insurance_pool`, not
  `invoice_liquidity`. Governance has no separate insurance-pool address, so
  these actions fail closed unless the ILN address points at a contract
  exposing them.
- **R5 – `UpdateFeeTiers` argument shape.** Governance sends
  `Vec<FeeTierConfig>` (struct) while ILN `update_fee_tiers` takes
  `Vec<(i128, u32)>` (tuple). Verify the encodings match before relying on the
  action.
- **R6 – `invoice_liquidity::access::require_governance` always returns
  `Unauthorized`.** It is not used by any setter, so it is dead code, but it
  reads as if a governance gate existed. Do not rely on it.

R2–R5 are all **fail-closed**: none lets an unauthorized party change a
parameter. They affect liveness of governance actions, not safety.

## 4. Success and failure behaviour

| Case | Result |
| --- | --- |
| Normal: passed proposal, timelock elapsed, governance is callee admin | callee setter runs, status `Executed`, `ProposalExecuted` emitted |
| Repeated: execute an `Executed` proposal | `ProposalAlreadyExecuted`, no callee call |
| Repeated: retry after callee refusal | proposal stays `Passed`, `proposal_execution_failed` emitted each time, no state change |
| Unauthorized: direct call to a callee setter by a non-admin | callee `require_auth` fails, nothing written |
| Unauthorized: callee admin is an EOA (V6) | EOA can change the parameter directly; governance execution fails closed |
| Stale: `now < voting_end` | `VotingOngoing` |
| Stale: `sequence < eta` | `TimelockNotExpired` |
| Interrupted: callee traps or returns an error | caught by `try_invoke_contract`; proposal not marked `Executed`; retryable |
| Paused / vetoed | `ContractPaused` / `ProposalCancelled` |

## 5. Reviewing

```bash
cargo test -p invoice_liquidity --test governance_cross_contract_auth_test
```
