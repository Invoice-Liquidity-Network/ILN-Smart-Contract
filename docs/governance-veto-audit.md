# Governance veto authority and permanent disablement audit (Issue #1207)

Scope: `configure_veto_multisig`, `veto_proposal`, `disable_veto_power`,
`disable_veto_power_with_reason` and the timelock policy after disablement.
Code: `contracts/iln_governance/src/lib.rs`. Regression tests:
`contracts/iln_governance/tests/audit_1207_veto_authority.rs`.

## 1. Authorization model

| Action | Who must authorize | Notes |
| --- | --- | --- |
| First `configure_veto_multisig` | stored admin | validated before auth: non-empty, no duplicates, `1 <= threshold <= len` else `InvalidVetoMultisigConfig` |
| Re-configure | ILN contract | once a signer set exists |
| `veto_proposal` | the calling signer (`require_auth`) and membership in the signer set | the admin is **not** implicitly a signer |
| `disable_veto_power*` | ILN contract (`require_auth`) | the contract has no governance action that calls it directly; the ILN contract must expose a relay (assumption) |

## 2. `veto_proposal` behaviour

Check order: signer auth → **non-zero reason hash** (`ConsentRequired`) → veto
still enabled (`VetoPowerDisabled`) → multisig configured
(`VetoMultisigNotConfigured`) → signer membership (`NotVetoSigner`) → proposal
exists → proposer binding (`ProposerIdentityMismatch`) → status is `Active` or
`Passed` (`NotVetoable` otherwise, which includes `Executed`, `Rejected` and an
already `Vetoed` proposal) → reason consent (`VetoReasonMismatch`) → duplicate
approval (`VetoAlreadyApproved`).

* Approvals are tracked per signer in persistent `VetoApprovalReceipt` and the
  tally is rebuilt from them, so an archived temporary list cannot reset it and
  removed signers stop counting after a reconfiguration.
* When the tally reaches the threshold the proposal moves to `Vetoed`, the
  deposit is forfeited, receipts are cleaned up and `veto_state_transition` /
  `proposal_vetoed` are emitted. Until then `VetoStatus` is `Pending`.
* A vetoed proposal can never execute, regardless of eta
  (`ProposalCancelled`, see the #1206 audit).
* **Fixed (reason consent):** the consented reason hash was held only in a
  temporary storage entry. If it expired while a veto was partially approved,
  the next signer could set a *different* reason and complete the veto without
  the earlier signers having consented to it. The pending `VetoState`
  (instance storage) carries the reason too and is now authoritative while the
  veto is `Pending`, so a different reason is rejected with
  `VetoReasonMismatch` even after the temporary entry is gone.

## 3. Permanent disablement

* `VetoPowerEnabled` is written `true` only in `initialize` and `false` only
  by the disable path; no entry point re-enables it
  (`is_veto_power_enabled` stays `false`).
* **Precondition (#981):** `execution_delay >= MIN_ACTIVE_TIMELOCK_LEDGERS`
  (17,280 ledgers, about 24 h) else `TimelockNotActive` (error `47`).
* `disable_veto_power_with_reason(hash)` rejects an all-zero hash
  (`ConsentRequired`); the legacy `disable_veto_power()` records an all-zero
  reason.
* **Fixed (write-once record):** the disable path previously ran again on every
  call, overwriting `VetoDisableRecord` (ledger and reason) and re-emitting the
  events, so the audit record was not permanent although the disablement was.
  A repeat call now returns `VetoPowerAlreadyDisabled`, leaving the original
  record, events and policy version untouched.
* On success it stores `VetoDisableRecord{authorized_by, disabled_at_ledger,
  reason_hash}`, bumps the timelock policy version once and emits
  `veto_power_disabled` and `veto_disable_recorded`.
* After disablement `veto_proposal` returns `VetoPowerDisabled`, including for a
  veto that already has some approvals.

## 4. Policy after disablement

* `set_execution_delay` below `MIN_ACTIVE_TIMELOCK_LEDGERS` returns
  `TimelockNotActive`; raising it stays allowed.
* New proposals are queued with at least the floor even if a legacy stored
  delay is lower (`effective_execution_delay`).
* The disable bumps the policy version, so a proposal queued earlier (for
  example under a zero delay while the veto was live) is held until
  `queued_ledger + current_delay` rather than executing immediately.
* Disablement does **not** drop pending approvals' storage; they are simply
  inert.

## 5. Residual risks (verified, not changed)

1. **`VetoState(id)` is stored in instance storage.** The instance entry grows
   with every proposal that receives a veto approval. Vetoes are rare, but the
   entry has a size limit; moving this to persistent storage is a storage
   change.
2. **Signer-set takeover by the ILN contract.** The ILN contract can
   reconfigure signers and threshold at any time before disablement.
3. **Approval receipts expire.** A signer's persistent receipt has a bounded
   TTL; after it lapses that signer's earlier approval stops counting and they
   may approve again.
4. **The disable relay is outside this contract.** Whether the ILN contract
   exposes a governed path to `disable_veto_power` is not verified here.
5. **No pause interaction.** `veto_proposal` works while governance is paused
   (intentional: pause only blocks `execute_proposal`).
