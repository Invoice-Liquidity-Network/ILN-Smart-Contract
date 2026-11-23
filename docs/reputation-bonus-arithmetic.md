# Reputation bonus arithmetic and numeric boundaries

**Scope:** `contracts/reputation_bonus/src/rate_logic.rs`,
`ReputationScore::recalculate_score` in `src/reputation.rs`, and the counter
and id arithmetic in `src/invoice.rs`. Tests: `tests/numeric_boundaries.rs`.

## 1. Effective rate

`calculate_effective_rate(base, rep, threshold, bonus, min)`, all `u32`:

| Condition | Result |
| --- | --- |
| `rep >= threshold` | `max(base.saturating_sub(bonus), min)` |
| `rep < threshold` | `max(base, min)` |

Verified properties (including an exhaustive grid over
`{0, 1, 2, 99, 100, 500, u32::MAX-1, u32::MAX}` for every argument):

- never panics and never overflows; the function always returns `Ok`
  (`RateError` is retained for API compatibility but is unreachable today);
- `result >= min_discount_rate_bps`, so a bonus can never push a rate below the
  floor, and `bonus > base` saturates to 0 and then to the floor;
- `result <= max(base, min)`, so the bonus can only lower a rate;
- the threshold comparison is inclusive (`rep == threshold` earns the bonus);
- a `min` above `base` **raises** the rate to `min`.

## 2. Reputation score

`score = min(100, invoices_paid * 100 / max(invoices_submitted, 1))`, computed
in `u64`.

| Input (`submitted`, `paid`) | Score |
| --- | --- |
| `(0, 0)` | 0 |
| `(u32::MAX, u32::MAX)` | 100 |
| `(u32::MAX, u32::MAX - 1)` | 99 |
| `(u32::MAX, 1)` | 0 |
| `(1, u32::MAX)` / `(0, 5)` | 100 (capped) |
| `(3, 1)` / `(3, 2)` | 33 / 66 (truncates toward zero) |

`u32::MAX * 100` is about 4.3e11, far below `u64::MAX`, so the multiplication
cannot overflow.

## 3. Counters and ids

| Item | Behaviour at the limit |
| --- | --- |
| `invoices_submitted` / `paid` / `defaulted` | `saturating_add`: stay at `u32::MAX`, no panic, score still in `0..=100` |
| invoice id counter at `u64::MAX` | `submit_invoice` returns `ArithmeticError` **before** writing anything; no counters change |
| `amount` up to `i128::MAX`, `due_date` up to `u64::MAX`, base rate up to `u32::MAX` | accepted; no arithmetic is performed on `amount` or `due_date` |

## 4. Residual risk (observed, not changed here)

- **No range check on rates.** `submit_invoice` accepts any `u32` base rate, and
  the effective rate is not capped at 10 000 bps (100%). The effective rate can
  therefore exceed 100%. Downstream consumers must validate it. Capping would
  change observable behaviour and is left for a separate decision.
- **`high_rep_threshold = 0` is allowed by `set_config`.** Every address,
  including one with no history, then receives the bonus.
- **Saturated counters stop moving.** At `u32::MAX` a counter no longer
  reflects reality. This needs about 4.3 billion invoices for one address and
  is considered unreachable in practice.
- **`RateError` is dead.** The `map_err` in `submit_invoice` can never fire.

## 5. Reviewing

```bash
cargo test -p reputation_bonus --test numeric_boundaries
```
