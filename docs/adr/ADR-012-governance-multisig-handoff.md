# ADR-012: Governance-to-Multisig Authority Handoff Plan

**Date:** 2026-08-29
**Status:** Accepted

## Context

[ADR-005](ADR-005-governance-timelock.md) states that a timelock "must be introduced
before the admin veto power is disabled," and the threat model's "Future Upgrade
Considerations" section lists **Decentralized Governance** as still needed: *"Full
DAO-based admin (currently governance contract controls some parameters, but single
multisig still recommended for safety)."* Both documents describe the destination —
`iln_governance` eventually superseding the admin multisig — but neither specifies
**when** that handoff should happen or **what has to be true first**. Issue #646 asks
for that plan.

This ADR does not change any contract behavior. It formalizes the trigger criteria and
phased sequence for an authority handoff that is already implied by ADR-005 and
[ADR-008](adr-008-multisig-admin.md), so the decision to proceed is a checklist review
rather than an ad-hoc judgment call made under time pressure.

### Where authority actually sits today

This plan has to start from the real current state, not the aspirational one:

- **`invoice_liquidity` admin** is a single `Address` (`DataKey::Admin`), gated by
  `require_admin` on every admin function (see
  [access-control.md](../access-control.md)). ADR-008 designed an M-of-N multisig
  (`contracts/invoice_liquidity/src/multisig.rs`) as the intended replacement for that
  single key, but per ADR-008's "Negative / Trade-offs" section **that module is not
  wired into `lib.rs`** — no multisig entry points exist on-chain yet. In practice,
  "the admin" is whatever key(s) the `Admin` address's signing threshold represents at
  the account level (a Stellar multisig account, if one is configured — see
  [access-control.md §14](../access-control.md#14-mainnet-admin-signer-verification-issue-647)
  — not a contract-enforced one).
- **`iln_governance`** already runs real on-chain proposals, voting, delegation, and
  execution, and already controls some parameters directly (oracle registry changes,
  `min_quorum_bps`, `execution_delay`). It does **not** control `invoice_liquidity`'s
  core admin surface (fee rate, token registry, pause, `set_admin` itself) — those stay
  gated by `require_admin`, callable only by the admin account.
- **The admin veto** (`veto_proposal`) can block any `Active`/`Passed` governance
  proposal, and is still enabled. `disable_veto_power()` is a one-way switch, callable
  only via the configured `iln_contract` address's authorization.
- **No timelock exists yet.** `execute_proposal` runs immediately once voting closes and
  quorum/majority are met (`ADR-005`'s explicit v1 decision). `set_execution_delay`
  exists as a governance parameter but defaults to `0` and nothing currently forces a
  positive value before veto is disabled.

So today's real ordering is: **multisig (designed, not wired) → single admin key (live)
→ admin veto (live) → governance (live, partial authority, no timelock)**. The handoff
this ADR plans is the path from that state to governance holding final authority with
the veto retired.

## Decision

Authority moves from the admin to `iln_governance` in five phases. Each phase has an
explicit **entry trigger** — a phase is not time-boxed, it starts only when its
predecessor's trigger criteria are met and is verified against the pre-audit/pre-mainnet
checklists already in the repo ([pre-audit-checklist.md](../pre-audit-checklist.md),
[mainnet-launch-checklist.md](../mainnet-launch-checklist.md)) rather than a calendar
date.

### Phase 0 — Current state (baseline)

Single admin key (ideally a Stellar multisig account per
[access-control.md §14](../access-control.md#14-mainnet-admin-signer-verification-issue-647)),
admin veto enabled, no timelock, governance controls a subset of parameters. This is
where the protocol is today.

### Phase 1 — Wire the contract-level multisig (ADR-008 follow-up)

**Trigger to enter:** none — this is unblocked, tracked work.

Re-add `pub mod multisig;` and the five entry points documented in ADR-008's
"Follow-up work" section (`initialize_multisig_admin`, `propose_pause`,
`propose_unpause`, `sign_proposal`, `execute_proposal`) so pause/unpause — and
eventually token removal, fee-rate, and discount-rate changes — go through an M-of-N
contract-enforced threshold instead of a single `require_admin` check backed only by an
off-chain account-level multisig.

**Exit criteria (→ Phase 2):** multisig entry points deployed to testnet, exercised
through at least one real M-of-N proposal cycle, and `tests_multisig_admin.rs`
re-enabled and passing.

### Phase 2 — Expand governance's admin-parameter authority

**Trigger to enter:** Phase 1 complete on the target network.

Extend `iln_governance`'s proposal-execution surface to cover more of
`invoice_liquidity`'s admin-gated parameters (fee rate, max discount, decay params,
min payer reputation) the same way oracle registry changes are already governance-routed
today. Each addition is its own scoped change, reviewed independently — this phase does
not migrate pause/token-registry/`set_admin` itself, which stay behind the Phase-1
multisig as the higher-severity operations.

**Exit criteria (→ Phase 3):** governance has executed proposals covering the expanded
surface in production (or a representative testnet load) for at least one full quarter
with no proposal requiring an admin veto to prevent harm.

### Phase 3 — Implement and activate the timelock

**Trigger to enter:** ADR-005's own stated precondition — "a timelock must be
implemented and activated via a governance upgrade before `disable_veto_power()` is
called" — has not yet been satisfied by anything built so far. This phase is where it
gets satisfied: implement enforcement of `TimelockNotExpired` (the error variant is
already reserved) against `execution_delay`, and set `execution_delay` to a
non-zero value chosen per ADR-005's "Alternatives Considered" trade-offs (24–48h during
the transition, moving toward the 2–7 day range as decentralization increases).

**Exit criteria (→ Phase 4):** timelock enforced on `execute_proposal` in production,
non-zero `execution_delay` set, and at least one full timelock-delayed execution cycle
observed without incident.

### Phase 4 — Retire the admin veto

**Trigger to enter (all of the following):**

1. Phase 3 complete — timelock live and proven.
2. Governance token distribution is not concentrated enough for a single actor to
   reliably force quorum + majority on a harmful proposal within one voting window —
   evaluated against the same concern raised in threat model §E3 (flash-loan balance
   manipulation), i.e. concentration risk must be assessed net of composability risk,
   not just nominal holder count.
3. A formal security audit of `iln_governance` (see
   [pre-audit-checklist.md](../pre-audit-checklist.md)) has been completed and its
   findings resolved.
4. The Phase-1 multisig has been the operative mechanism for pause/emergency response
   for long enough to be trusted as the **replacement** safety net once the veto is
   gone — the veto and the multisig are not the same control, and removing the veto
   must not leave a period with neither.
5. The [disaster-recovery procedure](../disaster-recovery-multisig-signers.md) for a
   lost/compromised multisig majority (Issue #643) is written and the signer set it
   assumes is actually in place — the veto is being retired specifically because the
   multisig + timelock + governance combination is meant to cover what it covered.

**Action:** call `disable_veto_power()`. This is irreversible on the deployed contract
(the "Rollback" section below covers what "irreversible" actually means operationally).

### Phase 5 — Governance as final authority (target end state)

**Trigger to enter:** Phase 4 complete.

`invoice_liquidity`'s `Admin` address is repointed (via `set_admin`, itself now
timelocked and multisig-gated per Phases 1 and 3) to an address `iln_governance`
controls, so proposal execution — not a standing human-controlled key — is the terminal
authority for every remaining admin-gated function. The Phase-1 multisig is retained
**only** as an emergency pause path with its own bounded, publicly known authority (not
a general parameter-change mechanism), consistent with ADR-008's original scope of
"actions that most need M-of-N protection."

## Rollback / Failure Handling

`disable_veto_power()` cannot be reversed by calling a function — there is no
`enable_veto_power()`, by design (ADR-005/#68 intentionally made it one-way to prevent
the admin from re-arming a veto whenever convenient). If a Phase 5 governance takeover
proves unsafe after the fact (e.g., a flash-loan-style attack per threat model §E3
succeeds despite the Phase 4 gating above), the only recovery paths are:

- **A contract upgrade** (`upgrade()`, itself still gated by whatever authority
  Phase 5 has established) that reintroduces a veto-equivalent guard — this requires the
  same authority that is being distrusted in this scenario, so it is only viable if the
  Phase-1 multisig's emergency-pause path (retained in Phase 5) is used to `pause()`
  first, buying time for a coordinated upgrade.
- **Migrating to a new contract instance** with the old veto restored, if the upgrade
  path itself is compromised.

This is why Phase 4's entry criteria require the multisig disaster-recovery procedure
(#643) and a proven emergency-pause path to already be in place *before* the veto is
retired — the pause capability is the actual rollback mechanism, not a hypothetical
un-disable function.

## Alternatives Considered

| Alternative | Why rejected |
|-------------|--------------|
| **Fixed calendar date for the handoff** (e.g. "12 months post-mainnet") | Decouples the decision from actual protocol health (token concentration, audit status, timelock maturity); a date that arrives before the criteria are met would force an unsafe handoff, and one that arrives after would just be ignored — a criteria-based trigger is the thing calendar dates are trying to approximate anyway. |
| **Single-step cutover (skip the multisig, go straight from single-admin to full governance)** | Skips the M-of-N safety net ADR-008 already designed, and removes the admin veto and single-key risk at the same time — leaving no fallback if governance itself is compromised during the transition. |
| **Keep the admin veto permanently, never disable it** | Contradicts ADR-005's explicit statement that the veto is a stopgap for the "early phase when token distribution is concentrated," and permanently retains centralized override power the whole governance effort is meant to remove. |
| **Let governance vote to disable its own veto whenever it wants (no external criteria)** | A proposal to disable the veto is exactly the kind of action the veto exists to catch if it's premature or attacker-driven — self-certifying readiness removes the check at the moment it matters most. |

## Consequences

**Positive:**
- Gives a concrete, checkable definition of "ready to decentralize" instead of leaving
  ADR-005's "must happen before mainnet launch" as an unscoped commitment.
- Each phase is independently shippable and reversible (with Phase 4's rollback caveat
  documented above) — a stall at any phase leaves the protocol in a known-safe state
  rather than a half-migrated one.
- Makes explicit that the Phase-1 multisig is not just an ADR-008 backlog item but a
  load-bearing precondition for retiring the admin veto.

**Negative / Trade-offs:**
- This is a plan, not an implementation — Phases 1–3 still require the actual
  engineering work (wiring the multisig, extending governance's parameter surface,
  implementing timelock enforcement) tracked separately.
- The token-concentration criterion in Phase 4 is qualitative; it should be replaced
  with a quantified metric (e.g. Nakamoto coefficient over voting power, or max
  single-delegate share across recent proposals) as part of the Phase 3/4 work, not
  left to subjective judgment at handoff time.
- Retiring the veto is genuinely irreversible in the sense described above; every phase
  before Phase 4 must be conservative about declaring "done" given that.
