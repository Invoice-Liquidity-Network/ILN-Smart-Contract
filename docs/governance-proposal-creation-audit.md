# Governance proposal-creation authorization audit (Issue #1204)

Scope: `create_proposal` and the parameters that gate it in
`contracts/iln_governance/src/lib.rs`. Regression tests:
`contracts/iln_governance/tests/audit_1204_proposal_creation.rs`.

Findings are split into **verified** (observed in code and pinned by a test),
**fixed in this change**, and **residual risk** (verified, deliberately not
changed because the fix is an API/behaviour change).

## 1. Authorization and failure behaviour

| Condition | Result |
| --- | --- |
| `proposer` did not authorize the call | host auth failure (no state change) |
| Contract not initialized | `NotInitialized` |
| Live token balance `< MinProposalBalance` (default `1_000`) | `InsufficientProposerBalance` |
| Deposit configured (`> 0`) and live balance `< deposit` | `InsufficientProposerBalance` |
| Deposit transfer fails | whole call reverts (proposal, snapshot and ids roll back) |
| Otherwise | new `Active` proposal, id = `ProposalCount + 1` |

Any `Err` return reverts every write of the call, so a rejected creation leaves
no partial proposal, snapshot, checkpoint or deposit behind.

## 2. What is recorded at creation

| Data | Key | Notes |
| --- | --- | --- |
| Proposal (status `Active`, tallies `0`, `eta_ledger = 0`) | `Proposal(id)` | `voting_end = now + 259_200 s` |
| Proposer identity | `ProposalProposer(id)` | immutable; re-verified on veto |
| Snapshot ledger | `ProposalCreatedLedger(id)` | reference point for checkpoint eligibility (see #1205) |
| Proposer vote weight | `VoteWeightSnapshot(id, proposer)` | the proposer's **live** balance at creation |
| Proposer checkpoint | `BalanceCheckpoint(proposer)` | seeded only when absent; an older checkpoint is never overwritten |
| Timelock policy | `ProposalTimelockPolicy(id)` | delay/version/veto flag in force at creation (#982) |
| Deposit | `ProposalDeposit(id)` | only when `MinProposalDeposit > 0` |

## 3. Thresholds

* The proposer gate reads the **live** balance (not a checkpoint), so moving
  funds away before creating drops the proposer below the gate.
* **Fixed:** `set_min_proposal_balance` previously accepted `0` or negative
  values, which silently disabled the gate (any account, even with no tokens,
  could create proposals). It now rejects `min_balance <= 0` with
  `InvalidMinProposalBalance` (error `48`); a rejected write leaves the gate
  unchanged. Existing stored values are not migrated.
* `set_min_proposal_deposit` already rejects negatives
  (`InvalidProposalDeposit`).

## 4. Quorum

Quorum is **not** evaluated or snapshotted at creation. It is computed in
`execute_proposal` as `GovTokenTotalSupply * MinQuorumBps / 10_000`, using the
values stored *at execution time*. A change to the tracked supply or to
`MinQuorumBps` between creation and execution therefore applies to in-flight
proposals (pinned by `quorum_is_read_at_execution_not_at_creation`). Both
setters are gated by the ILN contract, so this is a governance-controlled input
rather than a caller-controlled one. A quorum miss commits `Rejected` and emits
`proposal_rejected` (see #1206 audit).

## 5. Duplicate proposals

There is no de-duplication: identical `(proposer, action, description_hash,
proposed_value)` tuples create independent proposals with sequential ids.
The only cost-based brake is the optional deposit, escrowed **per proposal**
(`each_duplicate_escrows_its_own_deposit`).

## 6. Residual risks (not changed)

1. **Live-balance gate and un-aged proposer snapshot.** The proposer's balance
   is read live and also becomes their vote weight on their own proposal,
   without the aged-checkpoint requirement that applies to other voters.
   Mitigation in place: the forfeitable deposit (escrowed from real funds).
   While the deposit is `0` (the default) a borrowed balance can satisfy the
   gate. Recommendation: set a non-zero `MinProposalDeposit` before mainnet.
2. **Duplicate spam** while the deposit is `0` is bounded only by
   `MinProposalBalance`.
3. **Quorum inputs are not per-proposal.** See section 4.
4. `proposed_value` is stored but not validated against `action_type` at
   creation; the action payload is what `execute_proposal` uses.

## 7. Build restoration included with this change

On `dev`, `contracts/iln_governance/src/lib.rs` did not compile after a series
of merges (missing `VetoState`/`VetoStatus`/`VetoDisableRecord` types, the
`TimelockNotActive` error, `TimelockPolicyVersion`/`ProposalTimelockPolicy`
storage keys, `MAX_EXECUTION_DELAY_LEDGERS`, and broken
`set_execution_delay`/`execute_proposal` bodies). These were restored from git
history so the audit could be verified against a compiling contract:

* `TimelockNotActive` is restored as error `47` (code `29` is
  `InvalidStateTransition` in the current enum; `docs/error-codes.md` is
  updated).
* `execute_proposal` again commits `Rejected` and emits `proposal_rejected`
  (Issue #1007) instead of returning an `Err` that Soroban rolls back; two
  stale tests that asserted the old behaviour were updated.
* Duplicate test helper/test names in `src/test.rs` were removed.
