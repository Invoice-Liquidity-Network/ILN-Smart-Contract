# Reputation State Isolation Audit (LP / payer / invoice)

Scope: `contracts/invoice_liquidity/src/tests_reputation_state_isolation.rs`,
`invoice.rs` (`get/set_payer_score`, `get/set_lp_score`, `get/set_reputation`),
`lib.rs` (`fund_invoice`, `mark_paid`, `claim_default`).

Question: can one address or invoice mutate another LP's or payer's
reputation state?

## Data sources

| State | Storage key | Written by |
| --- | --- | --- |
| LP score (default 50) | `LpScore(addr)` | `fund_invoice`, only for the funder whose call completes funding (+1, cap 100) |
| Payer score (default 50, decays) | `PayerScore(addr)` | `mark_paid` (+1 on final settlement), `claim_default` (-5, floor 0), `resolve_appeal(upheld)`, lazy decay on read |
| Reputation profile (counters + mirrored score) | `Reputation(addr)` | `submit_invoice`/batch (freelancer `invoices_submitted`), `mark_paid` (payer **and** freelancer `invoices_paid`), `claim_default` (payer `invoices_defaulted`), `resolve_appeal` |

The three keys are independent. `reputation_bonus` is a separate contract with
its own storage (ADR-011); the first half of the test file covers that.

## Verified behavior

* Funding writes only the funder's `LpScore`. It does not touch that address's
  `PayerScore` or profile, nor the invoice payer's state.
* Split funding credits only the LP whose tranche completes the invoice.
  Earlier tranche providers are never credited retroactively.
* `mark_paid` writes the invoice's own payer and freelancer only.
  `claim_default` writes only the invoice's payer. LP scores are not changed by
  settlement or default.
* Other payers' scores, profiles, invoices and top-payer ranking entries are
  unchanged by either event.
* `submit_invoice` rejects `freelancer == payer` (`SelfInvoice`), so one
  address cannot receive both the payer and freelancer update for one event.

## Failure behavior

| Case | Result |
| --- | --- |
| Repeated `mark_paid` on a `Paid` invoice | reverts; score and profile unchanged |
| Repeated `claim_default` on a `Defaulted` invoice | reverts; penalty applied once |
| Unauthorized: `claim_default` by a non-funder | `Unauthorized`; payer state unchanged |
| Stale: reads with no ledger advance | pure reads return identical values |
| Interrupted: any revert | Soroban rolls the invocation back; no partial reputation write |

## Residual risk (not changed)

* The freelancer's *score* (`submitter_reputation`) is read from the same
  `PayerScore` namespace as payers. An address acting as both freelancer and
  payer on different invoices shares one score by design.
* `payer_score` is a read that may write (lazy decay syncs score, profile and
  top-payer heap). It is idempotent for a fixed ledger.
