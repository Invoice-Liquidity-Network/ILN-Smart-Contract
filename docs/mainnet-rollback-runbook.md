# Mainnet Deployment Rollback Runbook

**Status:** Draft — pending rehearsal sign-off (see §8)
**Owner:** Release lead
**Related:** [Upgrade Guide](upgrade-guide.md) (general contract upgrade/rollback mechanics), [Mainnet Launch Checklist](mainnet-launch-checklist.md), [Monitoring Runbook](monitoring-runbook.md)

## 1. Purpose & Scope

The [Upgrade Guide](upgrade-guide.md) and [Developer Quickstart](developer-quickstart.md) cover the happy-path mainnet deployment. This document is the companion for the failure path specific to the first hours/days after launch: **what to do if a critical bug is discovered before meaningful TVL has accumulated.**

This window is different from a mature-protocol incident (covered by the general incident response runbook) in three ways that change the calculus:

- **Low TVL, low migration cost.** Early on, funds at risk are small enough that a full redeploy (new contract ID) is often cheaper and safer than an in-place upgrade rollback.
- **Few or no in-flight invoices.** Fewer active state transitions to reconcile, so a clean cutover is more likely to be lossless.
- **No governance quorum yet.** Early after launch, governance token distribution may not support a quorum-based vote in the time a critical bug demands — the runbook must not assume `execute_proposal` can pass in time.

## 2. Trigger Criteria

Invoke this runbook when **any** of the following hold, discovered within the "early-launch window" (defined per-launch, default: first 14 days or until TVL exceeds a pre-announced threshold, whichever comes first):

| Trigger | Example |
|---|---|
| Funds-at-risk bug | An accounting invariant (see [formal-verification.md](formal-verification.md) §3) can be violated, allowing overfunding/overpayment/fund lockup |
| Auth bypass | An admin-gated or role-gated function can be called by an unauthorized address |
| Oracle/price manipulation | A price feed can be manipulated to misprice invoices or liquidations |
| Governance takeover path | A proposal can execute an action its guards should have blocked |
| Irrecoverable state corruption | Contract storage becomes inconsistent in a way normal operations can't repair |

If the bug is cosmetic, has no funds/auth impact, or can be safely patched with a governance-approved parameter change, use the normal upgrade path in [upgrade-guide.md](upgrade-guide.md) instead — this runbook is for cases severe enough to justify halting the protocol.

## 3. Roles

| Role | Responsibility during rollback |
|---|---|
| Incident commander (IC) | Owns the decision (§4), coordinates all other roles, is the single point of truth for status |
| Contracts lead | Confirms root cause, prepares rollback WASM or new deployment, verifies state |
| Release lead | Executes deployment/rollback commands, holds admin key access per [access-control.md](access-control.md) |
| Security lead | Confirms the bug is real and severity, signs off before any public communication |
| Community lead | Owns user communication (§7) |

The IC role rotates per on-call schedule (see [monitoring-runbook.md](monitoring-runbook.md)); whoever is on-call when the trigger fires assumes IC until handoff.

## 4. Decision Framework

```
Critical bug found in early-launch window
│
├─ Is the bug actively being exploited right now?
│  ├─ YES → Immediate pause() (§5.1), skip to §6 "Emergency" path
│  └─ NO  → continue
│
├─ Can admin veto (governance) block the specific bad proposal/action in time?
│  ├─ YES → veto_proposal() (§5.2), reassess after — may not need full rollback
│  └─ NO  → continue
│
├─ Can the bug be fixed with a same-day upgrade (new WASM, no schema change)?
│  ├─ YES → Follow upgrade-guide.md Phase 3 (expedited: skip governance vote if
│  │         pre-launch admin key still holds sole upgrade authority; otherwise
│  │         this branch is unavailable and you must proceed below)
│  └─ NO  → continue
│
└─ Is TVL still below the full-redeploy threshold (§1)?
   ├─ YES → Full redeploy path (§6.B) — new contract ID, migrate/refund state
   └─ NO  → In-place rollback path (§6.A) — revert WASM hash per upgrade-guide.md §"Rollback Procedure"
```

The IC makes the final call and records it (timestamp, trigger, chosen path) in the incident log before execution begins.

## 5. Rollback Mechanisms Available

### 5.1 Pause

Every contract with funds exposure (`invoice_liquidity`, `insurance_pool`) exposes `pause()` / `unpause()`, admin-gated. This is the fastest lever — it stops new state-mutating calls without touching existing state or requiring a deployment. Always the first action when actively exploited.

### 5.2 Governance veto

`iln_governance::veto_proposal()` blocks a specific `Active` or `Passed` proposal before it executes (see [formal-verification.md](formal-verification.md) §8.2). Use this when the danger is a pending proposal, not already-live contract code — it requires no redeploy.

### 5.3 In-place upgrade rollback

Revert the contract's WASM hash to the last known-good build via `upgrade(new_wasm_hash)`. Full procedure: [upgrade-guide.md § Rollback Procedure](upgrade-guide.md#rollback-procedure). Preserves all on-chain state and contract IDs — appropriate once TVL/invoice count is high enough that user-facing continuity (same contract ID) matters more than deployment simplicity.

### 5.4 Full redeploy (early-launch only)

Deploy a fresh contract instance from the last known-good WASM (or a hotfixed build), and cut clients over to the new contract ID. Appropriate only in the early-launch window, when:

- The prior contract holds low enough TVL that manual refund/migration of open positions is tractable, and
- The bug may be in the *storage layout itself*, so an in-place upgrade can't cleanly roll back (a WASM downgrade over corrupted storage can panic on decode).

Steps:
1. `pause()` the affected contract (if not already paused) to freeze new activity.
2. Snapshot current state: `get_contract_stats`, enumerate open invoices/positions (see [upgrade-guide.md § State Snapshot & Recovery](upgrade-guide.md#state-snapshot--recovery) for the snapshot commands).
3. For every open position (funded-but-unsettled invoice, pending governance proposal, insurance pool exposure), refund or close it against the paused contract per its own admin/emergency-withdraw path — do **not** attempt to replay these onto the new contract; keep the two histories separate and reconciled manually.
4. Deploy the known-good WASM as a new contract instance (`docs/developer-quickstart.md` deployment steps).
5. Re-run `initialize` with the same admin/governance addresses used previously (unless the admin key itself is the compromised element, in which case rotate it per [access-control.md](access-control.md) first).
6. Update SDK/indexer/frontend configuration (contract ID) and redeploy those layers.
7. Publish the new contract ID per the "Contract IDs published" checklist item in [mainnet-launch-checklist.md](mainnet-launch-checklist.md).

## 6. Step-by-Step Rollback Procedure

### 6.A In-place rollback (TVL above threshold)

Follow [upgrade-guide.md § Rollback Procedure](upgrade-guide.md#rollback-procedure) verbatim (Assess → Prepare → Execute → Rollback Impact Analysis). This runbook adds one early-launch-specific step before "Execute Rollback": confirm no `iln_governance` proposal has an `eta_ledger` in the past that would auto-execute against the reverted contract on the next call — veto it first (§5.2) if so.

### 6.B Full redeploy (TVL below threshold)

Follow §5.4 above.

### Emergency path (actively exploited)

1. `pause()` immediately — do not wait for root-cause confirmation.
2. IC declares the incident and starts the decision framework (§4) in parallel with containment.
3. Security lead confirms scope (which contracts/functions are affected).
4. Proceed to §6.A or §6.B per the decision output.
5. Only unpause once the fix (rollback or redeploy) is live and spot-checked.

## 7. Communication Plan

| Timing | Audience | Channel | Content |
|---|---|---|---|
| At `pause()` | Public | Discord/Twitter/status page | "Investigating an issue, protocol paused as a precaution, funds are safe" — no speculation on cause |
| At decision (§4) | Public | Same | Chosen path (rollback vs redeploy) and expected timeline, no technical root-cause detail yet |
| At completion | Public | Same + written post-mortem | Root cause, what was affected, what changed, timeline to `unpause()` |
| Within 72h | Public | Post-mortem doc (linked from CHANGELOG) | Full incident writeup per [security.md](security.md) severity/response guidance |

Security lead must sign off before any message naming a specific vulnerability class or exploit path is published, to avoid tipping off copy-cat attackers before the fix is live.

## 8. Rehearsal

**This runbook must be rehearsed on testnet before mainnet launch and re-rehearsed after any material change to the deployment topology (new contract added, admin key rotation, governance quorum changes).**

### 8.1 Rehearsal scenario

Simulate the "full redeploy" path (§5.4/§6.B), since it is the least-practiced and most operationally complex:

1. Deploy `invoice_liquidity` + `iln_governance` to testnet from the current release tag.
2. Seed state: a handful of invoices across `Pending`/`Funded`/`PartiallyFunded`, and one `Active` governance proposal.
3. Declare a simulated critical bug (pick any real invariant from [formal-verification.md](formal-verification.md) §3/§9 as the "finding").
4. Run the full decision framework (§4) live, with the IC role actually rotating through the on-call runbook.
5. Execute `pause()`, veto the open proposal, snapshot state, refund/close the open invoices, redeploy, re-`initialize`, and cut a mock "frontend config" over to the new contract ID.
6. Time every step from trigger to `unpause()`-equivalent readiness.

### 8.2 Rehearsal exit criteria

- Every role in §3 was staffed by a real person (not "assumed") during the run.
- Total time from trigger to redeployed-and-verified contract is recorded and is under the target set for launch (define per-launch; record in §8.3 log).
- No manual step in §5.4/§6 required undocumented tribal knowledge — anyone following this doc could execute it.
- The communication templates in §7 were actually drafted and timed, not skipped.

### 8.3 Rehearsal Sign-off Log

| Date | Scenario | IC | Time to `pause()` | Time to redeploy verified | Issues found | Runbook updated? |
|---|---|---|---|---|---|---|
| _TBD_ | Full redeploy dry run | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

A launch **must not** proceed while this log has zero completed rows for the current deployment topology.

## 9. Post-Rollback Validation

After either path (§6.A or §6.B):

1. Re-run the smoke tests from [upgrade-guide.md § Post-Upgrade Validation](upgrade-guide.md#post-upgrade-validation) against the (possibly new) contract ID.
2. Confirm indexer and notifications point at the correct contract ID and are ingesting events again.
3. Confirm monitoring/alerting (per [monitoring-runbook.md](monitoring-runbook.md)) is attached to the (possibly new) contract ID before declaring the incident closed.
4. Only then `unpause()` (if not a full redeploy — a new contract instance is unpaused by default) and announce recovery per §7.
