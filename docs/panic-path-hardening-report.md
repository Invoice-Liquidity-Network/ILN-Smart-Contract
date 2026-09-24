# Panic-Path Hardening Report

> Consolidated record of every `unwrap()`/`expect()` instance found and fixed
> across the ILN Smart Contract workspace, produced for the pre-audit checklist
> (item 2.4: non-unsafe panic surfaces).

## Summary

| Contract | Instances found | Instances fixed | Remaining (justified) |
|---|---|---|---|
| `invoice_liquidity` | Pre-existing fix | — | 0 |
| `iln_governance` | 25 | 25 | 0 |
| `insurance_pool` | 2 | 2 | 0 |
| `reputation_bonus` | 0 | 0 | 0 |

## Fixed Instances

### iln_governance (Issue #844)

All `unwrap()` calls on admin-configured storage reads (`IlnContract`, `GovToken`,
`DistributionContract`, `ReputationBonusContract`, `Admin`) were replaced with
`.ok_or(GovernanceError::NotInitialized)?` or equivalent helper functions.

**Helpers added:**
- `get_iln_contract(&Env) -> Result<Address, GovernanceError>`
- `get_gov_token(&Env) -> Result<Address, GovernanceError>`
- `get_distribution_contract(&Env) -> Result<Address, GovernanceError>`
- `get_reputation_bonus_contract(&Env) -> Result<Address, GovernanceError>`

**Functions updated:**
- `set_max_delegation_depth`
- `set_gov_token_total_supply`
- `set_min_quorum_bps`
- `set_min_proposal_deposit`
- `set_proposal_deposit_sink`
- `set_quadratic_voting_enabled`
- `set_min_proposal_balance`
- `create_proposal` (GovToken read)
- `cast_vote` (GovToken read)
- `execute_proposal` (IlnContract, DistributionContract, ReputationBonusContract reads)
- `disable_veto_power` (IlnContract read)
- `get_own_balance_for_delegation` (GovToken read — changed return type to `Result`)
- `delegate_votes`, `undelegate_votes` (updated callers of `get_own_balance_for_delegation`)

**Error variant added:** `GovernanceError::NotInitialized = 28`

**Pre-init test added:** `test_pre_init_calls_return_not_initialized` verifies all
admin-gated functions return `NotInitialized` before `initialize()` is called.

### insurance_pool (Issue #846)

Two `unwrap()` calls on `DataKey::TokenAddress` were replaced with
`.ok_or(InsuranceError::NotInitialized)?`:

- `get_token_address` — changed return type from `Address` to `Result<Address, InsuranceError>`
- `get_token_client` — changed return type from `token::Client` to `Result<token::Client, InsuranceError>`
- Callers (`top_up_backstop`, `deposit_premium`, `pay_claim`) updated with `?`

**Error variant already existed:** `InsuranceError::NotInitialized = 1`

### reputation_bonus (Issue #846)

Audit found **zero** `unwrap()`/`expect()` calls in non-test source. No changes needed.

## CI Gate (Issue #845)

Added `scripts/check-no-unwrap-in-contract-source.sh` — a grep-based CI step that
fails if `unwrap()`/`expect()` appears in non-test contract source files. Integrated
into `make lint` as the `check-no-unwrap` target.

**Exclusions:**
- Test files (`test.rs`, `*_test.rs`, `tests_*/*`)
- Lines with explicit `#[allow(clippy::unwrap_used)]` justification

## Deliberately Unchanged

- **Vec `.get(i).unwrap()` in bounded loops** (e.g., `iln_governance` duplicate-signer check):
  Index is guaranteed in-bounds by the loop bound `0..vec.len()`. These are not
  admin-read patterns and cannot panic under any initialization state.

## Cross-References

- [Pre-Audit Checklist](./pre-audit-checklist.md) — item 2.4
- [Audit Readiness Dashboard](./audit-readiness-dashboard.md)
- [Arithmetic Safety Audit](./arithmetic-safety-audit.md)
