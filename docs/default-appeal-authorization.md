# Default and appeal authorization (#1171)

This document records the *verified* behavior of the default/appeal flow —
`claim_default`, `appeal_default`, and `resolve_appeal` — with respect to caller
authorization and the single canonical outcome the flow converges to. It exists
so contributors and integrators can reason about who may drive each transition,
in what order the guards fire, and why every path ends in the same economic
state without re-deriving it from the code.

Everything below was observed against the implementation in
[lib.rs](../contracts/invoice_liquidity/src/lib.rs) (the three entry points) and
the access helpers in
[access.rs](../contracts/invoice_liquidity/src/access.rs), and is backed by the
tests in
[tests_default_appeal_authorization.rs](../contracts/invoice_liquidity/src/tests_default_appeal_authorization.rs)
(in addition to the existing
[tests_appeal.rs](../contracts/invoice_liquidity/src/tests_appeal.rs) and
[tests_access_control.rs](../contracts/invoice_liquidity/src/tests_access_control.rs)).

## 1. Scope and non-goals

In scope: authorization and the canonical end-state of `claim_default`,
`appeal_default`, and `resolve_appeal`, including the order in which their
guards fire.

Out of scope: the dispute mechanism (`raise_dispute`/`resolve_dispute`), payer
settlement (`mark_paid`, covered by
[#1170](./settlement-overpayment-rollback.md)), and insurance pool top-ups,
which are best-effort side effects of `claim_default` with their own issues.

No API, storage key, or error code is changed by this work.

## 2. Entry points and authorization

| Entry point | Caller argument | Authorization enforced | Notes |
|---|---|---|---|
| `claim_default` | `funder: Address` | `funder.require_auth()` **and** `funder` must appear in the invoice's funder ledger, else `Unauthorized` | "LP only" is the ledger membership check, not a role registry |
| `appeal_default` | none | `invoice.payer.require_auth()` (derived from the stored invoice) | The caller is *always* the payer; there is no way to pass a different address |
| `resolve_appeal` | none | `require_admin()` → `admin.require_auth()` | Admin-only, guarded before any invoice read |

Key points:

- **`claim_default`** first calls `require_lp` (which only performs
  `funder.require_auth()`) and *then* performs an explicit scan of
  `get_invoice_funders` to confirm the signer actually funded **this** invoice.
  An authorized signer who is not in the ledger is rejected with `Unauthorized`.
- **`appeal_default`** takes no caller address. Authorization is derived from the
  stored invoice via `require_payer_by_id`, which calls `invoice.payer.
  require_auth()`. Only the payer's signature can satisfy it.
- **`resolve_appeal`** calls `require_admin` **first**: a non-admin caller is
  rejected before existence or status is even examined, and the action is
  recorded in the admin action log (`record_admin_action`).

## 3. Canonical outcome model

The flow is designed so that, for any combination of {appeal filed or not} ×
{appeal upheld or rejected}, the invoice converges to exactly one economic state.

`Defaulted` is that canonical state. It is produced only by `claim_default`
(and re-established by `resolve_appeal`). On the way there:

- **Refund — exactly once.** `claim_default` is the *only* step that moves
  tokens. It refunds each funder `fund_amount − discount` (principal minus the
  discount the protocol retained for the funding period). `appeal_default` and
  `resolve_appeal` move no tokens: the LP refund already happened and is never
  repeated.
- **Reputation penalty — exactly one application.** `claim_default` snapshots
  the payer's pre-default score, then applies a single penalty (score `− 5`,
  floored at `0`) and increments `invoices_defaulted`.
  - If the appeal is **upheld**, `resolve_appeal` restores the snapshot score and
    decrements `invoices_defaulted` — the penalty is fully undone.
  - If the appeal is **rejected**, the penalty stands untouched.
  - In **both** branches the status returns to `Defaulted`.

Consequently the four observable paths are:

| Path | Final status | LP refund | Payer reputation |
|---|---|---|---|
| default, no appeal | `Defaulted` | once | penalty retained |
| default → appeal → upheld | `Defaulted` | once | penalty restored |
| default → appeal → rejected | `Defaulted` | once | penalty retained |
| default → appeal (unresolved) | `Appealed` (transient) | once | penalty retained |

`Appealed` is the only non-terminal resting state and is always resolved back to
`Defaulted`.

## 4. Guard ordering

Guards fire in a fixed order; the first failure wins.

`claim_default`:

1. reentrancy lock
2. pause (`ContractPaused`)
3. `funder.require_auth()` (`require_lp`)
4. invoice exists (`InvoiceNotFound`)
5. funder-ledger membership (`Unauthorized`)
6. `now >= due_date` (`NotYetDefaulted`)
7. status is `Funded` (`NotFunded` for `Pending`/`PartiallyFunded`; `AlreadyPaid`
   for `Paid`; `InvoiceDefaulted`; `InvoiceAppealed`; `InvoiceDisputed`;
   `InvoiceExpired`; `AlreadyCancelled`)

Because membership (5) precedes the date (6) and status (7) checks, an address
that never funded the invoice is rejected with `Unauthorized` regardless of the
invoice's status or due date.

`appeal_default`:

1. pause (`ContractPaused`)
2. invoice exists (`InvoiceNotFound`)
3. payer authorization (`require_payer_by_id`)
4. appeal already recorded (`AlreadyAppealed`) — checked **before** status, so a
   second appeal reports the precise error instead of `NotDefaulted`
5. status is `Defaulted` (`NotDefaulted`)
6. within the appeal window (`AppealWindowClosed`) — measured from `due_date`

`resolve_appeal`:

1. admin authorization (`Unauthorized`)
2. invoice exists (`InvoiceNotFound`)
3. status is `Appealed` (`NotDefaulted`)
4. appeal record present (`InvoiceNotFound` if absent)

## 5. Invariants

- **INV-AUTH1** — `claim_default` succeeds only when the caller is in the
  invoice's funder ledger **and** authorizes the call; any other caller is
  rejected with `Unauthorized` (or a host auth failure) and the invoice is
  unchanged.
- **INV-AUTH2** — `appeal_default` requires the invoice payer's authorization;
  no other address can satisfy it.
- **INV-AUTH3** — `resolve_appeal` requires the current admin's authorization,
  checked before any invoice read.
- **INV-AUTH4** — `claim_default` requires the `Funded` status and
  `now >= due_date`, and succeeds at most once per invoice (`InvoiceDefaulted`
  thereafter).
- **INV-AUTH5** — every resolution branch (`upheld` and rejected) returns the
  invoice to `Defaulted` and never re-runs the refund; `appeal_default` and
  `resolve_appeal` move no tokens.
- **INV-AUTH6** — the payer's reputation ends in exactly one of two states: the
  default penalty fully restored (upheld) or fully retained (rejected); it is
  never applied twice or partially.

## 6. Verified findings

- **VF-1** — `claim_default`'s "LP only" gate is a funder-ledger membership
  check, so an authorized but non-funding address is rejected with
  `Unauthorized` (INV-AUTH1).
- **VF-2** — `appeal_default` cannot be driven by any address other than the
  stored payer, because its authorization is derived from the invoice rather
  than a caller argument (INV-AUTH2).
- **VF-3** — `resolve_appeal` enforces admin authorization before touching
  invoice state (INV-AUTH3).
- **VF-4** — both `upheld` and rejected resolutions set the status to
  `Defaulted`; there is no branch that leaves the invoice `Appealed`, and
  therefore no branch that could re-run the refund (INV-AUTH5).
- **VF-5** — reputation is either fully restored (`upheld`) or fully retained
  (rejected); the appeal record acts as the one-shot marker that blocks a second
  appeal even after the status returns to `Defaulted` (INV-AUTH6).

## 7. Residual risk

- **RR-1 (appeal-record lifetime)** — `resolve_appeal` does not delete the
  `AppealRecord`. That is intentional: it is the marker that makes
  `appeal_default` once-only (`AlreadyAppealed`). Integrators must therefore
  treat "has an appeal record" and "status == Appealed" as different questions —
  a `Defaulted` invoice may still carry a resolved appeal record.
- **RR-2 (payer address is the only key)** — `appeal_default` authorizes via
  `invoice.payer`; if the payer key is rotated off-chain the new holder signs,
  but the on-chain invoice still names the original payer. Renewing payer
  authorization for an invoice is out of scope and would require a migration.
- **RR-3 (insurance top-up is best-effort)** — `claim_default`'s optional
  insurance-pool payout is attempted via `try_*` and may silently fail (paused or
  empty pool); it never blocks the default or changes the canonical outcome, but
  an LP's *total* recovery can be less than their insured expectation. This is
  documented under the insurance issue, not here.

## 8. Test mapping

| Invariant | Test |
|---|---|
| INV-AUTH1 | `claim_default_rejects_caller_not_in_funder_ledger` |
| INV-AUTH1 | `claim_default_requires_funder_authorization` |
| INV-AUTH4 | `claim_default_before_due_date_is_not_yet_defaulted` |
| INV-AUTH4 | `claim_default_on_partially_funded_is_not_funded` |
| INV-AUTH4 | `claim_default_is_once_only` |
| INV-AUTH2 | `appeal_default_requires_payer_authorization` |
| INV-AUTH2 | `appeal_default_only_from_defaulted` |
| INV-AUTH3 | `resolve_appeal_requires_admin_authorization` |
| INV-AUTH4/6 | `plain_default_refunds_lp_once_and_penalizes_payer_once` |
| INV-AUTH5/6 | `upheld_appeal_restores_reputation_without_a_second_refund` |
| INV-AUTH5/6 | `rejected_appeal_keeps_penalty_without_a_second_refund` |
| INV-AUTH5 | `appeal_cannot_be_refiled_after_resolution` |

## 9. Compatibility

No storage key, function signature, or error code is modified. The tests assert
behavior of the existing public API only.
