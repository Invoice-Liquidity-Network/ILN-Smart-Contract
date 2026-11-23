# Reputation Score Update Conservation Audit

Scope: `contracts/invoice_liquidity/src/lib.rs` (`submit_invoice`,
`submit_invoices_batch`, `mark_paid`, `claim_default`, `appeal_default`,
`resolve_appeal`), `invoice.rs` (`set_payer_score`, `get_payer_score`).
Tests: second half of `tests_reputation_decay_long_idle.rs`.

## Verified: no underflow, no duplicate updates

| Path | Arithmetic | Duplicate protection |
| --- | --- | --- |
| submission | `invoices_submitted.saturating_add(1)` | one increment per created invoice |
| final payment | `score.saturating_add(1)`, clamped to 100 in `set_payer_score`; counters saturating | status `Paid` rejects replays; partial payments return before the score code |
| default | `current_score - 5` only when `> 5`, else 0; counter saturating | status `Defaulted` rejects replays; pre-default snapshot stored once |
| appeal | `invoices_defaulted.saturating_sub(1)`; absolute score restore | `AlreadyAppealed`; status `Defaulted` after resolve rejects a second resolve |
| decay | bounded loop (`MAX_REPUTATION_DECAY_PERIODS`), saturating math, floor 0 | updates only when the decayed score differs |
| self-invoice | n/a | `SelfInvoice` prevents double counters for one address |

## Failure behavior

* Normal: one update per transition.
* Repeated: `mark_paid` on `Paid`, `claim_default` on `Defaulted`,
  `appeal_default` twice, `resolve_appeal` twice all revert.
* Unauthorized: non-payer `mark_paid`/`appeal_default`, non-funder
  `claim_default`, non-admin `resolve_appeal` revert before reputation code.
* Stale: decay is applied before every score read/write, so snapshots are
  taken from the decayed score.
* Interrupted: Soroban rolls back the whole invocation on error.

## Verified residual behavior (pinned by tests, not changed)

`resolve_appeal(upheld = true)` sets the payer score to the **absolute**
pre-default snapshot instead of adding the 5-point penalty back:

1. Score changes made between the default and the resolution are overwritten
   (default 50 -> 45, later payment 46, upheld -> 50, not 51).
2. With two defaults (snapshots 50 and 45) the final score depends on the
   resolution order (A then B ends at 45; A alone leaves 50 although B's
   default still stands).

The counters stay exact in every order. Changing this to a delta restore is a
behavior change and should be a separate, reviewed proposal.
