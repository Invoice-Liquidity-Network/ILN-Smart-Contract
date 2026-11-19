# External Auditor Onboarding Package

**Last Updated:** 2026-08-30  
**Purpose:** Guide external audit firms through the ILN codebase efficiently.

---

## Recommended Reading Order

### 1. Architecture & System Overview

Start with the high-level architecture to understand the five-contract system and how components interact:

- [Architecture.md](Architecture.md) — System overview, component map, data flows
- [glossary.md](glossary.md) — Protocol and DeFi terminology

### 2. Core Contract Deep Dive

Read contracts in dependency order:

1. **`invoice_liquidity`** (core) — `contracts/invoice_liquidity/src/lib.rs`
   - Entry points: `submit_invoice`, `fund_invoice`, `mark_paid`, `claim_default`, `cancel_invoice`
   - [access-control.md](access-control.md) — Authorization matrix
   - [storage-layout.md](storage-layout.md) — On-chain storage keys
   - [error-codes.md](error-codes.md) — Error variants and remediation
   - [events.md](events.md) — Event schema

2. **`iln_governance`** — `contracts/iln_governance/src/lib.rs`
   - Proposals, voting, delegation, quorum, veto
   - [governance.md](governance.md) — Governance model

3. **`iln_distribution`** — `contracts/iln_distribution/src/lib.rs`
   - Yield and incentive distribution for LPs, freelancers, payers

4. **`insurance_pool`** — `contracts/insurance_pool/src/lib.rs`
   - Insurance pool for covering invoice defaults

5. **`reputation_bonus`** — `contracts/reputation_bonus/src/lib.rs`
   - Reputation-based discount bonuses

### 3. Security & Threat Analysis

- [threat-model.md](threat-model.md) — Threat analysis (v2.0, five-contract scope)
- [security.md](security.md) — Security policy and reporting
- [SECURITY.md](../SECURITY.md) — Root security policy

### 4. Operations & Deployment

- [mainnet-deployment-runbook.md](mainnet-deployment-runbook.md) — Deployment steps
- [mainnet-launch-checklist.md](mainnet-launch-checklist.md) — Pre-launch readiness
- [monitoring-runbook.md](monitoring-runbook.md) — Operational monitoring
- [disaster-recovery-multisig-signers.md](disaster-recovery-multisig-signers.md) — Recovery procedures

### 5. SDK & Integration

- [sdk-integration.md](sdk-integration.md) — SDK usage patterns
- [contract-abi.md](contract-abi.md) — Contract function signatures

---

## Known Accepted Risks

The following risks have been identified, assessed, and accepted for v1 launch:

| Risk | Severity | Rationale |
|------|----------|-----------|
| No timelock on governance parameter changes | Medium | ADR-005 documents decision; mitigated by multi-sig admin |
| Single-admin (no multi-sig in v1) | High | Multi-sig admin functions exist but are opt-in; production must configure |
| No reentrancy guard state flag | Medium | Soroban runtime provides some isolation; token transfers use checks-effects-interactions |
| `iln_distribution` emits no events | Medium | Acceptable for v1; indexer relies on core contract events |
| `decay_rate_bps` has no upper bound | Low | Admin-controlled; documented safe range is 0-500 |
| `high_rep_threshold` has no range check | Low | Admin-controlled; values >100 are unreachable but harmless |

---

## Areas Requiring Extra Scrutiny

Based on the hardening batch findings, focus audit attention on:

1. **Multi-sig admin flow** — `initialize_multisig_admin`, `propose_pause/unpause`, `sign_proposal`, `execute_proposal` (new in this batch)
2. **Token transfer paths** — `fund_invoice`, `mark_paid`, `claim_default`, `claim_yield` (checks-effects-interactions pattern)
3. **Oracle integration** — Stale data rejection, verified vs. unverified payer paths
4. **Fuzz test coverage** — `submit_invoice` is fuzzed; `fund_invoice` and `mark_paid` are not yet
5. **Distribution contract** — Mint authority, accrual calculations, event coverage gap
6. **Parameter bounds** — `decay_rate_bps`, `high_rep_threshold`, `min_discount_rate_bps` lack validation

---

## Audit Readiness

- [audit-readiness-dashboard.md](audit-readiness-dashboard.md) — Unified tracking of all pre-audit items
- [pre-audit-checklist.md](pre-audit-checklist.md) — Original pre-audit checklist (historical)

---

## Repository Structure

```
ILN-Smart-Contract/
├── contracts/              # Soroban smart contracts (WASM)
│   ├── invoice_liquidity/  # Core escrow contract
│   ├── iln_governance/     # Governance contract
│   ├── iln_distribution/   # Distribution contract
│   ├── insurance_pool/     # Insurance pool contract
│   ├── reputation_bonus/   # Reputation bonus contract
│   ├── fuzz/               # Fuzz testing suite
│   └── tests/              # Integration tests
├── sdk/                    # TypeScript SDK (@iln/sdk)
├── cli/                    # CLI tool (@iln/cli)
├── indexer/                # REST API event indexer
├── notifications/          # Webhook & email service
├── frontend/               # Web dApp (Next.js)
├── docs/                   # Documentation
└── scripts/                # Build, deploy, and test scripts
```

---

## CI/CD Overview

| Workflow | Purpose |
|----------|---------|
| `ci.yml` | Rustfmt, Clippy |
| `cargo-deny.yml` | Dependency audit (advisories, licenses, bans) |
| `admin-signer-check.yml` | Verifies on-chain admin matches CODEOWNERS |
| `codeql.yml` | Code security analysis |
| `e2e-allure.yml` | End-to-end test reporting |
| `storybook.yml` | Frontend component tests |
