# Payer Reputation History Consistency

Scope: `contracts/invoice_liquidity/src/tests_reputation_proptest.rs`,
`invoice.rs`, `top_payers.rs`.

## Model (verified against the implementation)

| Event | Payer | Freelancer |
| --- | --- | --- |
| `submit_invoice` | none | `invoices_submitted` +1 |
| final `mark_paid` | score +1 (cap 100), `invoices_paid` +1 | `invoices_paid` +1 |
| partial `mark_paid` | none | none |
| `claim_default` | score -5 (floor 0), `invoices_defaulted` +1 | none |
| `resolve_appeal(upheld)` | score = pre-default snapshot, `invoices_defaulted` -1 (saturating) | none |
| idle ledgers | lazy decay applied on the next score read/write | none |

Invariants checked after every step of a random lifecycle sequence:

1. `ReputationProfile.score == payer_score` (decay syncs the profile).
2. Payer / freelancer counters equal the number of events applied.
3. `paid + defaulted <= submitted`.
4. The top-payer heap has at most one entry for the payer, its score equals the
   live score, and any non-default (!= 50) score is ranked. Unwritten
   default-50 payers are absent.

The deterministic test pins a four-payer ranking (paid x2, paid x1,
appeal upheld, appeal rejected) with ties broken by ascending address, and
checks that appeal resolution does not duplicate or drop ranking entries.

## Verified finding

`tests_reputation_proptest.rs` existed but was **never declared** in `lib.rs`,
so it never compiled or ran. Its `prop_assert_eq!` inside an `as_contract`
closure also could not compile. It is now declared and uses client reads.

## Failure behavior

Replays, unauthorized callers and invalid amounts revert before any reputation
write (see `reputation-isolation-audit.md`). A reverted invocation leaves
profile, score and heap unchanged.

## Residual risk (not changed)

* The heap only learns about a payer when that payer's score changes, so an
  evicted payer is not promoted when a member later drops
  (`tests_top_payers.rs`).
* `get_top_payers` does not apply decay itself; entries are refreshed when each
  payer's score is next read or written.
