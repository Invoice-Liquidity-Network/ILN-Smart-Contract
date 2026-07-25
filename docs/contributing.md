# Unified ILN Contribution Guide

This guide describes how to contribute across the entire Invoice Liquidity Network (ILN) ecosystem. ILN spans multiple repositories; this document explains how they relate and how to coordinate changes across them.

---

## Repository Structure

ILN is organized as a three-tier architecture:

| Repository | Contents | Responsibility |
|------------|----------|----------------|
| **ILN-Smart-Contract** (this repo) | Soroban contracts (`contracts/`), TypeScript SDK (`sdk/`), CLI (`cli/`), indexer (`indexer/`), notifications (`notifications/`), documentation (`docs/`), deployment scripts (`scripts/`) | Smart contract logic, off-chain services, SDK, tooling |
| **ILN-Frontend** (external) | Web dApp, mobile app, dashboard UI | End-user interfaces consuming SDK and indexer APIs |
| **ILN-Infra** (external) | Helm charts, Terraform, CI/CD pipelines | Infrastructure-as-code for production deployments |

### When to contribute to each repo

- **This repo (ILN-Smart-Contract):** Contract changes, SDK additions, new indexer endpoints, notification service features, CLI commands, documentation, deployment scripts.
- **ILN-Frontend:** UI/UX changes, new screens, wallet integration updates, design system changes.
- **ILN-Infra:** Deployment configuration, monitoring setup, secret management, environment provisioning.

---

## Cross-Repo PR Process

Some changes span multiple repositories (e.g., adding a new contract function requires SDK updates, which may require frontend updates). Follow this process:

1. **Start with the contract** — Make the on-chain change first (this repo). Open a PR and tag it with the cross-repo label.
2. **Update the SDK** — Once the contract PR is merged, update `@iln/sdk` to expose the new function. Reference the contract PR in the description.
3. **Update downstream consumers** — CLI, indexer, notifications, and frontend can be updated in parallel or sequentially. Each should reference the SDK PR.

### PR naming for cross-repo changes

Use matching branch names across repos when possible:
- `feat/escrow-refund` in ILN-Smart-Contract
- `feat/escrow-refund` in ILN-Frontend

### Cross-repo dependency tracking

When opening a PR that depends on an unmerged PR in another repo:
- Add `depends-on: #<PR-number>` in the PR description
- CI will not merge until the dependency is resolved

---

## Coding Standards (All Repos)

### Conventional Commits

All repositories follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <description>
```

| Type | Usage |
|------|-------|
| `feat` | New feature or contract function |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `refactor` | Code change that neither fixes nor adds |
| `test` | Adding or updating tests |
| `chore` | Build, tooling, dependencies |

Breaking changes add `!` after the type and include `BREAKING CHANGE:` in the footer.

### Branch Naming

```
<type>/<short-description>
```

Examples: `feat/multi-token-support`, `fix/overflow-in-discount`, `docs/architecture`.

### PR Size

Keep PRs focused. A single PR should:
- Address one concern (one feature, one bug, one refactor)
- Be reviewable in under 30 minutes
- Not exceed 400 lines changed (excluding generated files and tests)

Large features must be split into stacked PRs.

### Code Review Requirements

- At least one maintainer approval required
- All CI checks must pass
- No unresolved comments at merge time
- Changes to `contracts/` require a contract-team reviewer

---

## Proposing Significant Protocol Changes

For changes that affect the protocol design, economic model, or security model:

1. **Start a discussion** — Open a [GitHub Discussion](https://github.com/Invoice-Liquidity-Network/ILN-Smart-Contract/discussions) with the `proposal` category.
2. **Write a brief** — Describe the problem, proposed solution, alternatives considered, and security implications.
3. **Socialize** — Allow at least 72 hours for feedback from maintainers and community.
4. **ADR** — If accepted, document the decision as an Architecture Decision Record in `docs/adr/`.
5. **Implementation** — Proceed with implementation following the standard PR process.

### Governance

On-chain parameter changes (discount rate bounds, fee schedules, contract upgrades) go through the `iln_governance` contract. See [Governance](governance.md) for the full proposal lifecycle.

---

## Getting Started

1. Read this repo's [CONTRIBUTING.md](../CONTRIBUTING.md) for environment setup, build, and test instructions.
2. Browse open issues labeled `good first issue` or `help wanted`.
3. Join the [Discussions](https://github.com/Invoice-Liquidity-Network/ILN-Smart-Contract/discussions) for questions.

---

## Questions?

Open a [GitHub Discussion](https://github.com/Invoice-Liquidity-Network/ILN-Smart-Contract/discussions) or comment on the relevant issue.
