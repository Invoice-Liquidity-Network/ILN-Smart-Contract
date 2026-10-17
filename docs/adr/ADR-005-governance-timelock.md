# ADR-005: Governance Timelock Length (No Timelock in v1)

**Date:** 2024-05-01  
**Status:** Accepted

## Context

After a governance proposal passes (quorum met, majority in favour), there is a
window between the vote closing and the proposal being executed on-chain. A
**timelock** is a mandatory delay in that window that gives the community time
to react — exit positions, raise objections, or prepare for the change — before
it takes effect.

The ILN governance contract (`iln_governance`) executes proposals via
`execute_proposal`, which cross-contract-calls the ILN contract to apply the
change atomically. The team had to decide how long the timelock delay should be.

Competing concerns:

- **Security** — a longer delay gives more time to detect and respond to a
  malicious or erroneous proposal.
- **Agility** — a shorter delay lets the protocol respond quickly to market
  conditions (e.g. adjusting fee rates during a crisis).
- **Admin veto as substitute** — the governance contract already has an
  emergency veto (`veto_proposal`) that can block any `Active` or `Passed`
  proposal before execution. This provides a safety net that partially
  substitutes for a timelock during the early protocol phase. **Update
  (Issue #642):** veto authority is now multisig-gated — `veto_proposal`
  requires a configurable threshold of `VetoSigners` to approve (via
  `configure_veto_multisig`) rather than a single admin key, closing the
  "admin single point of failure" finding from the threat model. The rest of
  this ADR's reasoning (veto as timelock substitute, disable-before-mainnet
  plan) is otherwise unchanged.
- **Protocol maturity** — at launch, the governance token distribution is
  concentrated; a long timelock would slow down necessary parameter tuning
  without providing meaningful decentralisation benefits.

## Decision

**Phase 3 Timelock Implementation and Hardening (Issues #983, #984, #986, #988).**

While v1 initially launched without an execution delay, ADR-012 Phase 3 established a governance execution timelock with the following critical security controls:

1. **Configurable Execution Delay & Queue Ordering (Issue #983):**
   `set_execution_delay(delay)` configures the delay between proposal passing and execution. To prevent delay reductions from bypassing scheduled proposals, reductions are blocked while pending proposals remain in timelock (`DelayReductionBypassesScheduled`), and newly scheduled proposals cannot receive an `eta_ledger` earlier than any previously scheduled proposal.
2. **Emergency Pause Semantics Without Timelock Bypass (Issue #984):**
   Governance provides `pause()` / `unpause()` controls for emergency incident response. Crucially, emergency pause **cannot skip timelock**: proposal execution is blocked while paused, and unpausing continues to enforce `current_ledger >= proposal.eta_ledger` strictly without shortcuts.
3. **Replay Protection for Delayed Executions (Issue #986):**
   Delayed proposal executions are guarded against replay via persistent `ProposalExecutedRecord(proposal_id)` records and monotonic `ExecutionNonce` counters. Attempting to re-execute a completed proposal fails fail-closed with `ProposalAlreadyExecuted`.
4. **Explicit Consent for Veto Transitions (Issue #988):**
   The multisig veto mechanism (`veto_proposal`) enforces explicit consent: signers must provide a non-empty `reason_hash` (`ConsentRequired`) and all approving signers must consent to the exact same `reason_hash` (`VetoReasonMismatch`), preventing ambiguous or conflicting veto approvals.

## Alternatives Considered

| Alternative | Why rejected |
|-------------|--------------|
| **24-hour timelock** | Adds friction without meaningful security benefit while the admin veto exists; a 24-hour window is too short for large token holders to coordinate a response anyway. |
| **48-hour timelock** | Same reasoning as 24-hour; the admin veto already covers the early phase. |
| **7-day timelock (Compound-style)** | Appropriate for a mature, decentralised protocol, but excessive for a protocol in active parameter tuning. Would slow down legitimate fee adjustments. |
| **Configurable timelock (governance sets the delay)** | Implemented in Phase 3 with strict delay-reduction bounds and FIFO scheduling protection (Issue #983). |
| **Optimistic execution with challenge period** | Complex to implement correctly; requires a separate challenge mechanism and bond. Out of scope for v1. |

## Consequences

**Positive:**
- Proposals are safely timelocked, allowing token holders and participants to react before state changes execute.
- Delay reductions cannot manipulate or bypass execution queue order.
- Emergency pause controls provide incident containment without introducing backdoors to bypass timelocks.
- Replay protection guarantees that delayed proposal execution is strictly idempotent and one-time.
- Explicit multisig consent ensures transparent, unified veto reasoning.

**Negative / Trade-offs:**
- Execution requires two transactions when delay > 0 (one to pass and queue, one to execute after delay).
- Admin veto must still be formally disabled via governance proposal prior to final mainnet decentralization.

