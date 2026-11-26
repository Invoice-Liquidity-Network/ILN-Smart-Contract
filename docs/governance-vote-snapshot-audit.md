# Governance vote snapshot audit (Issue #1205)

Scope: how `cast_vote` derives a voter's weight, and whether flash-loan
balances can influence a vote. Code: `contracts/iln_governance/src/lib.rs`
(`cast_vote`, `checkpoint_balance`, `proven_own_balance`,
`eligible_checkpoint`). Regression tests:
`contracts/iln_governance/tests/audit_1205_vote_snapshot.rs`.

## 1. Data sources

Soroban token contracts expose no "balance at ledger N" query, so the contract
builds its own snapshot out of explicit checkpoints:

* `checkpoint_balance(voter)` (voter-authorized) records the voter's live
  balance and the current ledger. A refresh demotes the replaced checkpoint to
  a single prior slot (`PriorBalanceCheckpoint`), so at most two checkpoints
  exist per voter.
* `create_proposal` records `ProposalCreatedLedger(id)` — the proposal's
  snapshot ledger.
* A checkpoint is **eligible for proposal `P`** iff
  `checkpoint.ledger + MIN_VOTE_HOLD_LEDGERS (10) <= created_ledger(P)`. Of the
  eligible slots the newest wins.

## 2. Weight rules (verified)

| Voter | Weight |
| --- | --- |
| Proposer | `VoteWeightSnapshot` = live balance at `create_proposal`; later transfers or top-ups do not change it |
| Anyone else | `min(eligible checkpoint balance, live balance at vote time)`, then frozen in `VoteWeightSnapshot` |
| Plus | `DelegatedToMe(voter)` read live at vote time |
| Quadratic voting on | `isqrt(own + delegated)` |

Outcomes: no eligible checkpoint → `InsufficientHoldingPeriod`; weight `0` →
`NoVotingPower`; already voted (temporary receipt **or** durable
`VoteReceipt`) → `AlreadyVoted`; window closed → `VotingEnded`; unknown id →
`ProposalNotFound`; non-`Active` → `ProposalNotActive`.

## 3. Flash-loan resistance (verified)

* A balance acquired immediately before voting has no checkpoint, or only a
  too-young one → rejected (`flash_funded_voter_without_checkpoint_cannot_vote`).
* A checkpoint taken after creation is measured against the proposal's
  creation ledger, so waiting does not help for *that* proposal
  (`checkpoint_recorded_after_creation_is_ineligible`).
* The `+10` boundary is exact (`holding_period_boundary_is_exact`).
* A top-up after checkpointing is capped by the checkpoint; funds moved away
  are capped by the live balance (`weight_is_capped_by_*`).
* Re-checkpointing with inflated funds after creation cannot replace the
  older eligible checkpoint (`refreshing_checkpoint_after_creation_*`).
* The vote weight is frozen at the first vote; moving tokens afterwards does
  not change it, and the second vote is rejected.

## 4. Residual risks (verified, not changed)

1. **Token recycling between two aged checkpoints.** Weight is
   `min(checkpoint, balance *at vote time*)`, not the balance at the proposal
   ledger. If A checkpoints `X`, sends it to B, and B checkpoints `X` (both at
   least 10 ledgers before creation), then after creation B can vote, return
   `X` to A, and A can vote: `X` tokens yield `2X` votes. Each additional
   cooperating address with an aged checkpoint extends the effect. Pinned by
   `residual_risk_recycling_tokens_between_two_aged_checkpoints_double_counts`.
   Closing this needs token-side snapshots or a vote lock/escrow, which is an
   API and token-integration change.
2. **Delegation is live, not snapshotted.** `DelegatedToMe` is read at vote
   time and a delegation made after creation counts
   (`residual_risk_delegation_after_creation_counts_toward_vote`). The
   delegated amount is the delegator's proven balance *at delegation time* and
   is not re-checked if the delegator later moves the tokens.
3. **Quadratic-voting toggle is global.** `QuadraticVotingEnabled` is read at
   each vote, so toggling it mid-window gives later voters a different weight
   function than earlier ones.
4. **Proposer weight is un-aged** (see #1204 audit, residual risk 1).

## 5. Assumptions

* The governance token is a well-behaved SEP-41 token (no fee-on-transfer, no
  rebasing).
* `GovTokenTotalSupply` is maintained by the ILN contract; it is not read from
  the token.
