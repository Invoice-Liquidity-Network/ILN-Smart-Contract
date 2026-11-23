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

**No timelock delay in v1; configurable timelock activated in Phase 3 / Wave 9.**
Initially in v1, `execute_proposal` was callable immediately after the 3-day voting window closed, provided quorum and majority criteria were met, with admin veto power serving as an emergency brake.

Per the protocol roadmap, timelock enforcement was activated prior to disabling admin veto power. In Wave 9 (Issues #978, #979, #980), timelock mechanics were hardened against audit failure modes:
1. **Immutable Proposal Delay (#978)**: Delay configuration is snapshotted into `StorageKey::ProposalExecutionDelay(id)` at proposal creation (`create_proposal`). Global changes via `set_execution_delay` apply only to future proposals and cannot retroactively compress or extend the delay of in-flight proposals.
2. **Current-Ledger Execution Rejection (#979)**: Execution where `current_ledger <= proposal.eta_ledger` is strictly rejected with `TimelockNotExpired`. Proposals cannot execute in the same ledger where ETA is set or reached; execution strictly requires `current_ledger > proposal.eta_ledger`, guaranteeing at least one discrete ledger boundary after ETA.
3. **Auditable Lifecycle Events (#980)**: Transitions emit dedicated indexing events: `TimelockScheduled(proposal_id, eta_ledger, execution_delay)` when entering timelock (`Active -> Passed`), and `TimelockExecuted(proposal_id, eta_ledger, execution_ledger)` alongside `ProposalExecuted` upon execution (`Passed -> Executed`).

## Alternatives Considered

| Alternative | Why rejected |
|-------------|--------------|
| **24-hour timelock** | Adds friction without meaningful security benefit while the admin veto exists; a 24-hour window is too short for large token holders to coordinate a response anyway. |
| **48-hour timelock** | Same reasoning as 24-hour; the admin veto already covers the early phase. |
| **7-day timelock (Compound-style)** | Appropriate for a mature, decentralised protocol, but excessive for a protocol in active parameter tuning. Would slow down legitimate fee adjustments. |
| **Configurable timelock (governance sets the delay)** | Correct long-term design, but adds implementation complexity at v1. Deferred to a future upgrade. |
| **Optimistic execution with challenge period** | Complex to implement correctly; requires a separate challenge mechanism and bond. Out of scope for v1. |

## Consequences

**Positive:**
- Proposals can be executed immediately after voting closes, enabling rapid
  response to protocol conditions.
- Implementation is simpler — no timelock storage, no expiry checks on
  execution.
- The admin veto provides equivalent protection during the early phase when
  token distribution is concentrated.

**Negative / Trade-offs:**
- Without a timelock, a proposal that passes cannot be stopped by the community
  once the admin veto is disabled. This is a significant risk for a mature,
  decentralised protocol.
- The absence of a timelock is a known deviation from DeFi governance best
  practices (MakerDAO, Compound, Uniswap all use timelocks of 2–7 days).
- **Action required (Completed):** A configurable timelock has been implemented, hardened, and activated. Enforcement of `TimelockNotExpired` is live on `execute_proposal` with immutable per-proposal delay binding (#978), strict post-ETA boundary verification (#979), and auditable event emission (#980).
- The `TimelockNotExpired` error is actively enforced; execution attempts with `current_ledger <= eta_ledger` are rejected.
