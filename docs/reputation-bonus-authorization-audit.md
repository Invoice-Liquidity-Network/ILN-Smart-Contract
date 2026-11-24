# Reputation bonus configuration authorization audit

**Scope:** `contracts/reputation_bonus/src/{lib,config,invoice,reputation}.rs`
and the governance execution path in
`contracts/iln_governance/src/lib.rs` (`UpdateReputationBonusParams`).

**Question:** does any path write bonus configuration, invoice state or
reputation counters without the authorization it should require?

Findings are split into **verified** (read in code, covered by a test) and
**residual risk** (design property, not changed here). The reputation counters
in this contract are independent of `invoice_liquidity`
([ADR-011](adr/ADR-011-reputation-state-source-of-truth.md)).

## 1. Write paths and gates (after this change)

| Entry point | Writes | Gate |
| --- | --- | --- |
| `init(admin)` | `Admin` | one-shot: `AlreadyInitialized` if an admin exists; **no signature** (see R1) |
| `set_config(config)` | `Config` | stored admin `require_auth()`; bounds validated |
| `update_config(caller, …)` | `Config` | `caller.require_auth()` **and** `caller == stored admin`; bounds validated |
| `submit_invoice(freelancer, payer, …)` | invoice, counters of both parties | `freelancer.require_auth()` |
| `mark_paid(id)` | invoice status, counters of both parties | invoice `payer.require_auth()`; status must be `Pending`/`Funded` |
| `handle_default(id)` | invoice status, counters of both parties | none (permissionless) but only after `ledger.timestamp > due_date`; status must be `Pending`/`Funded` |
| `get_config`, `get_reputation` | none | read-only |

Bounds enforced on every config write: `high_rep_threshold <= 100`,
`bonus_bps <= 500`, `min_discount_rate_bps > 0`.

### Governance execution

`execute_proposal` for `UpdateReputationBonusParams(threshold, bonus, min_rate)`
calls `update_config` on the stored `ReputationBonusContract` address with
**its own address** as `caller`. A contract implicitly authorizes its direct
sub-invocations, so the call succeeds only if the stored admin *is* the
governance contract. If not, the call fails, the proposal stays `Passed` and
`proposal_execution_failed` is emitted (see
[`governance-parameter-setter-audit.md`](governance-parameter-setter-audit.md)).
Governance never calls `set_config`.

## 2. Verified findings

| # | Finding before this change | Fix | Test |
| --- | --- | --- | --- |
| F1 | **`set_config` had no authorization.** Any account could overwrite the whole config, bypassing both the admin check and governance. | now requires the stored admin's signature; `ConfigErrorUnauthorized` before `init` | `set_config_without_admin_signature_is_rejected`, `set_config_before_init_is_rejected` |
| F2 | **`init` was repeatable.** Any account could call it again and replace the admin, then use `update_config` as the new admin. | second call returns `AlreadyInitialized`, nothing changes | `init_twice_is_rejected_and_admin_is_unchanged` |
| F3 | **`handle_default` could be called immediately on any `Pending` invoice** by anyone, defaulting it and degrading both parties' reputation before the due date. | refused with `InvoiceNotOverdue` until `timestamp > due_date` | `handle_default_is_rejected_until_invoice_is_overdue` |
| V1 | `update_config` rejects a signed non-admin and an unsigned admin; config is unchanged either way. | none needed | `update_config_by_signed_non_admin_is_rejected`, `update_config_without_admin_signature_is_rejected` |
| V2 | `submit_invoice` and `mark_paid` require the freelancer's / payer's signature and write nothing without it. | none needed | `submit_invoice_without_freelancer_signature_is_rejected`, `mark_paid_without_payer_signature_is_rejected` |
| V3 | A settled invoice cannot be paid or defaulted again (no double counting). | none needed | `settled_invoice_cannot_be_defaulted_or_paid_again` |
| V4 | Validation still applies to admin-signed writes. | none needed | `set_config_with_admin_signature_still_validates_bounds` |

## 3. Residual risk (not changed here)

- **R1 – `init` is first-caller-wins.** It is deliberately not signature-gated,
  because the intended admin is the governance contract, which cannot sign a
  top-level call. Deploy and `init` in the same step so nobody else can claim
  the slot first, and verify the stored admin after deployment.
- **R2 – no admin transfer.** With governance as admin, the initial
  `set_config` (now admin-only) cannot be sent by a deployer. Either `init`
  with a deployer key, call `set_config`, and accept that the admin stays that
  key, or add an authenticated `transfer_admin` entry point in a follow-up.
  Until then the config can only be bootstrapped by the admin address itself.
- **R3 – payer consent.** `submit_invoice` needs only the freelancer's
  signature, so a freelancer can record invoices against any payer address and
  raise that payer's `invoices_submitted`, lowering their score. A freelancer
  can also pair with a second address they control to inflate their own score.
  The bonus rate reads only the freelancer's score, and this score is
  independent of the protocol score (ADR-011), but integrators must not treat
  it as sybil-resistant.
- **R4 – unvalidated invoice fields.** `amount` and `due_date` are not checked
  (zero or negative amounts, past due dates are accepted). Past due dates make
  `handle_default` available immediately, by design.
- **R5 – `handle_default` is permissionless.** Once overdue, anyone may default
  an invoice the payer has not marked paid. A payer who paid off-chain must
  call `mark_paid` before the due date passes.

## 4. Success and failure behaviour

| Case | Result |
| --- | --- |
| Normal: admin-signed `set_config` / `update_config` with valid bounds | config stored; `update_config` emits one `parameter_updated` per field |
| Repeated: `init` again | `AlreadyInitialized`, admin unchanged |
| Repeated: `mark_paid` / `handle_default` on a settled invoice | `IllegalState`, counters unchanged |
| Unauthorized: `set_config` / `update_config` without the admin's signature | host auth failure, config unchanged |
| Unauthorized: `update_config` signed by a non-admin | `ConfigErrorUnauthorized`, config unchanged |
| Stale: `handle_default` at or before `due_date` | `InvoiceNotOverdue`, counters unchanged |
| Not initialised: `set_config` / `update_config` before `init` | `ConfigErrorUnauthorized` |
| Interrupted: governance execution against a non-admin target | proposal stays `Passed`, retryable, no config change |

## 5. API compatibility

- `init` now returns `Result<(), ContractError>` (was `()`); callers that
  ignore the result are unaffected, a second call now errors.
- New `ContractError` values: `AlreadyInitialized = 10`,
  `InvoiceNotOverdue = 11`. Existing values are unchanged.
- No storage keys or struct layouts changed; no migration needed.
- `docs/access-control-matrix.generated.md` infers roles from the source body
  and was already out of date on this branch; regenerate it separately.

## 6. Reviewing

```bash
cargo test -p reputation_bonus
```
