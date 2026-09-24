# Governance Operations Playbook

**Status:** Living document — reviewed on the cadence in [`review-cadence.md`](review-cadence.md).  
**Audience:** Maintainers, governance proposers, and emergency operators.

## Purpose

Day-to-day and emergency procedures for ILN governance: proposals, voting, timelocks, pause, oracle registry changes, and insurance parameter updates.

## Roles

| Role | Responsibility |
|------|----------------|
| Docs lead (`@Keengfk/docs-lead`) | Keeps this playbook and economics/risk docs current |
| Contracts / security leads | Parameter and pause decisions; incident severity |
| Governance proposers | Draft proposals with clear motivation, bounds, and rollback |

See [CODEOWNERS](../.github/CODEOWNERS) for review routing.

## Steady-state operations

1. **Propose** — Prefer governance actions over hot admin keys once the multisig/governance handoff is complete ([`governance.md`](governance.md), ADR-012).
2. **Vote** — Respect voting window, quorum, and checkpoint-aged snapshots; no flash-loan first-vote shortcuts.
3. **Timelock / execute** — Wait execution delay; smoke-test after execution.
4. **Communicate** — Record material parameter changes in CHANGELOG and, for mainnet, user-facing launch notes.

## Emergency paths

| Situation | First action | Follow-up |
|-----------|--------------|-----------|
| Active fund loss / critical exploit | Consider `pause()`; open private security path | Incident runbook; advisory |
| Malicious or stale oracle | Remove/replace via admin or governance | Re-read oracle attack economics |
| Insurance pool stress | Check reserve circuit breaker / claims pause | Parameter proposal if needed |
| Multisig / signer loss | Disaster-recovery multisig runbook | Rotate signers; verify CI signer check |

Primary references: [`incident-response-runbook.md`](incident-response-runbook.md), [`multisig-admin-runbook.md`](multisig-admin-runbook.md), [`disaster-recovery-multisig-signers.md`](disaster-recovery-multisig-signers.md).

## Parameter change checklist

Before proposing discount, oracle-age, insurance premium/coverage, or pause-policy changes:

- [ ] Cite the assumption being changed ([`lp-risk-management-guide.md`](lp-risk-management-guide.md), [`token-economics.md`](token-economics.md))
- [ ] Bound the new value (no unbounded invoice size, no unbounded premium)
- [ ] Note impact on LPs already enrolled or in-flight invoices
- [ ] Link simulation / testnet evidence when available
- [ ] Schedule post-change review under [`review-cadence.md`](review-cadence.md)

## Related reading

- [Governance](governance.md)
- [Governance security summary](governance-security-summary.md)
- [Access control](access-control.md)
- [Protocol economics & risk index](index.md#protocol-economics--risk)
