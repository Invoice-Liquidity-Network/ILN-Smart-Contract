# Invoice State Transitions

Issue #1168 — the maintained, test-backed description of the invoice lifecycle
state machine.

## 1. Purpose and scope

An invoice moves through a small, closed set of lifecycle states. Every public
entry point that mutates an invoice must only be reachable from the states
where its effect is well-defined; anything else must fail with a distinct typed
error rather than silently mutating or trap.

This document is the **single maintained reference** for those rules. It is
backed by executable tests in
`contracts/invoice_liquidity/src/tests_state_transitions.rs`, which pin each
transition and each rejection path.

Scope:

* `contracts/invoice_liquidity/src/invoice.rs` — the `InvoiceStatus` enum and
  the `SM1`/`SM2` state-machine invariants declared at the top of the file.
* `contracts/invoice_liquidity/src/lib.rs` — every public entry point that
  reads or writes `invoice.status`.
* Related consumers of the status: `contracts/invoice_liquidity/src/nft.rs`
  (NFT existence invariant) and the dispute/appeal helpers in `invoice.rs`.

Out of scope: storage layout changes, cross-crate SDK/API work, and economic
parameter tuning. No storage or API change is required by this issue.

## 2. States

`InvoiceStatus` (`invoice.rs`) has nine variants. They classify into three
non-terminal states, four transient "in-flight" states, and three terminal
states.

| State | Class | Meaning | `amount_funded` | `amount_paid` |
| --- | --- | --- | --- | --- |
| `Pending` | non-terminal | submitted, open for funding | `0` | `0` |
| `PartiallyFunded` | non-terminal | ≥1 LP contributed, not yet full | `0 < f < amount` | any |
| `Funded` | non-terminal | fully funded; freelancer paid out | `== amount` | `< amount` |
| `Paid` | **terminal** | payer settled in full; LP released | `== amount` | `== amount` |
| `Defaulted` | in-flight | past `due_date`, unpaid, LPs refunded | `== amount` | `< amount` |
| `Appealed` | in-flight | payer contests a default | `== amount` | `< amount` |
| `Disputed` | in-flight | payer disputes before settlement | any | any |
| `Expired` | **terminal** | past `due_date` with no funding | `0` | `0` |
| `Cancelled` | **terminal** | cancelled before full funding, or dispute upheld | any | any |

Terminal states (`Paid`, `Expired`, `Cancelled`) have **no outbound
transitions**: once reached, no entry point may move the invoice again. Any
attempt is rejected with a state-specific error.

`Defaulted` and `Appealed` are *in-flight* rather than terminal because a
default can still be appealed, and an appeal can return the invoice to
`Defaulted`. `Disputed` is in-flight because an admin resolution (or the
timeout) restores a prior funding-derived state.

## 3. Transition table

Each row is one reachable `(from → to)` edge. "Guard" is the additional
precondition beyond the `from` state.

| # | Entry point | From | To | Guard | Authorization |
| --- | --- | --- | --- | --- | --- |
| T1 | `submit_invoice` / `submit_invoices_batch` | *(new)* | `Pending` | terms valid, token allowlisted | freelancer |
| T2 | `update_invoice` | `Pending` | `Pending` | `now < due_date` | freelancer |
| T3 | `convert_invoice_token` | `Pending` | `Pending` | `now < due_date`, new token allowlisted | freelancer |
| T4 | `transfer_invoice` | `Pending` | `Pending` | none | freelancer |
| T5 | `fund_invoice` | `Pending` \| `PartiallyFunded` | `PartiallyFunded` | `amount_funded + f < amount` | LP (`require_lp`) |
| T6 | `fund_invoice` | `Pending` \| `PartiallyFunded` | `Funded` | `amount_funded + f == amount` | LP (`require_lp`) |
| T7 | `transfer_lp_position` | `Funded` | `Funded` | caller is current LP | current LP |
| T8 | `cancel_invoice` | `Pending` | `Cancelled` | none | freelancer |
| T9 | `cancel_invoice` | `PartiallyFunded` | `Cancelled` | refunds all LPs | freelancer |
| T10 | `expire_invoice` | `Pending` | `Expired` | `now > due_date` | anyone |
| T11 | `mark_paid` | `Funded` | `Funded` | `amount_paid + x < amount` (partial) | payer |
| T12 | `mark_paid` | `Funded` | `Paid` | `amount_paid + x == amount` (full) | payer |
| T13 | `claim_default` | `Funded` | `Defaulted` | `now >= due_date`, caller is an LP | LP funder |
| T14 | `appeal_default` | `Defaulted` | `Appealed` | within appeal window, not already appealed | payer |
| T15 | `resolve_appeal` | `Appealed` | `Defaulted` | admin | admin |
| T16 | `dispute_invoice` | `Pending` \| `PartiallyFunded` \| `Funded` | `Disputed` | not already disputed | payer |
| T17 | `resolve_dispute` (`resolution = 1`) | `Disputed` | `Cancelled` | admin | admin |
| T18 | `resolve_dispute` (`resolution = 2`) | `Disputed` | `Funded` \| `PartiallyFunded` \| `Pending` | admin; target derived from `amount_funded` | admin |
| T19 | `auto_resolve_dispute` | `Disputed` | `Funded` \| `PartiallyFunded` \| `Pending` | dispute timeout reached; target derived from `amount_funded` | anyone |

### Side-effect expiry

Three entries that operate on a still-`Pending` invoice first apply an
implicit `Pending → Expired` transition when the invoice is already past due,
persist it, and then return `InvoiceExpired`:

| Entry point | Condition that triggers implicit expiry |
| --- | --- |
| `update_invoice` (T2) | `now >= due_date` |
| `convert_invoice_token` (T3) | `now >= due_date` |
| `fund_invoice` (T5/T6) | `now > due_date` |

This is intentional: the caller's action is refused *and* the invoice is
advanced to the honest terminal state so operators/indexers observe reality.

### Non-transitioning entry points

| Entry point | Status gate | Effect |
| --- | --- | --- |
| `join_fund_queue` | `Pending` / `PartiallyFunded`; not `now > due_date` | queue only, **no status change** |
| `resolve_fund_queue` | `Pending` / `PartiallyFunded` (Issue #1017) | queue only, **no status change** |
| `claim_yield` | returns `0` for `Pending`/`PartiallyFunded`/`Funded`, computed yield for `Paid` | read-only, **no status change** |
| `get_invoice` / `get_initialization_state` | — | read-only |

## 4. State diagram

```
                       submit_invoice (T1)
                              │
                              ▼
                         ┌─────────┐
      expire_invoice(T10)│ Pending │  update/convert/transfer (T2–T4, self-loop)
        (now>due)        └────┬────┘
                              │  │
              cancel (T8) ────┘  │  fund_invoice (T5/T6)
                              │  ▼
                              │ ┌──────────────────┐
                              │ │ PartiallyFunded  │◄─┐ fund (T5)
                              │ └───┬───────┬──────┘  │
                              │     │       │ fund full (T6)
                              │     │       ▼
                              │     │  ┌─────────┐   transfer_lp_position (T7, self-loop)
        cancel (T9) ──────────┼─────┘  │ Funded  │◄──────────────┐
                              │        └──┬───┬──┘               │
                              ▼           │   │ mark_paid full   │
                        ┌───────────┐     │   ▼ (T12)            │
                        │ Cancelled │◄────┘ ┌──────┐             │ resolve_dispute=2 (T18)
                        └───────────┘  (T17)│ Paid │  ┌──────────┴───┐  / auto_resolve (T19)
                              ▲              └──────┘  │              │
                              │      claim_default(T13)│              │
                              │              ┌──────────┴───┐          │
                              │              │  Defaulted   │          │
                              │              └──────┬───────┘          │
                              │         appeal (T14) │ ▲ resolve_appeal (T15)
                              │              ┌───────▼─┴──┐            │
                              │              │  Appealed   │           │
                              │              └─────────────┘           │
                              │                                        │
                              │     dispute_invoice (T16)              │
                              │              ┌────────────┐            │
                              └──────────────│  Disputed  │────────────┘
                                             └─────┬──────┘
                                                   │ fund (T6) when not fully funded
                                                   ▼
                                            Funded | PartiallyFunded | Pending

  Terminal: Paid, Expired, Cancelled  — no outbound edges.
```

## 5. Invariants

From `invoice.rs` (state machine block), restated with the ids used by the
tests:

* **INV-ST1** — `submit_invoice` creates an invoice in `Pending`. No other
  entry point creates an invoice.
* **INV-ST2** — Every transition in §3 is the *only* way to reach its target
  state; no entry point writes a state outside its declared `to` set.
* **INV-ST3** — Terminal states (`Paid`, `Expired`, `Cancelled`) never
  transition out. All mutation entry points reject them.
* **INV-ST4** — An invalid `(from, entry point)` pair returns a distinct
  `ContractError` (`SM2`); it is never silently ignored.
* **INV-ST5** — `amount_funded == amount` ⇔ status ∈ {`Funded`, `Defaulted`,
  `Appealed`} (funding-complete states), and `amount_paid == amount` ⇔ status
  `== Paid` (`B3`/`B4`).
* **INV-ST6** — A `Pending` invoice past its due date cannot be funded or
  queued as if live; the entry points either expire it or refuse.

## 6. Entry point reference (authorization and failure behavior)

| Entry point | Auth mechanism | Representative rejections |
| --- | --- | --- |
| `submit_invoice` | `require_submitter` (`freelancer.require_auth`) | `SelfInvoice`, `InvalidDiscountRate`, `Unauthorized`, `ContractPaused` |
| `update_invoice` | `require_submitter_by_id` | `AlreadyFunded`, `AlreadyPaid`, `InvoiceExpired`, `InvoiceNotFound` |
| `convert_invoice_token` | `require_submitter_by_id` | `AlreadyFunded`, `AlreadyPaid`, `Unauthorized` |
| `transfer_invoice` | `require_submitter_by_id` | `AlreadyFunded`, `InvoiceDefaulted`, `InvoiceExpired` |
| `transfer_lp_position` | `current_lp.require_auth()` | `NotFunded`, `AlreadyPaid`, `Unauthorized` |
| `fund_invoice` | `require_lp(funder)` | `AlreadyFunded`, `InvoiceExpired`, `OverfundingRejected`, `NotApprovedFunder` |
| `cancel_invoice` | `require_submitter_by_id` | `AlreadyFunded`, `AlreadyPaid`, `AlreadyCancelled` |
| `expire_invoice` | none (anyone) | `NotYetDefaulted`, `AlreadyFunded`, `InvoiceExpired` |
| `mark_paid` | `require_payer_by_id` | `NotFunded`, `AlreadyPaid`, `OverpaymentRejected` |
| `claim_yield` | `require_lp_by_id` (funder) | `NothingToClaim`, `InvoiceDefaulted` |
| `claim_default` | `require_lp` + funder-list check | `NotYetDefaulted`, `NotFunded`, `Unauthorized` |
| `appeal_default` | `require_payer_by_id` | `AlreadyAppealed`, `NotDefaulted`, `AppealWindowClosed` |
| `resolve_appeal` | `require_admin` | `NotDefaulted`, `InvoiceNotFound` |
| `dispute_invoice` | `require_payer_by_id` | `AlreadyDisputed`, `AlreadyPaid`, `InvoiceDefaulted` |
| `resolve_dispute` | `require_admin` | `NotDisputed`, `Unauthorized` (invalid resolution) |
| `auto_resolve_dispute` | none (anyone) | `NotDisputed`, `Unauthorized` (timeout not reached) |

## 7. Verified findings vs residual risk

**Verified (backed by tests):**

* **VF-1** — The reachable edge set is exactly §3. Every `match invoice.status`
  arm in `lib.rs` maps each non-permitted state to a specific error; there is
  no `_ =>` silent-success arm.
* **VF-2** — Terminal states are absorbing: `mark_paid`→`Paid`, `cancel`→
  `Cancelled`, `expire`→`Expired` all reject subsequent mutations.
* **VF-3** — `resolve_appeal` returns to `Defaulted` for **both** outcomes
  (`upheld == true` and `upheld == false`); only the payer's reputation and the
  `invoices_defaulted` counter differ. `Appealed` is therefore not terminal.
* **VF-4** — `resolve_dispute`/`auto_resolve_dispute` recompute the restored
  state from `amount_funded` (`== amount` → `Funded`; `> 0` → `PartiallyFunded`;
  `0` → `Pending`), so a disputed invoice returns to its pre-dispute funding
  state.
* **VF-5** — The implicit `Pending → Expired` side-effect fires before any
  term update, and is persisted (not rolled back by the returned error for
  `update_invoice`/`convert_invoice_token`, which save before returning).

**Residual risk (documented, not changed here):**

* **RR-1 — due-date boundary asymmetry.** `update_invoice`,
  `convert_invoice_token`, and `claim_default` treat `now == due_date` as
  *past due / defaultable*, while `fund_invoice` and `expire_invoice` treat
  `now == due_date` as *still live*. This is an off-by-one boundary at the
  exact due timestamp; each entry point is internally consistent, but the set
  is not uniform. Changing it would alter on-chain semantics and is out of
  scope for a documentation/test issue.
* **RR-2 — implicit expiry depends on a later call.** A `Pending` invoice
  past due is only physically moved to `Expired` when `expire_invoice` (or one
  of the side-effect entry points) is called. Between due date and that call
  the stored status is still `Pending`, so off-chain readers must apply the
  same `now > due_date` rule themselves.
* **RR-3 — `claim_default` requires the caller to appear in the funder list.**
  For partially funded invoices `funded_at`/`funder` are not set, so `claim_default`
  is only reachable once fully funded (status `Funded`), matching T13.
* **RR-4 — queue resolution is status-gated, not status-mutating.**
  `resolve_fund_queue` finalizes a queue decision but never changes
  `invoice.status`; the winner must still call `fund_invoice`.

## 8. Tests

`contracts/invoice_liquidity/src/tests_state_transitions.rs` maps to the
invariants as follows:

| Test group | Invariant / rows |
| --- | --- |
| `submit_creates_pending` | INV-ST1, T1 |
| `funding_paths` | T5, T6, INV-ST5 |
| `cancel_paths` | T8, T9 |
| `expire_paths` | T10, side-effect expiry |
| `payment_paths` | T11, T12 |
| `default_and_appeal_paths` | T13, T14, T15, VF-3 |
| `dispute_paths` | T16, T17, T18, T19, VF-4 |
| `terminal_states_absorb` | INV-ST3 |
| `invalid_state_pairs_rejected` | INV-ST4, SM2 |

## 9. Compatibility

This document and its tests add no storage keys and change no entry-point
signatures or error codes. The transition table reflects the behavior already
implemented; the tests are the new, executable contract.
