# Settlement and overpayment rollback behavior (#1170)

This document records the *verified* behavior of `mark_paid` — the payer
settlement entry point — with respect to partial settlement, repeated
settlement, overpayment, and failed transfers. It exists so contributors and
integrators can reason about settlement without re-deriving it from the code.

Everything below was observed against the implementation in
[lib.rs](../contracts/invoice_liquidity/src/lib.rs) (`mark_paid`) and the token
safety helpers in
[token_safety.rs](../contracts/invoice_liquidity/src/token_safety.rs), and is
backed by the tests in
[tests_settlement_overpayment.rs](../contracts/invoice_liquidity/src/tests_settlement_overpayment.rs).

## 1. Scope and non-goals

In scope: the `mark_paid` entry point, its interaction with `amount_paid`, and
its rollback behavior on failure.

Out of scope: default/appeal/dispute settlement flows (`claim_default`,
`appeal_default`, `resolve_dispute`), LP yield claiming (`claim_yield`), and
escrow claim (`claim_pending_payout`); those have their own issues.

No API, storage key, or error code is changed by this work.

## 2. Entry point and authorization

| Entry point | Signature | Authorization | Preconditions |
|---|---|---|---|
| `mark_paid` | `mark_paid(invoice_id, amount)` | `invoice.payer` only (`require_payer_by_id`) | invoice exists; `amount > 0`; status is `Funded`; `amount <= amount - amount_paid` |

Authorization is the payer's alone. The reentrancy guard
(`lock_reentrancy`/`unlock_reentrancy`) wraps the call, and the pause switch is
checked before any work.

## 3. Settlement accounting model

`mark_paid` is **incremental**: callers may settle in pieces. Let
`remaining = invoice.amount - invoice.amount_paid`.

- **Partial settlement** (`amount < remaining`): `amount_paid` grows by `amount`
 ; the invoice **stays `Funded`**; a `partially_paid` event is emitted; no
  protocol fee is taken and no LP payout happens yet. `total_paid` is **not**
  incremented.
- **Completing settlement** (`amount == remaining`): `amount_paid` reaches
  `amount`; status becomes `Paid`; the protocol fee is paid to the admin
  (escrowed if frozen); each funder is paid `distribute_amount * fund_amount /
  invoice.amount` (escrowed if frozen); `total_paid` is incremented once;
  payer/freelancer reputation and the `paid` event are updated.
- **Overpayment** (`amount > remaining`): rejected with `OverpaymentRejected`
  before any state write.

The payer is debited by the token transfer for exactly `amount`. Across a
sequence of accepted settlements the payer is debited exactly `invoice.amount`.

## 4. Failure and rollback behavior

| Condition | Result | State effect |
|---|---|---|
| `amount <= 0` | `InvalidAmount` | none |
| invoice missing | `InvoiceNotFound` | none |
| status not `Funded` | `NotFunded` / `AlreadyPaid` / `AlreadyCancelled` / `InvoiceExpired` / `InvoiceDefaulted` / `InvoiceAppealed` / `InvoiceDisputed` | none |
| `amount > remaining` | `OverpaymentRejected` | none |
| no funders recorded | `NotFunded` | none |
| payer frozen/deauthorized | `AccountFrozen` | **full rollback** |
| payer underfunded (SAC rejects transfer) | host error | **full rollback** |

Rollback safety rests on two mechanisms:

1. **Checked-effects-interactions.** For a partial settlement `amount_paid` is
   mutated in memory and only persisted (`save_invoice`) *after* the inbound
   transfer succeeds. For a completing settlement the status/`amount_paid` write
   happens before the outbound payouts, but any outbound failure returns `Err`,
   which causes the Soroban runtime to revert the entire invocation — including
   that earlier write.
2. **Typed pre-checks.** `token_safety::require_authorized` runs *before* the
   inbound transfer, so a frozen payer yields `AccountFrozen` rather than an
   opaque host trap.

Consequence: a failed settlement attempt never leaves a partially-applied
`amount_paid`, never advances status, and never moves tokens. The invoice
remains settleable afterwards for exactly the outstanding remainder — a
retried settlement credits the payer exactly once.

## 5. Invariants

- **INV-STL1** — `amount_paid` is monotonically non-decreasing and always
  `0 <= amount_paid <= amount` (balance invariant `B2` in `invoice.rs`).
- **INV-STL2** — a completing settlement credits the payer's funds exactly once;
  the sum of accepted settlement `amount`s equals `invoice.amount`.
- **INV-STL3** — an `OverpaymentRejected` call leaves `amount_paid`, status, the
  funder list, and all token balances byte-for-byte unchanged; the invoice stays
  settleable for the exact remainder.
- **INV-STL4** — once `Paid`, no further `mark_paid` succeeds (`AlreadyPaid`),
  and no second protocol fee or LP payout occurs (`total_paid` unchanged).
- **INV-STL5** — a settlement whose inbound transfer fails (frozen or
  underfunded payer) rolls back completely: no credit, no status change, no
  balance movement.
- **INV-STL6** — settlement is self-funding: the inbound `amount` covers the
  outbound protocol fee plus LP distribution, so the contract's token balance is
  unchanged by a completing settlement.

## 6. Verified findings

- **VF-1** — partial settlements are legal and accumulate; status remains
  `Funded` until the final piece (see *Residual risk RR-1*).
- **VF-2** — `OverpaymentRejected` is evaluated against the *remaining* balance,
  not the face value, so it also protects partially-settled invoices (INV-STL3).
- **VF-3** — completing twice is impossible: the `Paid` status byte gates the
  second call to `AlreadyPaid` before any accounting runs (INV-STL4).
- **VF-4** — a frozen or underfunded payer cannot corrupt `amount_paid`; the
  typed check plus Soroban's invocation-level revert guarantee full rollback
  (INV-STL5).
- **VF-5** — a completing settlement is value-neutral to the contract: inbound
  funds exactly cover the fee and LP payouts (INV-STL6), so settlement never
  depends on a pre-existing contract balance.

## 7. Residual risk

- **RR-1 (integration)** — because a partial settlement leaves `status ==
  Funded`, a UI or indexer that keys only on `status` cannot tell "unsettled"
  from "partially settled". Integrators **must** read `amount_paid` (or
  subscribe to the `partially_paid` event) to render partial progress.
- **RR-2 (no on-chain deadline)** — `mark_paid` has no expiry check: a `Funded`
  invoice can be settled at any time, including after `due_date`. Lateness is
  recorded via `paid_on_time = timestamp <= due_date` on the `paid` event, not
  by rejecting the call. Operators relying on a hard settlement cutoff must
  instead use `claim_default`/`appeal`.
- **RR-3 (sequence-dependent yield)** — LP payout uses integer division; with
  the protocol fee, a funder's share can truncate to slightly below their
  principal on a narrow edge, in which case `lp_earned` is clamped to `0` (never
  negative). This is intended and does not affect the payer's accounting.

## 8. Test mapping

| Invariant | Test |
|---|---|
| INV-STL1/STL3 | `overpayment_from_scratch_is_rejected_without_credit` |
| INV-STL1/STL3 | `overpayment_after_partial_is_measured_against_remaining` |
| INV-STL4 | `completion_is_once_only_no_double_payout` |
| INV-STL2/STL6 | `settlement_is_self_funding_and_credits_payer_exactly_once` |
| INV-STL5 | `frozen_payer_settlement_rolls_back_then_succeeds_exactly_once` |
| INV-STL5 | `frozen_payer_partial_attempt_rolls_back_then_completes` |
| status gating | `settling_unfunded_and_defaulted_is_rejected` |
| input validation | `zero_or_negative_settlement_is_invalid_amount` |
| RR-1 | `partial_settlement_is_observable_only_through_amount_paid` |

## 9. Compatibility

No storage key, function signature, or error code is modified. The tests assert
behavior of the existing public API only.
