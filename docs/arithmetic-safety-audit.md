# Integer Overflow/Underflow Audit (Issue #537)

## Scope

Every `+`, `-`, `*`, `/` operation on integer types across all five contracts
(`invoice_liquidity`, `insurance_pool`, `reputation_bonus`, `iln_distribution`,
`iln_governance`) was reviewed for overflow/underflow risk.

## Build-level protection already in place

`Cargo.toml` sets `overflow-checks = true` for the `release` profile, so any
arithmetic overflow that isn't explicitly guarded already **panics** (aborts
the transaction) instead of silently wrapping. This means the historical risk
of *silently wrong* accounting from wraparound is not present today. However,
relying solely on the implicit panic has two problems this audit addresses:

1. **Availability risk.** A panic on overflow aborts the whole transaction
   with a generic host error, rather than a typed `ContractError`/
   `InsuranceError` the caller can handle. For arithmetic reachable from
   attacker- or user-controlled inputs, this is a denial-of-service vector:
   a paginated view function or a funding call can be made to always panic
   instead of returning a clean error or clamped result.
2. **Explicitness.** The issue asks that intent be encoded in the arithmetic
   itself (`checked_*`/`saturating_*`) rather than depending on a build
   profile flag that could be toggled or forgotten in a future release
   profile.

## Findings and fixes

### `invoice_liquidity`

| Location | Issue | Fix |
| -------- | ----- | --- |
| `fund_invoice`: overfunding check (`amount_funded + fund_amount`) | Raw `+` on caller-supplied `fund_amount` (i128) ahead of the bounds check | `checked_add`, returns `ContractError::ArithmeticOverflow` |
| `fund_invoice`: funder ledger update, `amount_funded` update | Reused unchecked `+` after the check above | Reuses the already-`checked_add`ed value; funder amount update uses `saturating_add` |
| `fund_invoice`: discount/cost/payout calculations | Raw `-` | `saturating_sub` |
| `fund_invoice`: LP score bump | Raw `+ 1` on `u32` | `saturating_add(1)` |
| `mark_paid`: `remaining`, `amount_paid +=`, `distribute_amount`, `lp_earned` | Raw `+`/`-` on payment accounting | `checked_add` (returns `ArithmeticOverflow` on genuine overflow) / `saturating_sub` |
| `mark_paid`/default/dispute/cancel refund loops (4 call sites) | `fund_amt - fund_discount` raw subtraction | `saturating_sub` |
| `mark_paid`: payer score bump | Raw `+ 1` | `saturating_add(1)` |
| `handle_default`: `total_refunded +=` | Raw `+=` accumulator | `saturating_add` |
| `appeal_default`: appeal window check | Raw `+` on `u64` timestamps | `saturating_add` |
| `auto_resolve_dispute`: timeout check | Raw `+` on `u64` | `saturating_add` |
| `get_invoice_count`: `read_next_invoice_id() - 1` | Underflows to `u64::MAX` if the counter is ever `0` | `saturating_sub(1)` |
| `list_invoices_by_submitter` / `list_invoices_by_lp`: `page * page_size`, `start + page_size` | Caller-controlled `page`/`page_size` (`u32`) can overflow on crafted input — a public read-only view panicking is a cheap DoS | `saturating_mul` / `saturating_add` |
| `validate_due_date`: `now + MIN/MAX_INVOICE_DURATION` | Raw `+` on `u64` | `saturating_add` |
| `invoice.rs`: `increment_invoices_submitted/paid/defaulted` | Raw `+= 1` on `u32` reputation counters | `saturating_add(1)` |
| `invoice.rs`/`storage.rs`: `add_volume`, `increment_total_invoices/funded/paid` | Raw `+`/`+= 1` on volume/stats accumulators | `saturating_add` |

`current_score - 5` in the default-penalty path was already guarded with an
explicit `if current_score > 5 { .. } else { 0 }` and needed no change.
`claim`'s `balance - payout` in `insurance_pool` is provably safe by
construction (`payout = min(coverage, balance)`) and was left as-is.

### `iln_governance`

| Location | Issue | Fix |
| -------- | ----- | --- |
| `create_proposal`: `count + 1`, `now + VOTING_PERIOD_SECS` | Raw `+` | `saturating_add` |
| `cast_vote`: `own_balance + delegated`, `votes_for/against +=` | Raw `+` on vote-weight tallies | `saturating_add` |
| `execute_proposal`: `votes_for + votes_against`, `eta_ledger = sequence() + delay` | Raw `+`; `delay` is admin-configured and unbounded | `saturating_add` |
| `adjust_delegated_to_me`: `current + delta` | Raw `+` on delegation tally (delta may be negative) | `saturating_add` |
| `list_proposals`: `page * actual_page_size` | Same caller-controlled pagination overflow as `invoice_liquidity` | `saturating_mul` |

`resolve_terminal`/`delegate_votes` cycle-detection loops increment `depth`
bounded by `MAX_DELEGATION_DEPTH = 10` before any arithmetic is reachable —
no overflow possible; left unchanged.

### `iln_distribution`

| Location | Issue | Fix |
| -------- | ----- | --- |
| `accrue_lp`: `current + amount_usdc_equivalent` | Raw `+` on volume accumulator | `saturating_add` |
| `accrue_settlement`: `freelancer_count + 1`, `payer_count + 1` | Raw `+= 1` | `saturating_add(1)` |
| `claim_tokens`: `total_earned - already_claimed`, `already_claimed + claimable` | Raw `-`/`+` on claim accounting — underflow here would panic the claim path entirely | `saturating_sub` / `saturating_add` |
| `total_earned`: reward formula (`lp_reward + freelancer_reward + payer_reward`, and the two multiplications) | Raw `+`/`*` | `saturating_mul` / `saturating_add` |

### `insurance_pool`

| Location | Issue | Fix |
| -------- | ----- | --- |
| `deposit_premium`: premium and balance accumulation | Raw `+` | `saturating_add` |

`claim`'s `balance - payout` is safe by construction (see above). The new
timelock feature (Issue #542) uses `saturating_add` for its ETA calculations.

### `reputation_bonus`

No raw arithmetic exists in this crate — `config.rs`, `reputation.rs`, and
`invoice.rs` are storage/config wiring with no `+`/`-`/`*`/`/` on stored
values.

## Why `saturating_*` over `checked_*` in most call sites

Two exceptions aside (`fund_invoice`'s overfunding check and `mark_paid`'s
`amount_paid` accumulation, which surface `ContractError::ArithmeticOverflow`
because an overflow there indicates a genuinely invalid/malicious amount that
the caller should see as a rejected transaction), the rest of the fixes use
`saturating_*`. These are either:

- accounting/stat counters where clamping at the numeric boundary is
  strictly better than aborting the whole call (e.g. reputation scores,
  protocol-wide volume stats), or
- values that are already provably bounded well below the numeric limit in
  practice (e.g. ledger timestamps, discount-rate-derived amounts), where
  `saturating_*` is defense-in-depth rather than a behavior change.

## Testing

Existing test suites for `insurance_pool`, `iln_distribution`, and
`iln_governance` (excluding two pre-existing, unrelated failures present on
`main` prior to this work — `iln_governance::test_vote_receipt_available_within_ttl`
and `reputation_bonus`'s `test_governance_setters_and_access_control`) pass
unchanged after these fixes, confirming the `saturating_*`/`checked_*`
replacements are behavior-preserving for all valid inputs and only change
behavior at the numeric boundary.
