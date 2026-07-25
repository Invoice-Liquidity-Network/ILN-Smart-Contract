# ILN Security Policy

ILN spans Soroban smart contracts, a TypeScript SDK, a CLI, an indexer, and a notifications service. This policy explains what to report, how to report it, and how maintainers triage and respond.

## Scope

| Component | In scope | Primary references |
|-----------|----------|--------------------|
| Soroban contracts | Authorization, accounting, settlement, storage, upgrade, and governance defects | [contracts](../contracts), [Threat Model](threat-model.md), [Access Control](access-control.md), [Upgrade Guide](upgrade-guide.md) |
| SDK | XDR encoding, transaction construction, signing flow, contract ID handling, and client-side validation defects | [sdk](../sdk), [SDK Integration](sdk-integration.md) |
| CLI | Wallet profile handling, local secret storage, command validation, and network configuration defects | [cli](../cli), [CLI README](../cli/README.md) |
| Indexer | API behavior, event ingestion, database handling, cache safety, and denial-of-service exposure | [indexer](../indexer) |
| Notifications | Webhook subscription handling, HMAC signing, SSRF defenses, rate limiting, and circuit breaker behavior | [notifications](../notifications), [notifications README](../notifications/README.md) |
| CI/CD and deployment scripts | Secret handling, deployment correctness, artifact integrity, and release automation | [.github/workflows](../.github/workflows), [scripts](../scripts) |

Out of scope: spam, social engineering, physical attacks, attacks requiring compromised maintainer machines, and findings that only affect unsupported local configurations without a protocol or user-impact path.

## Vulnerability Classes

### Soroban Contracts

- Missing or incorrect authorization checks.
- Reentrancy-like control-flow mistakes across contract calls or token transfers.
- Storage key collision, stale storage, or incorrect storage lifetime handling.
- Incorrect invoice state transitions, settlement math, discount-rate math, or reputation updates.
- Governance bypasses, quorum mistakes, timelock bypasses, or unsafe upgrade paths.
- SAC integration mistakes, token decimal assumptions, or trustline-related accounting errors.
- Denial-of-service paths that permanently block valid invoice, settlement, or governance actions.

### SDK

- Incorrect XDR encoding or decoding that changes contract arguments or return values.
- Signing bypass, signing the wrong transaction envelope, or network-passphrase confusion.
- Contract ID, account, or asset validation bugs that route funds or calls incorrectly.
- Unsafe secret handling in helpers such as keypair signers.
- Misleading errors that cause callers to retry unsafe transactions or ignore failed submissions.

### CLI

- Secret leakage through logs, stack traces, profile files, or command output.
- Incorrect encryption/decryption or PIN handling for wallet profiles.
- Network configuration bugs that cause mainnet/testnet/local confusion.
- Commands that submit unintended transactions or skip required confirmation.

### Indexer

- SQL injection or unsafe query construction.
- API abuse, resource exhaustion, or unbounded request amplification.
- Incorrect event parsing that reports false invoice or reputation state.
- Cache poisoning or stale data presented as finalized state.
- Exposure of local database files, internal errors, or operational metadata.

### Notifications

- HMAC bypass, signature confusion, replay exposure, or unsigned payload delivery.
- SSRF through webhook URLs, redirects, DNS rebinding, or internal network targets.
- Rate-limit bypass or circuit-breaker bypass.
- Subscription authorization mistakes or cross-tenant data disclosure.
- Email delivery abuse or injection in notification content.

## Reporting

Send reports to `security@invoice-liquidity-network.local` or open a private GitHub Security Advisory for this repository.

Include as much as possible:

- Affected component and commit, tag, branch, or deployed contract ID.
- Steps to reproduce.
- Expected behavior and actual behavior.
- Impact assessment, including affected assets, users, or permissions.
- Proof-of-concept code, transaction XDR, logs, screenshots, or traces.
- Whether you believe the issue is actively exploitable.

Do not include live secrets, private keys, or personally identifiable information unless maintainers explicitly request a secure transfer method.

## Response Timelines

| Stage | Commitment |
|-------|------------|
| Acknowledgment | Within 48 hours. |
| Initial severity assessment | Within 5 business days. |
| Critical target fix window | Begin mitigation immediately; target patch or disabling mitigation within 7 days. |
| High target fix window | Target patch within 14 days. |
| Medium target fix window | Target patch within 30 days. |
| Low target fix window | Track for the next planned maintenance release or documentation update. |
| Public disclosure | Coordinated after a fix, mitigation, or maintainer-approved advisory timeline. |

Timelines can change if a fix requires third-party coordination, contract migration, or user action. Maintainers will keep reporters updated when timelines change.

## Severity Classification

| Severity | Description | Examples |
|----------|-------------|----------|
| Critical | Direct loss or theft of user funds, permanent protocol insolvency, or unauthenticated upgrade/admin takeover. | Unauthorized settlement, draining escrow, bypassing governance to upgrade contracts. |
| High | Material fund risk, broad data integrity failure, secret exposure, or reliable service compromise. | SDK signing bypass, incorrect contract call XDR, webhook HMAC bypass with sensitive impact, SQL injection that modifies indexed state. |
| Medium | Limited financial or operational impact, denial of service with recovery path, or scoped data exposure. | Localized invoice-state misreporting, rate-limit bypass, recoverable governance workflow disruption. |
| Low | Defense-in-depth issue, documentation security gap, low-impact information exposure, or hard-to-exploit edge case. | Misleading error message, missing hardening header, low-risk dependency advisory. |
| Informational | No immediate exploit path but useful for hardening. | Suggestions for stricter validation, logging improvements, or clearer runbooks. |

## Safe Harbor

We will not pursue legal action or request law-enforcement investigation for good-faith security research that:

- Avoids privacy violations, data destruction, extortion, and service disruption.
- Uses testnet, local deployments, or reporter-owned accounts whenever possible.
- Stops testing and reports promptly after discovering a plausible vulnerability.
- Does not move, drain, or lock funds that do not belong to the reporter.
- Gives maintainers reasonable time to investigate and remediate before public disclosure.

Safe harbor does not cover social engineering, phishing, physical attacks, spam, malware, or attacks against third-party services outside ILN's control.

## Maintainer Handling

1. Confirm receipt and assign a private tracking owner.
2. Reproduce the issue on a local, testnet, or isolated environment.
3. Assign severity using the table above.
4. Prepare mitigation, patch, test, and migration steps.
5. Coordinate disclosure with the reporter.
6. Publish advisory notes when appropriate, including affected versions, impact, fixed versions, and user actions.

## Security Checklist For Releases

- Contract changes include authorization, storage layout, and state-transition review.
- SDK and CLI changes include transaction, signing, and network-passphrase tests.
- Indexer changes include input-validation and API-abuse review.
- Notifications changes include HMAC, SSRF, rate-limit, and circuit-breaker tests.
- CI confirms Rust tests, Node tests, formatting, linting where available, and coverage thresholds.
- Mainnet releases require the [Mainnet Launch Checklist](mainnet-launch-checklist.md) to be signed off.
