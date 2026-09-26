# Audit Finding Remediation Runbook

**Status:** Draft — pending Security-lead sign-off  
**Owner:** Contracts lead  
**Related:** [Mainnet Rollback Runbook](mainnet-rollback-runbook.md) (live incidents), [Incident Response Runbook](incident-response-runbook.md) (operational incidents), [Security Policy](security.md#remediation-sla-by-severity) (SLA timelines)

## 1. Purpose & Scope

This runbook covers the specific workflow for remediating audit findings from external audits, third-party security reviews, or formal verification passes. It is distinct from:

- **[Incident Response Runbook](incident-response-runbook.md)**: For security incidents discovered in live protocol (exploits, data breaches, governance attacks). Uses faster timelines and may invoke emergency mechanisms like `pause()`.
- **[Mainnet Rollback Runbook](mainnet-rollback-runbook.md)**: For critical/high bugs discovered in the early-launch window requiring full protocol rollback.

This runbook is for planned, pre-disclosed audit findings: issues identified by auditors before or shortly after deployment, with time to plan a careful, tested remediation before go-live or in scheduled patch windows.

## 2. Severity and SLA Timeline

The [Security Policy](security.md#remediation-sla-by-severity) defines remediation SLAs by severity. This runbook ensures findings follow the correct path:

| Severity | SLA | Path | Decision |
|----------|-----|------|----------|
| **Critical** | 7 days | Emergency | Escalate to IC immediately; may invoke [Incident Response](incident-response-runbook.md) or [Rollback](mainnet-rollback-runbook.md) |
| **High** | 14 days | Expedited | Fast-track code review, targeted test campaign, expedited governance vote if live |
| **Medium** | 30 days | Standard | Normal code review cycle, included in next scheduled release |
| **Low** | Next release | Backlog | Standard issue queue, included with other low-priority work |

**Assignment.** Security lead assigns severity upon audit handoff, using the [severity classification in security.md](security.md#severity-classification). If severity is disputed, escalate one level — default to higher severity when in doubt.

## 3. Roles and Responsibilities

| Role | Responsibility |
|------|---|
| **Contracts lead** | Authors the fix, runs tests locally, uploads WASM to testnet for pre-deployment verification |
| **Security lead** | Assigns severity, approves the fix before code review, signs off before merge, owns the remediation SLA |
| **Code reviewer** | Reviews the fix for correctness, test coverage, and alignment with the audit finding's root cause |
| **Release lead** | Merges and stages the fix; coordinates governance vote if live on mainnet; executes deployment |
| **Auditor liaison** | (External) Confirms the fix addresses the finding and meets audit acceptance criteria |

## 4. Step-by-Step Remediation Workflow

### 4.1 Audit Handoff → Fix Assignment

1. **Receive findings.** Audit firm or reviewer submits findings via the [security reporting process](security.md#reporting) or at audit kickoff.
2. **Triage.** Security lead assigns severity per [§2](#2-severity-and-sla-timeline) and schedules a kickoff meeting with Contracts and Security leads.
3. **Confirm scope.** Identify affected contract(s), functions, and storage keys. If a finding spans multiple systems (e.g., a math error in governance calling a distribution function), confirm both leads are in scope.
4. **Create tracking issues.** Open GitHub issue(s) with `audit-remediation` label, severity label (critical, high, medium, low), and Closes reference back to the audit finding number (if external audit provided one).
5. **Assign branch.** Assign each finding a feature or fix branch:
   - For related findings affecting the same contract → one branch, multiple commits
   - For findings in different contracts → separate branches
   - Naming convention: `fix/audit-finding-<finding-id>` or `fix/<brief-description>`

### 4.2 Fix Development

1. **Root cause analysis.** Write up in the GitHub issue:
   - What was the auditor's observation?
   - What is the root cause in the code?
   - What is the impact (fund loss risk, auth bypass, etc.)?
   - Why did existing tests miss it?

2. **Author the fix.** Contracts lead:
   - Implements the fix in the feature branch
   - **Does not build/run Cargo or npm commands** — write the fix only
   - Adds inline comments if the fix is non-obvious (e.g., "Auditor finding #123: bounds check added to prevent overflow")
   - Identifies which test suite will cover the fix (existing test, new test, fuzz test)

3. **Add test coverage.** Pair with the Code reviewer to determine test strategy:
   - **Unit test:** For contract-level logic (most findings)
   - **Integration test:** For cross-contract interactions
   - **Fuzz test:** For math/arithmetic bounds
   - **E2E test:** For indexer/SDK consistency (if applicable)

4. **Document the change.** If the fix changes documented behavior:
   - Update [error-codes.md](error-codes.md), [events.md](events.md), or [storage-layout.md](storage-layout.md) as needed
   - Add a comment linking the fix to the audit finding and [Security Policy](security.md)

### 4.3 Code Review & Approval

1. **Self-review.** Contracts lead self-review:
   - Does the fix directly address the auditor's concern?
   - Are there any new risks introduced (e.g., off-by-one in the fix itself)?
   - Is test coverage sufficient to prevent regression?

2. **Security lead review.** Before code review:
   - Confirms the fix is on-track for the SLA
   - Reviews the root cause analysis for completeness
   - Approves proceeding to code review

3. **Code review.** One peer reviewer:
   - Verifies the fix is correct and test-covered
   - Checks for related issues in the same contract (e.g., if `high_rep_threshold` was unbounded, check all configurable parameters)
   - Approves or requests changes

4. **Auditor confirmation (if external audit).** If findings came from an external audit firm:
   - Share the PR (private, if repo is not yet public) with the audit liaison
   - Auditor confirms the fix meets acceptance criteria
   - Auditor signs off in a comment or separate confirmation email

### 4.4 Testnet Verification

Before merging to `main` or `dev`:

1. **Upload WASM to testnet.** Contracts lead:
   - Deploys the fixed WASM to testnet contract
   - Runs smoke tests (see [developer-quickstart.md](developer-quickstart.md#smoke-tests))
   - Confirms no regressions on existing invoices/operations

2. **Indexer/SDK/CLI tests.** If the fix changes contract events or return values:
   - Verify SDK type definitions reflect any changes
   - Run indexer integration tests
   - Confirm CLI commands still work as expected

3. **Sign-off.** Contracts lead confirms testnet verification in the GitHub issue.

### 4.5 Merge & Release

**For findings discovered before mainnet launch:**

1. Merge to `dev` branch (standard code review, no governance vote needed)
2. Include in the next scheduled release (alpha → beta → mainnet)

**For findings discovered on live mainnet (Critical/High):**

1. Merge to `dev` immediately
2. Create a GitHub release tag (e.g., `v1.2.1`) with a patch note identifying the fix and its severity
3. **Governance vote (if applicable).** If the fix changes contract logic that is admin-controlled:
   - Create a governance proposal to upgrade the contract to the patched WASM
   - Vote passes per normal governance rules (quorum, timelock)
   - Release lead executes the upgrade (see [upgrade-guide.md](upgrade-guide.md#execution-and-validation))

4. **Public advisory.** Security lead publishes a [SECURITY.md](../SECURITY.md) advisory with:
   - Affected versions
   - Severity and impact
   - Fixed version(s)
   - Workaround (if available before fix)
   - Timeline (severity → SLA → disclosure timeline)

## 5. Test Coverage Requirements by Severity

| Severity | Minimum Coverage | Examples |
|----------|---|---|
| **Critical** | All: unit + integration + fuzz + e2e | Explicit test case for the exact bug scenario; fuzz test for bounds; e2e test for cross-contract impact |
| **High** | Unit + integration + (fuzz OR e2e) | Test the specific code path; integration test if cross-contract; fuzz test if math, e2e if affects API |
| **Medium** | Unit + (integration OR fuzz) | Test the specific code path and one integration test OR fuzz test if applicable |
| **Low** | Unit only | Test the code path the auditor identified |

All test cases must be in the feature branch *before* code review and merged *with* the fix.

## 6. Common Finding Patterns & Remediation Paths

### 6.1 Bounds Checking (Math Overflow)

**Auditor's finding:** Parameter `X` is unbounded and could overflow / be set to unreachable values.

**Remediation path:**
1. Add bounds check in the setter: `assert!(x <= MAX && x >= MIN)`
2. Document bounds in the setter's doc comment
3. Add unit test: `fn test_x_bounds_enforced()`
4. Update [access-control.md](access-control.md#parameter-safety) or the governance playbook with the bounds
5. Fuzz test (optional): `proptest!(prop_x in MIN..=MAX)`

### 6.2 Authorization Missing or Incorrect

**Auditor's finding:** Function `f()` can be called by unauthorized callers / admin check is missing.

**Remediation path:**
1. Add or fix `require_auth(&caller)` or `require_admin()`
2. Add unit test: `fn test_f_requires_auth_fails_for_unauthorized()` and `test_f_succeeds_for_authorized()`
3. Integration test (optional): test the call fails end-to-end when invoked from wrong account
4. Update [access-control.md](access-control.md) matrix if the function's auth requirements changed

### 6.3 Storage Key Collision or Lifetime Issue

**Auditor's finding:** Storage key `K` can collide with another key / storage lifetime is incorrect.

**Remediation path:**
1. Verify storage key structure in [storage-layout.md](storage-layout.md) — ensure keys are unique
2. Add comment in `DataKey` enum explaining the key structure
3. Add unit test: `fn test_storage_keys_unique()` (if not already present)
4. Integration test: confirm stale keys are expired and don't interfere with new state
5. Update [storage-layout.md](storage-layout.md) documentation

### 6.4 Missing or Incomplete State Transition

**Auditor's finding:** Invoice state transitions are incomplete / an invoice can be marked paid twice / status is not updated atomically.

**Remediation path:**
1. Trace the state machine in [Architecture.md](Architecture.md) and confirm the transition is documented
2. Implement the missing check (e.g., `assert_eq!(invoice.status, FUNDED)` before marking paid)
3. Add unit test: `fn test_invoice_state_transition_X_to_Y()` for each transition
4. Fuzz test: `proptest!(state in any_valid_state, action in any_action)` to catch invalid transitions
5. Update the event emission if the state change should trigger an event (check [events.md](events.md))

## 7. Cross-Linking and Documentation Updates

After a fix is merged, update these documents to reflect the finding and its resolution:

1. **[Audit Readiness Dashboard](audit-readiness-dashboard.md).** Update the item's status to ✅ Complete with the PR/commit hash.
2. **[Security Policy](security.md).** If the finding revealed a new vulnerability class, add it to the Vulnerability Classes section.
3. **Component docs** (error-codes, events, storage-layout, access-control): Update as needed per §4.2.
4. **ADRs or decision records:** If the finding requires an architecture change, author an ADR (see [adr/](adr/)) and link it.

## 8. Escalation and Emergency Paths

### Escalate to Incident Response if:
- Finding is Critical and live on mainnet with active exploit
- Finding is Critical and discovered hours before scheduled mainnet launch
- Fix requires emergency governance vote or `pause()`

See [incident-response-runbook.md](incident-response-runbook.md) for the escalated path.

### Escalate to Rollback if:
- Critical bug discovered post-launch with significant TVL at risk
- Fix requires storage migration that cannot be done in-place
- Trust in the current contracts is shaken and a clean-slate redeployment is preferred

See [mainnet-rollback-runbook.md](mainnet-rollback-runbook.md) for the rollback path.

## 9. Checklist for Remediation Sign-Off

Before closing the remediation issue, confirm all items:

- [ ] Root cause analysis documented and approved by Security lead
- [ ] Fix implemented and self-reviewed by Contracts lead
- [ ] Test coverage added (unit + integration per severity)
- [ ] Code review completed and approved
- [ ] Auditor confirmation received (if external audit)
- [ ] Testnet verification passed
- [ ] Documentation updated (error-codes, events, access-control, etc.)
- [ ] GitHub issue(s) linked and properly labeled (`audit-remediation`, severity)
- [ ] Merged to `dev` and/or staged for release
- [ ] Public advisory drafted (if applicable)
- [ ] SLA met or extension documented with rationale

---

## Related Reading

- **[Security Policy](security.md)** — Vulnerability reporting, severity classification, remediation SLAs, disclosure timelines
- **[Incident Response Runbook](incident-response-runbook.md)** — For live incidents with expedited decision-making and `pause()` authority
- **[Mainnet Rollback Runbook](mainnet-rollback-runbook.md)** — For critical bugs post-launch requiring rollback or full redeploy
- **[Upgrade Guide](upgrade-guide.md)** — Governance-based contract upgrades and WASM deployment mechanics
- **[Access Control](access-control.md)** — Authorization matrix, rate limiting, pause semantics
