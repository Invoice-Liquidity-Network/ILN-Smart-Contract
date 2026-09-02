# Pre-Audit Security Checklist

**Document Version:** 1.0  
**Status:** Active  
**Audit Target:** ILN Smart Contract — `invoice_liquidity`, `iln_governance`, `iln_distribution`, `reputation_bonus`  
**Testnet Contract:** `CD3TE3IAHM737P236XZL2OYU275ZKD6MN7YH7PYYAXYIGEH55OPEWYJC`

This checklist must be completed and signed off by a maintainer before the formal security audit begins. Each item links to the relevant issue, document, or code location. Items marked ❌ are open work tracked as separate issues; this PR does not close them.

---

## How to Use This Checklist

1. Work through each section in order.
2. For each item, mark it **✅ Pass**, **❌ Fail / Open**, or **⚠️ Partial**.
3. For any ❌ or ⚠️, record the blocking issue number in the "Notes" column.
4. All items must reach ✅ before the audit firm is given repository access.
5. Final sign-off goes in the [Maintainer Sign-Off](#maintainer-sign-off) section at the bottom.

---

## 1. Test Coverage

Goal: ≥ 95% line coverage on `invoice_liquidity` (the primary audit target), measured by `cargo-tarpaulin`.

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1.1 | `cargo tarpaulin -p invoice_liquidity --fail-under 95` passes in CI | ⚠️ Partial | CI job exists (`coverage` job in `.github/workflows/ci.yml`) but `continue-on-error` is not set — verify it is actually blocking merges |
| 1.2 | `iln_distribution` unit tests cover LP double-claim, freelancer+payer earn, late settlement | ✅ Pass | `lp_earns_on_funding_and_cannot_double_claim`, `freelancer_and_payer_earn_on_settlement`, `late_settlement_does_not_reward_payer` |
| 1.3 | `iln_governance` has integration tests covering proposal lifecycle, quorum, veto, timelock | ✅ Pass | `governance_main_integration_test.rs` and additional transition tests exercise `Active`, `Passed`, `Rejected`, `Executed`, `Vetoed` and verify illegal transitions (see `contracts/tests/governance_main_integration_test.rs`) |
| 1.4 | Multi-sig admin paths covered: `initialize_multisig_admin`, `propose_pause/unpause`, `sign_proposal`, `execute_proposal`, expiry, threshold-not-reached | ❌ Open | `tests_multisig_admin` module exists; confirm all error variants (`AlreadySigned`, `ProposalExpired`, `ThresholdNotReached`) have dedicated test cases |
| 1.5 | Oracle integration tests cover: verified payer, unverified payer, stale data rejection | ✅ Pass | `oracle_integration_test.rs` now covers the stale-data boundary at `max_oracle_age_ledgers - 1`, `max_oracle_age_ledgers`, and `max_oracle_age_ledgers + 1` with `fund_invoice(..., require_oracle_verification: true)` returning `ContractError::OracleDataStale` |
| 1.6 | Error-case tests cover every `ContractError` variant | ❌ Open | `tests_error_cases` module exists; audit that no variant is untested |
| 1.7 | Fuzz suite (`iln_fuzz`) has been run for ≥ 1000 cases and all snapshots committed | ✅ Pass | 1000 snapshot JSON files present in `contracts/fuzz/test_snapshots/tests/` |

### Fuzz Snapshot Review Report

- **Script added:** `scripts/review-fuzz-snapshots.js` — scans `contracts/fuzz/test_snapshots/tests/` for syntax errors and panic/error indicators.
- **Run date:** 2026-08-30
- **Results:** 1000 snapshots scanned, 0 flagged — no obvious panic/error indicators found. See `scripts/review-fuzz-snapshots.js` for heuristics and manual review guidance.
| 1.8 | Coverage report artifact is uploaded and retained in CI | ✅ Pass | `upload-artifact` step in `coverage` job uploads `coverage/cobertura.xml` |

**Commands:**
```bash
# Run coverage locally
cargo install cargo-tarpaulin --locked
cargo tarpaulin -p invoice_liquidity \
  --out Xml --output-dir coverage \
  --fail-under 95 \
  --exclude-files 'contracts/invoice_liquidity/src/tests_*'

# Run fuzz tests
cargo test -p iln_fuzz

# Run full test suite
cargo test --workspace --lib
cargo test --workspace --tests --all
```

---

## 2. Static Analysis — Zero Clippy Warnings

| # | Item | Status | Notes |
|---|------|--------|-------|
| 2.1 | `cargo clippy --all-targets -- -D warnings` exits 0 | ✅ Pass | `clippy` job in CI enforces `-D warnings` |
| 2.2 | No `#[allow(clippy::...)]` suppressions added without a documented reason | ⚠️ Partial | `#![allow(clippy::too_many_arguments)]` is present in `lib.rs` and `fuzz/src/lib.rs`; this is justified by Soroban macro-generated client code — confirm comment explains this |
| 2.3 | `cargo deny check advisories licenses bans sources` passes | ✅ Pass | `cargo-deny` workflow runs on push to `main` and weekly |
| 2.4 | No `unsafe` blocks in any contract crate | ❌ Open | Verify with `grep -r "unsafe" contracts/` — all crates are `#![no_std]` and should have zero `unsafe` |

**Commands:**
```bash
cargo clippy --all-targets -- -D warnings
cargo deny check advisories licenses bans sources
```

---

## 3. Documentation Completeness

All public functions must have doc comments. The audit firm will use these to understand intent vs. implementation.

| # | Item | Status | Notes |
|---|------|--------|-------|
| 3.1 | Every `pub fn` in `invoice_liquidity/src/lib.rs` has a doc comment with: description, `# Arguments`, `# Returns`, `# Errors`, and `Access:` annotation | ⚠️ Partial | Most functions have doc comments; verify `submit_invoices_batch`, `join_fund_queue`, `fund_invoice`, `mark_paid`, `claim_yield`, `claim_default` are fully documented |
| 3.2 | Every `pub fn` in `iln_distribution/src/lib.rs` has a doc comment | ❌ Open | `accrue_lp`, `accrue_settlement`, `claim_tokens`, `get_accrual` have minimal or no doc comments |
| 3.3 | Every `pub fn` in `iln_governance` has a doc comment | ❌ Open | Verify governance contract public interface is fully documented |
| 3.4 | `docs/contract-abi.md` matches all current public function signatures | ❌ Open | ABI doc may be stale after multi-sig admin functions were added (Issue #124) |
| 3.5 | `docs/events.md` is accurate — all events listed as "missing" are either implemented or tracked as open issues | ❌ Open | `InvoiceExpired`, `InvoiceDisputed`, `ReputationUpdated`, `LPPositionTransferred` listed as missing; `TokenAdded`/`TokenRemoved` discrepancy between docs and code needs resolution |
| 3.6 | `docs/error-codes.md` covers every `ContractError` variant with cause and remediation | ❌ Open | Verify `WhitelistTooLarge`, `InvalidMultisigConfig`, `NotAuthorizedSigner`, `AlreadySigned`, `ProposalNotFound`, `ProposalAlreadyExecuted`, `ProposalExpired`, `ThresholdNotReached`, `FeeOnTransferToken` are all documented |
| 3.7 | `docs/storage-layout.md` reflects all current `StorageKey` / `DataKey` variants | ❌ Open | Multi-sig storage keys (`MultisigAdmin`, `MultisigProposal`, `NextProposalId`) and LP portfolio stats keys may be missing |
| 3.8 | `docs/Architecture.md` reflects the current 5-contract system including `reputation_bonus` | ⚠️ Partial | Verify architecture diagram includes `reputation_bonus` and the distribution contract mint flow |
| 3.9 | `CHANGELOG.md` is up to date with all unreleased changes | ✅ Pass | Changelog is auto-generated via `git-cliff`; run `make changelog` to refresh before audit |
| 3.10 | `CONTRIBUTING.md` and `SECURITY.md` are present and accurate | ⚠️ Partial | `CONTRIBUTING.md` exists; verify `SECURITY.md` is present and contains responsible disclosure contact |

---

## 4. Fuzz Tests

| # | Item | Status | Notes |
|---|------|--------|-------|
| 4.1 | `prop_submit_invoice_never_panics` runs 1000 cases without panic | ✅ Pass | 1000 snapshot files committed |
| 4.2 | Fuzz coverage extended to `fund_invoice` with random LP addresses and amounts | ❌ Open | Currently only `submit_invoice` is fuzzed; `fund_invoice` handles token transfers and is higher risk |
| 4.3 | Fuzz coverage extended to `mark_paid` with random payer addresses and timestamps | ❌ Open | Settlement path with timestamp boundary conditions should be fuzz-tested |
| 4.4 | Fuzz tests run in CI (not just locally) | ❌ Open | `iln_fuzz` is not in the CI `test` job; add `cargo test -p iln_fuzz` to CI |
| 4.5 | All fuzz snapshot files are committed and reviewed for unexpected error patterns | ✅ Pass | 1000 valid snapshot artifacts are committed and checked by the `snapshot_review_validates_committed_fuzz_artifacts` gate; review for unexpected `Ok` outcomes on clearly invalid inputs remains part of the manual audit trail |

**Commands:**
```bash
# Run fuzz tests
cargo test -p iln_fuzz

# Run with verbose output to see case distribution
cargo test -p iln_fuzz -- --nocapture
```

---

## 5. Event Coverage

All state transitions must emit an event. This enables indexers to reconstruct state and auditors to verify the audit trail.

| # | Item | Status | Notes |
|---|------|--------|-------|
| 5.1 | `InvoiceSubmitted` emitted on every successful `submit_invoice` | ✅ Pass | Verified in `lib.rs` |
| 5.2 | `InvoiceFunded` emitted on every successful `fund_invoice` | ✅ Pass | Verified in `lib.rs` |
| 5.3 | `InvoicePaid` emitted on every successful `mark_paid` | ✅ Pass | Verified in `lib.rs` |
| 5.4 | `InvoiceDefaulted` emitted on every successful `claim_default` | ✅ Pass | Verified in `lib.rs` |
| 5.5 | `InvoiceCancelled` emitted on every successful `cancel_invoice` | ✅ Pass | Verified in `lib.rs` |
| 5.6 | `InvoiceExpired` emitted on every successful `expire_invoice` | ❌ Open | Listed as missing in `docs/events.md`; `expire_invoice` exists but event is not emitted |
| 5.7 | `InvoiceDisputed` emitted when a dispute is opened | ❌ Open | Listed as missing in `docs/events.md` |
| 5.8 | `ReputationUpdated` emitted on every reputation score change | ❌ Open | No reputation change events emitted anywhere; auditors cannot verify score integrity without this |
| 5.9 | `TokenAdded` / `TokenRemoved` emitted by `add_token` / `remove_token` | ⚠️ Partial | Events appear in import list in `lib.rs`; `docs/events.md` lists them as missing — verify actual emission |
| 5.10 | `ContractPaused` / `ContractUnpaused` structs are defined and emitted correctly | ⚠️ Partial | `docs/events.md` notes struct definitions may be missing; verify compilation and emission |
| 5.11 | `ContractUpgraded` emitted by `upgrade` | ✅ Pass | Verified in `lib.rs` |
| 5.12 | `iln_distribution` emits events for `accrue_lp`, `accrue_settlement`, and `claim_tokens` | ❌ Open | Distribution contract emits **no events**; all reward accrual and claims are silent on-chain — critical gap for indexers and auditors |
| 5.13 | `AdminChanged` emitted by `set_admin` | ✅ Pass | Verified in `lib.rs` |
| 5.14 | `ParameterUpdated` emitted by `update_fee_rate` and `update_max_discount` | ✅ Pass | Verified in `lib.rs` |

---

## 6. Access Control Matrix Review

Reference: [`docs/access-control.md`](access-control.md)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 6.1 | Every `pub fn` in `invoice_liquidity` has an `Access:` annotation in its doc comment | ⚠️ Partial | Most functions have annotations; verify batch submit, queue functions, and all multi-sig functions |
| 6.2 | `docs/access-control.md` matrix includes all multi-sig admin functions added in Issue #124 | ❌ Open | `initialize_multisig_admin`, `propose_pause`, `propose_unpause`, `sign_proposal`, `execute_proposal` are not in the matrix |
| 6.3 | `require_admin` is the only path to admin-gated functions (no bypass via direct storage writes) | ✅ Pass | All admin functions call `require_admin(&env)?` as first statement |
| 6.4 | `iln_contract.require_auth()` in `iln_distribution` correctly restricts `accrue_lp` and `accrue_settlement` to the core contract only | ✅ Pass | Verified in `iln_distribution/src/lib.rs` |
| 6.5 | `initialize` is idempotent-safe — calling it twice returns `AlreadyInitialized` without panic | ✅ Pass | Verified: checks `DataKey::InvoiceCount` presence before proceeding |
| 6.6 | `iln_distribution.initialize` is idempotent-safe — calling it twice panics with "already initialized" | ⚠️ Partial | Uses `panic!("already initialized")` — should return a `ContractError` instead of panicking for consistency |
| 6.7 | No function allows a user to call admin-only paths by passing their own address as `admin` | ✅ Pass | `require_admin` reads admin from storage, not from function arguments |
| 6.8 | LP whitelist enforcement: `allowed_lps` max 10 entries validated, and only whitelisted LPs can fund when list is set | ✅ Pass | `WhitelistTooLarge` error on submit; funding checks whitelist at fund time |
| 6.9 | Multi-sig threshold validation: `threshold == 0` and `threshold > signers.len()` both rejected | ✅ Pass | Verified in `initialize_multisig_admin` |
| 6.10 | Proposal expiry is enforced before execution (not just checked) | ✅ Pass | `execute_proposal` checks `is_expired` and marks proposal `Expired` before returning error |

---

## 7. Threat Model Review

Reference: [`docs/threat-model.md`](threat-model.md)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 7.1 | Threat model document is present and dated | ✅ Pass | `docs/threat-model.md` — Version 1.0, May 2024, Status: Pre-Audit |
| 7.2 | All **Critical** recommendations from threat model are addressed or have a tracked issue | ❌ Open | "Implement Multi-Sig Admin" is opt-in (not mandatory); "Add Time-Locks for Parameter Changes" has no implementation |
| 7.3 | All **High** recommendations from threat model are addressed or have a tracked issue | ❌ Open | Reentrancy guard state flag not implemented; `ContractPaused`/`ContractUnpaused` struct gap not resolved |
| 7.4 | `decay_rate_bps` has an upper bound validation (≤ 500 recommended in threat model) | ❌ Open | No upper bound on `decay_rate_bps` in `update_config`; can be set to 10000 (instant 100% decay) |
| 7.5 | `high_rep_threshold` is validated to 0–100 range | ❌ Open | No range check; value > 100 would make high-rep threshold unreachable |
| 7.6 | Checks-effects-interactions pattern is consistently applied in all token transfer functions | ✅ Pass | State updated before `token.transfer()` in `fund_invoice`, `mark_paid`, `claim_default`, `claim_yield` |
| 7.7 | Threat model covers `iln_distribution` mint authority risk (distribution contract must be SAC admin) | ❌ Open | Threat model scope is `invoice_liquidity` + `reputation_bonus` only; `iln_distribution` mint risk not documented |
| 7.8 | Threat model covers governance timelock absence (ADR-005 documents no timelock in v1) | ✅ Pass | ADR-005 documents the decision; threat model section E2 covers parameter misconfiguration |
| 7.9 | Known residual risks are documented with severity ratings | ✅ Pass | Summary table in threat model covers 13 threat categories with severity and residual risk |
| 7.10 | Threat model has been reviewed by at least one team member other than the author | ❌ Open | No reviewer sign-off recorded on the document |

---

## 8. Dependency and Supply Chain

| # | Item | Status | Notes |
|---|------|--------|-------|
| 8.1 | `cargo deny check` passes with no advisories | ✅ Pass | Weekly scheduled run in `.github/workflows/cargo-deny.yml` |
| 8.2 | `soroban-sdk` is pinned to an exact version (`21.4.0`) | ✅ Pass | Workspace `Cargo.toml` uses `soroban-sdk = "21.4.0"` |
| 8.3 | All dev-dependencies are pinned to exact versions | ⚠️ Partial | `proptest = "1"` and `rand = "0.10.1"` use semver ranges; acceptable for dev-only but note for auditors |
| 8.4 | `Cargo.lock` is committed and up to date | ✅ Pass | `Cargo.lock` present in repository root |
| 8.5 | No `git` or `path` dependencies in production (non-dev) dependency sections | ✅ Pass | All production deps use registry versions |

---

## 9. Build Reproducibility

| # | Item | Status | Notes |
|---|------|--------|-------|
| 9.1 | `cargo build --target wasm32v1-none --release` succeeds from a clean checkout | ✅ Pass | CI `deploy` job verifies this on every push to `main` |
| 9.2 | Release profile has `overflow-checks = true` | ✅ Pass | Workspace `Cargo.toml` `[profile.release]` |
| 9.3 | Release profile has `panic = "abort"` | ✅ Pass | Workspace `Cargo.toml` `[profile.release]` |
| 9.4 | WASM binary sizes are within Soroban limits and benchmarked | ⚠️ Partial | Benchmark script exists (`scripts/check_benchmark_regression.sh`) but runs with `continue-on-error: true` — not a hard gate |
| 9.5 | `.cargo/config.toml` does not override release flags in a way that weakens security | ✅ Pass | `.cargo/config.toml` present; verify it only sets target/linker config |

---

## 10. Final Pre-Audit Verification

| # | Item | Status | Notes |
|---|------|--------|-------|
| 10.1 | All CI jobs pass on the freeze commit (green badge on audit branch) | ❌ Open | Must be verified after code freeze |
| 10.2 | Testnet deployment is live and smoke tests pass | ⚠️ Partial | Testnet contract `CD3TE3...` deployed; run `scripts/smoke-test.ts` to verify |
| 10.3 | Audit branch SHA is recorded in this document | ❌ Open | Fill in after freeze: **Audit commit SHA:** `_____________` |
| 10.4 | Audit firm has been provided: repo access, testnet contract IDs, RPC endpoint, and this checklist | ❌ Open | Coordinate with audit firm before granting access |
| 10.5 | All open issues blocking audit (marked ❌ above) are either resolved or explicitly accepted as out-of-scope with written justification | ❌ Open | See [Open Issues Summary](#open-issues-summary) below |

---

## Open Issues Summary

The following items are ❌ as of this document's creation. Each must be resolved or explicitly accepted as out-of-scope before the audit begins.

| Item | Description | Suggested Issue Label |
|------|-------------|----------------------|
| 1.6 | All `ContractError` variants have dedicated test cases | `audit-prep`, `testing` |
| 2.4 | Verify zero `unsafe` blocks across all contract crates | `audit-prep`, `security` |
| 3.2 | Doc comments for all `iln_distribution` public functions | `audit-prep`, `docs` |
| 3.3 | Doc comments for all `iln_governance` public functions | `audit-prep`, `docs` |
| 3.4 | `docs/contract-abi.md` updated for multi-sig functions | `audit-prep`, `docs` |
| 3.5 | `docs/events.md` discrepancies resolved | `audit-prep`, `docs` |
| 3.6 | `docs/error-codes.md` covers all new error variants | `audit-prep`, `docs` |
| 3.7 | `docs/storage-layout.md` updated for multi-sig and LP stats keys | `audit-prep`, `docs` |
| 4.2 | Fuzz `fund_invoice` | `audit-prep`, `testing`, `fuzz` |
| 4.3 | Fuzz `mark_paid` | `audit-prep`, `testing`, `fuzz` |
| 4.4 | Add fuzz tests to CI | `audit-prep`, `ci` |
| 5.6 | Emit `InvoiceExpired` event | `audit-prep`, `events` |
| 5.7 | Emit `InvoiceDisputed` event | `audit-prep`, `events` |
| 5.8 | Emit `ReputationUpdated` event | `audit-prep`, `events` |
| 5.12 | Add events to `iln_distribution` | `audit-prep`, `events` |
| 6.2 | Update access control matrix for multi-sig functions | `audit-prep`, `docs` |
| 6.6 | Replace `panic!` in `iln_distribution.initialize` with `ContractError` | `audit-prep`, `security` |
| 7.2 | Address or track Critical threat model recommendations | `audit-prep`, `security` |
| 7.3 | Address or track High threat model recommendations | `audit-prep`, `security` |
| 7.4 | Add upper bound validation for `decay_rate_bps` | `audit-prep`, `security` |
| 7.5 | Add range validation for `high_rep_threshold` | `audit-prep`, `security` |
| 7.7 | Extend threat model to cover `iln_distribution` mint authority | `audit-prep`, `docs` |
| 7.10 | Threat model reviewer sign-off | `audit-prep`, `docs` |

---

## Maintainer Sign-Off

Before granting the audit firm repository access, a maintainer must sign off that all ✅ items have been verified and all ❌ items are either resolved or explicitly accepted as out-of-scope.

| Role | Name | Date | Signature / GitHub Handle |
|------|------|------|--------------------------|
| Lead Maintainer | | | |
| Security Reviewer | | | |
| Second Maintainer | | | |

**Audit commit SHA:** `_____________`  
**Audit branch:** `audit/v1.0` (see [Code Freeze Procedure](code-freeze-procedure.md))  
**Audit firm:** `_____________`  
**Audit start date:** `_____________`

---

## Related Documents

- [Threat Model](threat-model.md)
- [Access Control Matrix](access-control.md)
- [Events Schema](events.md)
- [Error Codes](error-codes.md)
- [Storage Layout](storage-layout.md)
- [Architecture](Architecture.md)
- [Code Freeze Procedure](code-freeze-procedure.md)
