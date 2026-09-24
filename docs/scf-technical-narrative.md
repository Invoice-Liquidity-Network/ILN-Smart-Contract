# SCF Technical Narrative

This document provides a coherent technical overview of the Invoice Liquidity
Network protocol for the Stellar Community Fund review. It synthesises the
protocol design, production-hardening work, and current audit/testing posture
into a single narrative.

---

## Protocol Overview

Invoice Liquidity Network (ILN) is a two-sided protocol on Stellar/Soroban
that connects invoice holders (freelancers, SMEs) with liquidity providers. Invoice
holders submit invoices on-chain; liquidity providers fund those invoices at a
discount and collect the face value at maturity. The protocol earns its
economic security from escrowed collateral, on-chain reputation, and a
decentralised governance layer.

### Why Stellar

Stellar's low transaction costs, built-in asset issuance, and Soroban smart
contract platform make it well-suited for invoice factoring. The protocol
leverages Stellar's native multi-asset capabilities for settling invoices in
any approved token (EURC, USDC, XLM, and others).

### Core Value Proposition

- **Invoice holders** get early access to liquidity without traditional
  factoring fees
- **Liquidity providers** earn yield by advancing capital against verified
  invoices
- **The protocol** is governed on-chain with transparent rules for dispute
  resolution, defaults, and parameter updates

---

## Architecture Summary

The protocol is a monorepo containing five Soroban smart contracts, a
TypeScript SDK, CLI, event indexer, and notifications service.

### Smart Contracts

| Contract | Role |
|----------|------|
| `invoice_liquidity` | Core escrow: submit, fund, settle, cancel, default invoices; multi-token support; reputation scoring; optional payer oracle |
| `iln_governance` | On-chain governance: proposals, voting, delegation, quorum, timelocked admin actions |
| `iln_distribution` | Yield and incentive distribution for LPs, freelancers, and payers |
| `reputation_bonus` | Reputation-based discount bonuses and invoice hooks |
| `insurance_pool` | Default-protection insurance pool for liquidity providers |

### Off-Chain Services

| Service | Role |
|---------|------|
| `@iln/sdk` | Typed TypeScript client library wrapping Soroban RPC calls |
| `@iln/cli` | Terminal wallet and invoice management tool |
| `@iln/indexer` | REST API indexing Horizon events into Postgres |
| `@iln/notifications` | Webhook, Slack, and email delivery for invoice lifecycle events |

### On-Chain State Machine

An invoice progresses through the following states:

```
Submitted → Funded → Settled (happy path)
                ↓
          Defaulted → Insurance Claim
                ↓
          Appealed → Resolved
```

The LP priority queue allows liquidity providers to compete on discount
rates, with an appeal mechanism for disputed defaults.

### Data Flow

1. **Submit** — invoice holder submits an invoice with metadata
2. **Fund** — LP commits capital at a discount rate
3. **Settle** — payer pays the face value; LP receives return
4. **Default** — if payer does not pay, the insurance pool covers the LP
5. **Governance** — parameter changes, oracle registration, and emergency
   actions go through on-chain proposals

---

## Production-Hardening Summary

This section summarises the production-hardening work completed across the
125-issue batch. The work is organised into three pillars.

### Economic Security

- Multi-token support with token management functions and associated events
- Discount rate validation and bounds checking
- Payer verification oracle interface with mock oracle for testing
- Insurance pool for default protection with test coverage
- Reputation tracking with lazy decay for inactive addresses
- Incremental vote total caching for gas-efficient governance execution

### Governance Security

- Admin veto with governance-controlled disable mechanism
- Quorum requirement for proposal passing
- Timelocked admin actions with configurable delay
- Delegate votes support for participation without direct token holding
- Pause/unpause capability with timestamp validation
- Disaster recovery multisig documentation and runbooks

### Infrastructure Hardening

- Fuzz and property-based test suite for `submit_invoice` input validation
- Benchmark regression guard with stored baselines
- CI enforcement of 95% line coverage on `invoice_liquidity`
- Storage layout documentation and migration compatibility checks
- Upgrade path testing and rollback documentation
- Monitoring runbook with health checks, alerting, and on-call routing

---

## Current Test and Audit Status

### Audit Status

An external security audit has been completed for all Soroban contracts,
deployment scripts, SDK transaction builders, indexer APIs, and notifications
webhooks. The audit covered:

- `invoice_liquidity` — core escrow and multi-token flows
- `iln_governance` — proposals, voting, and timelocked actions
- `iln_distribution` — yield distribution logic
- `reputation_bonus` — reputation-based bonuses
- `insurance_pool` — default protection pool

The audit readiness dashboard tracks all pre-audit, audit, and post-audit
items. See [`docs/audit-readiness-dashboard.md`](audit-readiness-dashboard.md)
for the full reconciliation.

### Test Coverage

| Area | Status |
|------|--------|
| Unit tests | Comprehensive across all five contracts |
| Integration tests | Cross-contract tests with mock tokens and oracles |
| Fuzz tests | Property-based tests for `submit_invoice` input validation |
| E2E tests | SDK + live local Stellar node + indexer |
| Coverage threshold | 95% line coverage enforced on `invoice_liquidity` |
| Benchmark regression | Guard script checks instruction count baselines |

### Known Gaps

- Insurance pool coverage is expanding (currently covers core default flows)
- Extended fuzz coverage for `fund_invoice` and `mark_paid` paths is in
  progress
- Multi-sig admin error cases need additional test coverage
- Some `ContractError` variants lack dedicated test cases

### Honest Assessment

The protocol is early-stage and has not yet been deployed to mainnet. The
audit provides confidence in the contract logic, but real-world usage may
reveal edge cases not covered by testing. The governance and insurance
mechanisms are functional but conservative — parameter ranges are bounded,
and emergency pause capability is available.

---

## Links

- [Architecture](Architecture.md) — full system design
- [Audit Readiness Dashboard](audit-readiness-dashboard.md) — audit tracking
- [Threat Model](threat-model.md) — security assumptions
- [Mainnet Launch Checklist](mainnet-launch-checklist.md) — launch readiness
- [CONTRIBUTING.md](../CONTRIBUTING.md) — contributor workflow
- [CHANGELOG.md](../CHANGELOG.md) — version history
