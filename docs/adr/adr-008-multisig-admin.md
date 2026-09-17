# ADR-008: Multi-Signature Admin

**Date:** 2026-07-26
**Status:** Accepted

## Context

The `invoice_liquidity` contract has a single admin address that can pause
the contract, remove approved tokens, change fee/discount parameters, and
(per [ADR-005](ADR-005-governance-timelock.md)) veto governance proposals. A
single admin key is a single point of failure: a compromised or careless
admin key can pause the protocol, drain configuration integrity, or block
governance unilaterally.

Issue #124 asked for threshold-based (M-of-N) multi-signature approval for
these high-security admin operations, so that no single key can act alone.

Key requirements:

- **Threshold safety** — an M-of-N scheme where M ≤ N, configurable per
  deployment (e.g. 2-of-3 for a small team, higher N for broader
  decentralization).
- **Bounded proposal lifetime** — a proposal that never gets its required
  signatures should not remain executable indefinitely; a stale proposal
  signed long ago under different circumstances should not be executable
  today.
- **Order-independence** — signers should be able to approve in any order,
  and a proposal should execute as soon as the threshold is met, regardless
  of who signs last.
- **Minimal action surface for v1** — start with the actions that most need
  M-of-N protection (pause/unpause, and reserved slots for token removal,
  fee-rate, and discount-rate changes) rather than generalizing to arbitrary
  contract calls immediately.

## Decision

Implement a threshold multisig scheme in
`contracts/invoice_liquidity/src/multisig.rs`:

**Configuration** — `MultisigAdmin { signers: Vec<Address>, threshold: u32 }`,
set once via `initialize_multisig_admin(signers, threshold)`. A configuration
is rejected as `InvalidMultisigConfig` if `threshold` is `0` or exceeds
`signers.len()`.

**Admin action types** — a closed `AdminAction` enum, so a proposal always
carries a specific, typed action rather than an arbitrary payload:

```rust
pub enum AdminAction {
    Pause,
    Unpause,
    RemoveToken(Address),
    SetFeeRate(u32),
    SetMaxDiscount(u32),
    UpdateMultisig { new_signers: Vec<Address>, new_threshold: u32 },
}
```

`UpdateMultisig` lets the signer set itself change its own membership and
threshold through the same proposal mechanism, rather than requiring a
separate privileged escape hatch.

**Proposal lifecycle** — `MultisigProposal` tracks `id`, `action`,
`signers_approved`, a `ProposalState` (`Pending` / `Executed` / `Expired`),
and `expires_at`. The workflow is:

1. Any authorized signer calls `propose_*` to create a `Pending` proposal
   with `expires_at = current_ledger + MULTISIG_WINDOW_LEDGERS`.
2. Signers call `sign_proposal` to add their approval; `has_signed` rejects a
   duplicate signature from the same signer (`AlreadySigned`), and signers
   may approve in any order.
3. Once `signers_approved.len() >= threshold` (`threshold_reached`), any
   authorized signer can call `execute_proposal` to apply the action and mark
   it `Executed`. A proposal cannot be executed twice
   (`ProposalAlreadyExecuted`).

**Expiration** — `MULTISIG_WINDOW_LEDGERS = 17_280` (~24 hours at 5s/ledger)
bounds how long a proposal can accumulate signatures before it is treated as
expired (`is_expired`). Signing or executing a proposal at or past
`expires_at` is rejected — expiration is enforced on every state-changing
call, not by an active sweep, so no background job is required.

## Alternatives Considered

| Alternative | Why rejected |
|-------------|--------------|
| **Arbitrary-payload proposals (raw call data instead of a typed `AdminAction` enum)** | More flexible, but signers would be approving opaque bytes rather than a specific, auditable action — harder to review and easier to mis-sign. A closed enum makes every proposal's effect explicit at the type level. |
| **No expiration (proposals valid until executed)** | A proposal signed under one set of circumstances (e.g. an emergency pause) could sit dormant and be executed much later when it's no longer appropriate, with no way for signers to invalidate it short of an `UpdateMultisig` proposal. A bounded window forces stale proposals to be re-proposed. |
| **Off-chain multisig (e.g. a Gnosis-Safe-style external wallet as the admin address)** | Moves the trust boundary off-chain and outside the contract's own audit surface; also loses the ability to express admin actions as typed, on-chain-verifiable proposals with contract-native expiration. |
| **Weighted voting (signers with different weights)** | Adds complexity not needed for the initial use case (a small, roughly-equal-trust set of operators); listed as a future enhancement rather than v1 scope. |
| **Additional timelock delay after threshold is met, before execution is allowed** | Mirrors the governance timelock question in ADR-005; deferred for the same reason — the admin multisig itself already raises the bar from one key to M-of-N, and stacking a mandatory delay on top would slow emergency pause response, which is the primary use case in v1. |

## Consequences

**Positive:**
- No single compromised or careless key can pause the contract, remove a
  token, or change fee/discount parameters — an attacker needs to compromise
  `threshold` independent keys.
- The typed `AdminAction` enum makes every proposal's effect explicit and
  reviewable before signing, rather than opaque call data.
- Order-independent signing and anyone-can-execute-once-threshold-met keep
  the workflow operationally simple — no coordinator role is required.
- The 24-hour expiration window bounds how long a stale, partially-signed
  proposal remains a latent risk.
- `UpdateMultisig` allows the signer set to evolve (e.g. rotate a
  compromised signer, raise the threshold as the team grows) through the
  same auditable proposal mechanism, without a separate super-admin
  override.

**Negative / Trade-offs:**
- **This module is not currently wired into the contract's public API.**
  `contracts/invoice_liquidity/src/multisig.rs` defines the data structures
  and pure helper functions (`is_signer`, `has_signed`, `threshold_reached`,
  `is_expired`) but `lib.rs` does not declare `pub mod multisig;`, and none
  of `initialize_multisig_admin`, `propose_pause`, `sign_proposal`, or
  `execute_proposal` exist as contract entry points today — `pause`/`unpause`
  are still callable directly by the single admin address
  (`require_admin`). A full lib.rs/storage.rs/errors.rs integration was
  implemented in commit `d267e36` (`feat: implement 2-of-3 multi-sig admin
  for high-security operations`) but was lost from `lib.rs` in a later merge
  conflict resolution (`9e94e45`, "Replace local lib.rs with upstream/main
  version to resolve merge markers"); `contracts/invoice_liquidity/src/
  tests_multisig_admin.rs` still contains the corresponding test suite but
  is not declared as a module and does not compile against current `lib.rs`.
  This ADR documents the design as built; re-wiring the integration
  (`pub mod multisig;`, the five contract functions, the `DataKey` storage
  variants, and the seven `ContractError` variants listed in
  `MULTISIG_IMPLEMENTATION.md`) is tracked as follow-up work, not assumed
  complete.
- `MULTISIG_WINDOW_LEDGERS` is a compile-time constant; changing the
  expiration window requires a contract upgrade rather than a governance
  parameter change.
- The action set is closed (`Pause`, `Unpause`, `RemoveToken`,
  `SetFeeRate`, `SetMaxDiscount`, `UpdateMultisig`); adding a new
  multisig-gated action requires extending the enum and redeploying, rather
  than being data-driven.
- There is no signature revocation — a signer who approved a proposal cannot
  retract that approval before execution or expiration.

## Follow-up work

- Re-add `pub mod multisig;` and the five contract entry points
  (`initialize_multisig_admin`, `propose_pause`, `propose_unpause`,
  `sign_proposal`, `execute_proposal`) to `lib.rs`, the storage helpers to
  `storage.rs`, and the error variants (`NotAuthorizedSigner`,
  `ProposalNotFound`, `AlreadySigned`, `ProposalExpired`,
  `ThresholdNotReached`, `ProposalAlreadyExecuted`, `InvalidMultisigConfig`)
  to `errors.rs`, per `MULTISIG_IMPLEMENTATION.md`.
- Re-enable `tests_multisig_admin.rs` as a compiled test module once the
  integration lands, and confirm it still passes against current `lib.rs`.
- Route `pause`/`unpause` (and eventually token removal / fee / discount
  changes) through the multisig proposal flow instead of direct
  `require_admin` calls, once re-wired.
- Consider signature revocation and weighted voting as documented future
  enhancements.
