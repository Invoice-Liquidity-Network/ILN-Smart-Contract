# Governance execution ETA and replay-protection audit (Issue #1206)

Scope: `execute_proposal`, the queue (`Active -> Passed`) and execute
(`Passed -> Executed`) steps, the timelock ETA, replay protection, veto and
stale proposals. Code: `contracts/iln_governance/src/lib.rs`. Regression
tests: `contracts/iln_governance/tests/audit_1206_execution_eta.rs`.

## 1. State machine

`execute_proposal(id)` is permissionless and is two-phase:

1. **Queue** (`Active`, voting window closed): tallies are validated, quorum
   and majority are evaluated, then either
   * `Rejected` is committed and `proposal_rejected` is emitted (returns `Ok`),
     or
   * the proposal becomes `Passed` with
     `eta_ledger = current_ledger + applied_delay`.
2. **Execute** (`Passed`, `current_ledger >= effective eta`): the cross-contract
   call runs; on success the proposal becomes `Executed`.

Checks run in this order: paused → load/`ProposalNotFound` → `Vetoed` →
`Executed` → voting still open → status branch.

| Case | Result |
| --- | --- |
| Paused | `ContractPaused` |
| Unknown id | `ProposalNotFound` |
| Vetoed (any time, even after eta) | `ProposalCancelled` |
| Already executed (replay) | `ProposalAlreadyExecuted` |
| Voting window open | `VotingOngoing` |
| `Passed`, `ledger < effective eta` | `TimelockNotExpired` |
| `Passed`, `ledger >= effective eta` | executes |
| `Rejected` re-called | `AlreadyResolved` |
| Cross-contract call fails | returns `Ok`, emits `proposal_execution_failed`, stays `Passed` (retryable, eta unchanged, nonce unchanged) |

Failure returns `Ok` deliberately: Soroban discards the events and writes of a
call that returns `Err` (Issue #1007).

## 2. ETA computation

* `applied_delay = max(created_delay, current effective delay)` where
  `created_delay` is the delay pinned at `create_proposal` (Issue #982) and the
  effective delay is floored at `MIN_PRODUCTION_EXECUTION_DELAY_LEDGERS` once
  the veto is disabled.
* `eta = current_ledger + applied_delay` using **checked** addition; overflow
  aborts with `InvalidTimelock` (never saturates).
* The queue records `ProposalTimelockPolicy{queued, queued_version,
  queued_ledger, applied_delay}`.
* **Effective eta at execution:** if the timelock policy version is unchanged
  since queueing, `eta_ledger`; otherwise
  `max(eta_ledger, queued_ledger + current_delay)`. A policy change can
  lengthen but never shorten a queued proposal's delay. A proposal queued by a
  pre-#982 build (no snapshot) fails closed to `eta_ledger + current_delay`.
* The comparison is on the **ledger sequence** (`ledger.sequence()`), not the
  timestamp; the voting window is on the timestamp.
* `set_execution_delay` is bounded by `MAX_EXECUTION_DELAY_LEDGERS`
  (`InvalidExecutionDelay`) and refuses a *reduction* while any scheduled eta
  is still in the future (`DelayReductionBypassesScheduled`, via
  `MaxScheduledEta`).

## 3. Replay protection

On success the contract writes `ProposalExecutedRecord(id) = true` and
increments `ExecutionNonce`; the status is the primary guard
(`Executed -> *` is not a legal transition) and the record is a permanent
second witness. Repeated calls return `ProposalAlreadyExecuted` and do not
change the nonce. Failed executions neither set the record nor bump the nonce.

## 4. Verified behaviours pinned by tests

* Execute during voting, before eta (same ledger and `eta - 1`), at `eta`.
* Creation-time delay is a floor even if the delay is lowered during voting.
* Raising the delay after queueing extends the effective eta.
* Delay reduction is refused while a proposal is scheduled.
* Replay, nonce accounting, unknown id.
* Veto of a queued proposal stays final after eta.
* Pause blocks execution and unpausing does not skip the timelock; only the
  stored admin can pause.
* Failed call is retryable and keeps its eta.
* Quorum miss / majority-against commit `Rejected` and are terminal.

## 5. Residual risks (verified, not changed)

1. **No expiry for `Passed` proposals.** There is an earliest-execution ledger
   but no latest one. Anyone can execute a stale proposal arbitrarily long
   after its eta (`residual_risk_passed_proposal_has_no_expiry`). After the
   veto is disabled there is no on-chain cancel. A grace-period/expiry would be
   an API change.
2. **Permissionless execution.** Any account may trigger queue and execute;
   timing is therefore attacker-selectable within the allowed window.
3. **Failed execution loop.** A permanently failing target leaves the proposal
   `Passed` forever; each retry emits `proposal_execution_failed`.
4. **Instance-storage growth.** `MaxScheduledEta` and per-proposal veto state
   are bounded, but `VetoState(id)` lives in instance storage (see the veto
   audit).
5. `compute_eta` (rollover-wrapping) is exposed but not used by
   `execute_proposal`, which uses checked addition (#995). Ledger sequence
   rollover (`u32`) is not a practical concern.
