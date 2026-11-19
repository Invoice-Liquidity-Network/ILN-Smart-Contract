# Game-Day Exercise Plan

**Status:** Draft — pending first rehearsal sign-off.
**Owner:** Security lead + Infrastructure lead.
**Scope:** A structured, timed exercise that validates the incident response runbook ([incident-response-runbook.md](incident-response-runbook.md)) and its component sub-procedures against a realistic, multi-failure scenario on the testnet deployment.

---

## 1. Purpose

Runbooks that have never been rehearsed under simulated pressure often have gaps that only surface during a real incident. This game-day exercise:

- Validates that the incident response runbook's first-15-minutes procedure, severity classification, role assignments, and communication templates work as written.
- Tests that component runbooks (indexer incident, rollback, notifications operations, monitoring) can be invoked as sub-procedures without confusion.
- Exercises multiple runbooks simultaneously under a compound scenario to expose coordination gaps.
- Produces a post-exercise report with actionable findings and follow-up issues.

---

## 2. Scenario: "Oracle Circuit Trip + Critical Contract Bug"

A compound failure designed to exercise on-chain emergency actions, off-chain incident response, and cross-service coordination simultaneously.

### Injected faults

| # | Fault | Target | Runbook exercised | Expected first action |
|---|-------|--------|-------------------|----------------------|
| 1 | **Oracle circuit trips** — the TWAP oracle reports a stale/manipulated price that exceeds the circuit-breaker threshold, causing `oracle_circuit_tripped` on `invoice_liquidity` | Smart contract | [incident-response-runbook.md §6](incident-response-runbook.md#6-response-by-incident-class), [oracle-attack-economics.md](oracle-attack-economics.md) | IC declares incident; assess whether `remove_oracle` or `pause()` is needed |
| 2 | **Simulated contract bug** — a "critical vulnerability" is reported (injected via a test payload or a mock governance proposal that should be blocked but isn't) | Smart contract | [incident-response-runbook.md §4](incident-response-runbook.md#4-decision-authority-for-pause), [mainnet-rollback-runbook.md](mainnet-rollback-runbook.md) | IC + Security lead agree to `pause()`; Release lead executes |
| 3 | **Indexer ingestion stalls** — ingestion leader lease expires or is deliberately released, causing `lagLedgers` to exceed `HEALTH_MAX_LAG_LEDGERS` | Indexer | [indexer-incident-runbook.md](indexer-incident-runbook.md), [monitoring-runbook.md](monitoring-runbook.md) | Infrastructure lead detects via `/health`; initiates lease recovery or restore |
| 4 | **Notifications circuit breaker opens** — a webhook endpoint is deliberately failed to trip the circuit breaker, simulating downstream abuse | Notifications | [notifications-operations.md](notifications-operations.md) | Infrastructure lead checks circuit-breaker state; contacts "subscriber" |

### Scenario timeline

| Phase | Duration | Events |
|-------|----------|--------|
| **Setup** | 15 min | Deploy fresh testnet state; fund canary wallets; confirm all services healthy; distribute role cards. |
| **Injection** | 5 min | Faults 1–4 are injected in sequence (2-min intervals). Alerts begin firing. |
| **Detection & Response** | 30 min | Team follows the incident response runbook. Multiple workstreams run in parallel. |
| **Recovery** | 20 min | Execute recovery per component runbooks. Verify state. `unpause()` if paused. |
| **Debrief** | 30 min | Immediate hot-wash. Fill out post-exercise report template. |

**Total exercise duration:** ~100 minutes (2 hours with buffer).

---

## 3. Roles (exercise participants)

| Role | Real responsibility | Exercise duty |
|------|---------------------|---------------|
| **Exercise Lead** | Facilitator, not part of the response team | Injects faults, keeps the clock, enforces timeboxes, does not help the team |
| **Incident Commander** | On-call IC from the response team | Declares the incident, assigns workstreams, runs the timeline |
| **Security Lead** | Security lead | Confirms vulnerability severity, signs off on `pause()` decision |
| **Contracts Lead** | Contracts lead | Confirms on-chain root cause, prepares rollback if needed |
| **Release Lead** | Release lead | Executes on-chain commands (`pause()`, `remove_oracle`, `veto_proposal`) |
| **Infrastructure Lead** | Infrastructure lead | Owns indexer + notifications recovery |
| **Community Lead** | Community lead | Drafts user communication (held until Security sign-off) |

Each participant receives a **role card** before the exercise listing their responsibilities, the runbook sections they own, and the tools/commands available to them.

---

## 4. Pre-exercise checklist

| # | Item | Owner | Done |
|---|------|-------|------|
| 1 | Testnet contracts deployed and verified | Release lead | ☐ |
| 2 | Indexer running, ingestion caught up, `/health` returning `ok` | Infrastructure lead | ☐ |
| 3 | Notifications service running, test webhook endpoint registered | Infrastructure lead | ☐ |
| 4 | Monitoring alerts configured and routing to the exercise incident channel | Infrastructure lead | ☐ |
| 5 | Canary wallet funded (for synthetic monitoring, see [scripts/synthetic-canary.ts](../scripts/synthetic-canary.ts)) | Infrastructure lead | ☐ |
| 6 | Role cards distributed to all participants | Exercise Lead | ☐ |
| 7 | Exercise incident channel created (Slack/Discord/etc.) | Community lead | ☐ |
| 8 | Timer / stopwatch ready | Exercise Lead | ☐ |
| 9 | Post-exercise report template pre-filled with metadata | Exercise Lead | ☐ |
| 10 | All participants confirmed availability | Exercise Lead | ☐ |

---

## 5. Exercise execution

### Phase 1: Setup (15 min)

1. Exercise Lead confirms all pre-exercise checklist items.
2. Exercise Lead announces the scenario overview (no specifics on fault timing).
3. Participants confirm they have the runbooks open and know their role.
4. Exercise Lead starts the clock.

### Phase 2: Fault Injection (5 min)

The Exercise Lead injects faults in sequence:

| Time | Fault | Injection method |
|------|-------|------------------|
| T+0:00 | Oracle circuit trip | Call `remove_oracle` or trigger circuit via test oracle manipulation |
| T+2:00 | Contract bug reported | Post a "critical vulnerability" message in the incident channel with a mock reproduction |
| T+4:00 | Indexer ingestion stalls | Stop the ingestion writer or release the leader lease |
| T+6:00 | Notifications circuit breaker opens | Send malformed webhooks to trip the breaker on the test endpoint |

### Phase 3: Detection & Response (30 min)

The team responds following the incident response runbook:

1. **IC declares the incident** — opens the incident channel, states severity, names themselves IC.
2. **IC pages roles** — per [§2](incident-response-runbook.md#2-severity-classification) of the incident runbook.
3. **First 15 minutes** — team follows [§5](incident-response-runbook.md#5-the-first-15-minutes):
   - Snapshot state (`get_protocol_status()`, `/health`, contract stats).
   - Contain: IC authorizes `pause()` if Critical.
   - Assign workstreams.
4. **Parallel workstreams:**
   - **Contracts/Security:** Investigate oracle circuit + contract bug; decide on `remove_oracle` vs `pause()`.
   - **Infrastructure:** Detect indexer stall via `/health`; initiate recovery per [indexer-incident-runbook.md](indexer-incident-runbook.md).
   - **Infrastructure:** Check notifications circuit breaker; verify delivery logs per [notifications-operations.md](notifications-operations.md).
   - **Community:** Draft user communication (held until Security sign-off).
5. **Exercise Lead monitors** and injects time pressure (announcements like "10 minutes remaining", "users are asking questions").

### Phase 4: Recovery (20 min)

1. Execute recovery per component runbooks:
   - `unpause()` after root cause confirmed and fix verified.
   - Restore indexer ingestion.
   - Verify notifications delivery resumes.
2. Verify final state (`get_contract_stats()`, `/health`, reconciliation).
3. Exercise Lead confirms "all clear".

### Phase 5: Debrief (30 min)

1. **Hot-wash:** Each participant shares what worked, what didn't, and what was confusing.
2. **Timelines:** Compare actual detection-to-resolution time against SLOs in [docs/slos.md](slos.md).
3. **Fill out the post-exercise report** (see [§7](#7-post-exercise-report-template)).

---

## 6. Success criteria

| Criterion | Pass | Fail |
|-----------|------|------|
| Incident declared within 5 min of first alert | ✓ | |
| All paged roles acknowledged within 10 min | ✓ | |
| `pause()` executed within 15 min of declaration (if Critical) | ✓ | |
| User communication drafted and signed off within 20 min | ✓ | |
| Indexer recovered within its RTO (≤ 30 min) | ✓ | |
| Notifications circuit breaker tripped and investigated | ✓ | |
| All runbook steps followed as written (no improvised shortcuts) | ✓ | |
| Post-exercise report completed within 24 hours | ✓ | |

---

## 7. Post-exercise report template

Use the [postmortem-template.md](postmortem-template.md) structure, adapted for a planned exercise:

### Metadata

| Field | Value |
|-------|-------|
| Exercise ID | GD-YYYY-MM-DD |
| Date | |
| Duration | |
| Participants | |
| Scenario | Oracle circuit trip + critical contract bug + indexer stall + notifications breaker |

### Findings

| # | Finding | Category | Severity | Runbook affected | Follow-up issue |
|---|---------|----------|----------|------------------|-----------------|
| 1 | | Gap / Unclear / Missing / Slow | P0–P2 | | |

### What went well

<!-- List things that worked as documented. -->

### What went poorly

<!-- List things that were confusing, slow, or didn't work. -->

### Runbook gaps identified

<!-- Specific sections that were unclear, incomplete, or wrong. -->

### Action items

| # | Action | Owner | Priority | Due Date | Issue # |
|---|--------|-------|----------|----------|---------|
| 1 | | | P0 / P1 / P2 | | |

---

## 8. Rehearsal schedule

| Milestone | Timing | Notes |
|-----------|--------|-------|
| **First rehearsal** | Pre-mainnet (current) | Validate all runbooks work end-to-end on testnet |
| **Quarterly rehearsal** | Every 3 months post-mainnet | Rotate scenarios; include new failure modes as the system evolves |
| **Post-incident rehearsal** | Within 2 weeks of any Severity 1/2 incident | Re-run the specific scenario that caused the incident to validate fixes |
| **New component rehearsal** | Within 1 month of adding a major component (e.g. new oracle type, new notification channel) | Ensure the component's runbook is integrated into the exercise |

---

## 9. Scenario variants for future exercises

| Variant | Description | Additional runbooks exercised |
|---------|-------------|----------------------------|
| **Governance takeover** | Malicious proposal submitted + quorum reached | [governance-security-summary.md](governance-security-summary.md), `veto_proposal` path |
| **Admin key compromise** | Single admin key reported compromised | [disaster-recovery-multisig-signers.md](disaster-recovery-multisig-signers.md) |
| **Full data loss** | Indexer database corrupted, no recent backup | [indexer-incident-runbook.md](indexer-incident-runbook.md) Option C (full resync) |
| **Cascading failure** | RPC down + indexer stale + notifications circuit open | All component runbooks simultaneously |
| **Upgrade gone wrong** | Contract upgrade deployed with a bug | [upgrade-guide.md](upgrade-guide.md), [mainnet-rollback-runbook.md](mainnet-rollback-runbook.md) |

---

## 10. Cross-references

| Document | Relationship |
|----------|-------------|
| [incident-response-runbook.md](incident-response-runbook.md) | Primary runbook validated by this exercise |
| [indexer-incident-runbook.md](indexer-incident-runbook.md) | Sub-procedure for indexer recovery |
| [notifications-operations.md](notifications-operations.md) | Sub-procedure for notifications recovery |
| [monitoring-runbook.md](monitoring-runbook.md) | Alert thresholds and on-call escalation validated |
| [mainnet-rollback-runbook.md](mainnet-rollback-runbook.md) | Rollback decision framework if `pause()` escalates |
| [postmortem-template.md](postmortem-template.md) | Template for post-exercise report |
| [slos.md](slos.md) | SLO targets used to evaluate response times |
| [observability-standards.md](observability-standards.md) | Correlation ID tracing validated during multi-service incident |
