## Summary

Refactors shared types and test mocks into dedicated `@invoice-liquidity/types` and `@iln/test-utils` packages to eliminate duplication across workspaces. Implements a Telegram delivery channel for notifications. Stabilizes the SDK test suite by migrating fully to `vitest`, fixing invalid Stellar addresses, and resolving mock errors. Adds a testnet smoke test script and automates it via GitHub Actions. Fixes 125 linting errors to bring the SDK into compliance with strict TypeScript rules.

## Package Affected

- [x] SDK (@iln/sdk)
- [x] CLI (@iln/cli)
- [x] Indexer (@iln/indexer)
- [x] Notifications
- [ ] Smart Contracts (invoice_liquidity, iln_governance, iln_distribution, reputation_bonus)
- [ ] E2E Tests
- [ ] Documentation
- [x] CI/CD

## Related Issue

Closes #384, closes #368, closes #367, closes #366

## Complexity

- [ ] Trivial (typo, docs, small refactor)
- [x] Medium (new feature, bug fix)
- [ ] High (major refactor, breaking change, security-critical)

## Changes Made

- Created `@invoice-liquidity/types` and `@iln/test-utils` packages and updated all imports across `sdk`, `cli`, `indexer`, and `notifications`.
- Implemented `telegram.ts` delivery channel in the notifications service and added a `POST /subscriptions/telegram` endpoint with mocked tests.
- Migrated the SDK test suite to `vitest` and resolved strict environment mocking issues, achieving a 100% pass rate.
- Fixed 125 ESLint violations (e.g., `no-explicit-any`, `no-unused-vars`) and TypeScript errors in the SDK package.
- Added `scripts/smoke-test.ts` for End-to-End testing on the Soroban Testnet and automated it via a daily GitHub Actions workflow (`testnet-smoke.yml`).

## Changeset Included

- [ ] Yes
- [x] No (not needed for this change)

## Test Evidence

```text
> @iln/sdk@0.1.0 test /Users/0xblackadam/Downloads/ILN-Smart-Contract/sdk
> vitest run --coverage

 ✓ src/events/subscribe.test.ts (24 tests)
 ✓ src/methods/fundInvoice.test.ts (11 tests)
 ✓ src/methods/submitInvoice.test.ts (9 tests)
 ✓ src/methods/queries.test.ts (14 tests)
 ✓ src/signers/KeypairSigner.test.ts (6 tests)
 ...
 
 Test Files  16 passed (16)
      Tests  216 passed (216)
   Start at  08:18:00
   Duration  2.41s
```

## Breaking Change

- [ ] Yes (migration notes below)
- [x] No

### Migration Notes

N/A

## Security Considerations

N/A - Primarily type restructuring, test suite fixes, and CI additions. The Telegram bot token is strictly loaded via environment variables (e.g., `process.env.TELEGRAM_BOT_TOKEN`) avoiding any hardcoded secrets.

## Checklist

- [x] Code follows project conventions (see CONTRIBUTING.md)
- [x] Tests added/updated and passing
- [x] Documentation updated (if needed)
- [x] Commit message follows [Conventional Commits](https://www.conventionalcommits.org/)
- [x] No secrets or sensitive data in code
- [x] Breaking changes documented (if applicable)
- [x] Changeset added (if needed for release)
