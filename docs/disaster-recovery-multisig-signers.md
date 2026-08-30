# Disaster Recovery: Lost or Compromised Multisig Signer Majority

**Status:** Active
**Issue Reference:** Issue #643 — the threat model lists "admin single point of failure"
as a critical unresolved risk; this runbook is the recovery path for its worst case.

## 1. Scope and Current Reality

Today, `invoice_liquidity`'s `Admin` (and, per
[insurance-pool-admin-transfer-audit.md](insurance-pool-admin-transfer-audit.md),
`insurance_pool`'s `Admin`/`ClaimsAuthority`) is a **single Stellar address**. The
contract has no knowledge of whether that address is a plain EOA or a Stellar
account configured with weighted multi-signature (`set_options` with multiple signers
and a threshold) — `require_admin` only checks that *the account* authorized the call,
via whatever combination of signatures satisfies that account's own threshold at the
protocol level. The mainnet launch checklist calls for the production admin to be "a
multi-sig account or equivalent governance-controlled authority" (see
[mainnet-launch-checklist.md](mainnet-launch-checklist.md)), verified against
[CODEOWNERS](../.github/CODEOWNERS) by
[`scripts/verify-admin-signers.ts`](../scripts/verify-admin-signers.ts) (see
[access-control.md §14](access-control.md#14-mainnet-admin-signer-verification-issue-647)).
As of this writing, [`.github/mainnet-admin-signers.json`](../.github/mainnet-admin-signers.json)
has an empty signer list — **the multi-sig admin has not yet been configured** — so
this runbook describes the procedure to have in place *before* that configuration
happens, not a response to an incident that has already occurred against a live
mainnet multisig.

This is a Stellar **account-level** multisig (weighted signers + threshold on the
account itself), not a **contract-level** M-of-N scheme — the contract-enforced
multisig designed in [ADR-008](adr/adr-008-multisig-admin.md)
(`contracts/invoice_liquidity/src/multisig.rs`) is not wired into `lib.rs` yet (see
[ADR-012](adr/ADR-012-governance-multisig-handoff.md) Phase 1). That distinction
matters throughout this document: every mitigation available today is an **off-chain,
Stellar-account-level** one, because the contract itself has no concept of "signers" —
`require_admin` sees only "the admin account authorized this call" or not.

**"Majority" here means:** enough combined signer *weight* to no longer meet the
account's low/medium/high threshold as configured — not necessarily a majority by
headcount, since Stellar signer weights can be unequal. Any recovery plan must be
evaluated against configured weights, not signer count.

## 2. Why This Is Hard: No On-Chain Escape Hatch

Every admin-gated contract function — including `set_admin` (the function that would
normally let you rotate away from a compromised or locked admin) and `upgrade` (the
function that could deploy a fix) — requires `require_admin`, i.e. authorization from
the **current** admin address. If that address's signature threshold can no longer be
met, **no contract function can be called by anyone, ever, without a new deployment**.
There is currently no break-glass contract mechanism (no secondary recovery key, no
timelocked fallback authority) that bypasses this. This is the concrete shape of the
threat model's "admin single point of failure" risk, and the reason Sections 3–4 below
are weighted toward **prevention** — once a true majority-loss lockout happens with no
pre-provisioned recovery path, it is not recoverable on the deployed contract.

## 3. Prevention (must be done before mainnet, not after an incident)

These are prerequisites, not a checklist to run through the day something goes wrong —
by definition, a majority-loss event with no prior preparation has no on-chain recovery
(Section 2). Preventive measures gate Phase 4 of [ADR-012](adr/ADR-012-governance-multisig-handoff.md)
(retiring the governance admin veto) precisely because that phase assumes the multisig
is a trustworthy replacement safety net.

1. **Provision more signers than the threshold requires**, so losing any single key —
   or a small handful — does not put the account below threshold. E.g. 3-of-5 or 4-of-7
   rather than 2-of-3 for the production admin, matching ADR-008's own framing that N
   should scale with the team ("higher N for broader decentralization").
2. **Designate and pre-provision a recovery signer.** A separate, high-weight signer
   key held under a documented custody process independent of day-to-day operational
   signers (e.g., legal counsel escrow, a qualified institutional custodian, or a
   geographically- and organizationally-separated hardware key under multi-party
   control) whose weight — combined with any *one* surviving operational signer — can
   still meet the account's threshold. This is the only mechanism that turns "majority
   of operational signers lost" into a recoverable event rather than a permanent
   lockout.
3. **Diversify custody.** No two signers should share a custody failure mode (same
   physical location, same hardware wallet vendor/firmware, same person's personal
   accounts, same organization's single admin). Document each signer's custody model in
   the (currently empty) [`.github/mainnet-admin-signers.json`](../.github/mainnet-admin-signers.json)
   mapping alongside the GitHub-identity mapping it already tracks.
4. **Run signer liveness drills.** Periodically (recommended: quarterly) confirm each
   signer can still produce a valid signature — on testnet only, never spending real
   authority — so a lost or inaccessible key is caught during a drill, not during an
   actual incident when the loss compounds with time pressure. This is a natural
   extension of the existing [Admin Signer Check CI](../.github/workflows/admin-signer-check.yml)
   (currently a structural CODEOWNERS-match check, not a liveness check); tracked as
   follow-up to add a liveness ping to that workflow once the mainnet signer set exists.
5. **Rehearse this runbook.** Table-top the scenarios in Section 5 with the actual
   signer group before mainnet launch, so the *first* time anyone reads this document
   is not during a live incident.

## 4. Detection

- **Structural drift**: [Admin Signer Check CI](../.github/workflows/admin-signer-check.yml)
  (daily + on CODEOWNERS/signer-mapping changes) flags on-chain signers with no mapped
  GitHub identity, or mapped signers no longer on the CODEOWNERS team — an early signal
  that a signer has left without a corresponding key rotation, i.e. a slow-motion path
  toward majority loss if not corrected.
- **Unusual admin activity**: monitor Horizon events for admin functions per
  [monitoring-runbook.md](monitoring-runbook.md), and query
  `get_recent_admin_actions()` (the on-chain audit log added for
  [Issue #645](access-control.md#15-on-chain-admin-action-audit-log-issue-645)) for a
  quick "what has the admin done recently" check without replaying the full event
  stream — the first sign of a *compromised* (not merely lost) majority is usually an
  admin action no legitimate signer recalls approving.
- **Signer self-report**: an individual signer reporting their key lost, stolen, or
  their device compromised is the most common real-world trigger — treat any such
  report as urgent even if the account's remaining weight still meets threshold, since
  the loss compounds if a second key is lost before rotation completes.

## 5. Response by Scenario

### 5.1 Minority of signers lost or compromised (threshold still reachable)

The account can still authorize `set_options`. This is the easy case — but time
pressure still applies, because every additional lost/compromised key moves the
situation toward Section 5.2 or 5.3.

1. Remaining signers immediately submit a `set_options` transaction removing the
   affected signer key(s) and, if replacing them, adding new key(s) — all within one
   transaction where possible, to avoid a window with reduced total weight.
2. Update [`.github/mainnet-admin-signers.json`](../.github/mainnet-admin-signers.json)
   in the same change window; [Admin Signer Check CI](../.github/workflows/admin-signer-check.yml)
   will fail until this is done, which is the intended forcing function.
3. If the key was **compromised** (not just lost) rather than merely misplaced, treat
   the incident as a potential precursor to 5.3 — assume the compromised key may have
   already been used and audit `get_recent_admin_actions()` / Horizon events since the
   suspected compromise window for any unauthorized action.

### 5.2 Majority of signers lost or inaccessible (locked out, not compromised)

1. **Exhaust recovery of the lost keys first** — hardware wallet seed recovery, HSM
   vendor recovery process, custodian-assisted recovery, key-share reconstruction if a
   threshold-secret-sharing backup exists. Do not proceed to step 2 until this is
   genuinely exhausted; step 2 consumes the one pre-provisioned recovery mechanism this
   plan has.
2. **If a recovery signer was provisioned per Section 3.2**: combine the recovery
   signer's weight with any surviving operational signer(s) to reach threshold, then
   immediately submit `set_options` to rotate in a fresh, appropriately-sized signer
   set (do not simply restore the old set — treat this as a full signer refresh).
   Update the signer mapping and re-run the CI check per 5.1 step 2.
3. **If no recovery signer was provisioned**: per Section 2, there is no on-chain path
   to recover this account. State this to stakeholders plainly rather than searching
   for a code-level fix that does not exist — `set_admin`, `upgrade`, `pause`, and every
   other admin function are permanently unreachable on the current deployment. The only
   paths forward are (a) accept the contract is frozen in its last state indefinitely,
   or (b) coordinate a full migration: deploy a new contract instance, and — since the
   old contract cannot itself authorize any state export — reconstruct protocol state
   for the new deployment from indexed historical events (see
   [indexer-operations.md](indexer-operations.md)) rather than an on-chain migration
   call. This is a last-resort, LP/freelancer-communication-heavy path, not a routine
   recovery, and is exactly the scenario Section 3 exists to make unnecessary.

### 5.3 Majority of signers compromised (attacker can authorize as admin)

This is the highest-severity case: an attacker who controls enough weight is, from the
contract's perspective, indistinguishable from the legitimate admin.

1. **Race to `pause()` if not already paused.** `pause`/`unpause` are deliberately not
   rate-limited (see [access-control.md](access-control.md)) specifically so an
   emergency response isn't blocked by cooldowns — but note an attacker with admin
   weight can just as easily `unpause()` afterward if they still hold the majority, so
   pausing alone does not resolve the incident, only buys time.
2. **Assume every other admin-gated parameter may be altered next** — fee rates,
   token registry, `min_payer_reputation`, oracle registry entries. Cross-reference
   `get_recent_admin_actions()` against what the legitimate signer group actually
   approved to establish the actual blast radius.
3. **There is currently no contract-level circuit breaker independent of the admin
   account.** `iln_governance`'s admin veto guards governance *proposals*, not
   `invoice_liquidity`/`insurance_pool` admin actions directly, so it cannot be used to
   override a compromised admin today. This is the residual risk [ADR-012](adr/ADR-012-governance-multisig-handoff.md)'s
   phased handoff is meant to eventually close (a contract-enforced M-of-N per ADR-008,
   with proposal expiry bounding how long a compromised-signer proposal stays live, is
   a strictly harder target than today's off-chain-only account multisig) — but it is
   not a mitigation available in an active incident today. In the interim, the realistic
   response is entirely off-chain: revoke/rotate every compromised key's underlying
   credential (hardware device, custodian access, etc.) as fast as possible, and treat
   `pause()` racing (step 1) as the only on-chain lever available.
4. **Communicate.** Disclose to LPs/freelancers/payers per whatever incident
   communication process is current practice (see
   [code-freeze-procedure.md](code-freeze-procedure.md) for the adjacent audit-freeze
   process this may need to trigger) — do not attempt to quietly resolve a compromised
   admin majority, since affected users need to know before interacting with a
   contract an attacker may still control.

## 6. Post-Incident

Regardless of scenario:

1. Rotate every signer key involved in the incident, even ones not directly
   lost/compromised, if there is any doubt about the security of the environment they
   were generated or stored in.
2. Update [`.github/mainnet-admin-signers.json`](../.github/mainnet-admin-signers.json)
   and confirm [Admin Signer Check CI](../.github/workflows/admin-signer-check.yml)
   passes clean.
3. Write a post-mortem: what was lost/compromised, how it was detected, how long
   recovery took, and whether Section 3's preventive measures actually held up as
   designed — feed gaps back into this document.
4. Re-run the signer liveness drill (Section 3.4) on the new signer set before
   declaring the incident closed.

## 7. Relationship to Longer-Term Mitigations

This runbook covers the account-level multisig that exists (or will exist) today. It is
explicitly a stopgap, not the end state:

- [ADR-008](adr/adr-008-multisig-admin.md) — wiring the contract-enforced M-of-N
  multisig would move signer-threshold logic on-chain (auditable proposal state,
  bounded proposal expiry) rather than relying entirely on Stellar account-level
  configuration this document has no visibility into from the contract's side.
- [ADR-012](adr/ADR-012-governance-multisig-handoff.md) — the phased plan for
  `iln_governance` to eventually hold final authority explicitly lists this runbook's
  existence as a Phase 4 precondition for retiring the admin veto, since removing the
  veto without a proven recovery path for the multisig backstop would leave the
  protocol with no safety net at all.
