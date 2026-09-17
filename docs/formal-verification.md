# Formal Verification Specification — Invoice Lifecycle

## 1. Overview

This document defines formal invariants, valid state transitions, and authorization properties for the invoice lifecycle in the Invoice Liquidity contract. These specifications serve as the basis for formal verification, property-based testing, and audit review.

**Target Contract:** `contracts/invoice_liquidity/src/invoice.rs` and `contracts/invoice_liquidity/src/lib.rs`

---

## 2. State Machine Specification

### 2.1 Invoice Status Enum

```rust
pub enum InvoiceStatus {
    Pending,         // Submitted, awaiting liquidity
    Funded,          // Fully funded by LP(s), freelancer paid out
    PartiallyFunded, // Partially funded, still awaiting remainder
    Paid,            // Payer settled in full
    Defaulted,       // Past due_date, unpaid
    Appealed,        // Payer contested the default ruling
    Disputed,        // Payer disputed the invoice before settlement
    Expired,         // Past due_date with no funding
    Cancelled,       // Freelancer cancelled before funding
}
```

### 2.2 Valid State Transition Table

| From State | Action | To State | Guards |
|---|---|---|---|
| `Pending` | `submit_invoice` | `Pending` | Caller is freelancer; terms valid |
| `Pending` | `fund_invoice` (full) | `Funded` | `amount_funded == amount` |
| `Pending` | `fund_invoice` (partial) | `PartiallyFunded` | `0 < amount_funded < amount` |
| `Pending` | `cancel_invoice` | `Cancelled` | Caller is freelancer |
| `Pending` | `expire_invoice` | `Expired` | `timestamp > due_date` |
| `Pending` | `update_invoice` | `Pending` | Caller is freelancer |
| `Pending` | `transfer_invoice` | `Pending` | Caller is freelancer |
| `Pending` | `dispute_invoice` | `Disputed` | Caller is payer |
| `PartiallyFunded` | `fund_invoice` (remainder) | `Funded` | `amount_funded == amount` |
| `PartiallyFunded` | `fund_invoice` (partial) | `PartiallyFunded` | `0 < amount_funded < amount` |
| `PartiallyFunded` | `cancel_invoice` | `Cancelled` | Refunds all funders |
| `PartiallyFunded` | `dispute_invoice` | `Disputed` | Caller is payer |
| `Funded` | `mark_paid` (full) | `Paid` | `amount_paid == amount` |
| `Funded` | `mark_paid` (partial) | `Funded` | `amount_paid < amount` |
| `Funded` | `claim_default` | `Defaulted` | `timestamp > due_date` |
| `Funded` | `dispute_invoice` | `Disputed` | Caller is payer |
| `Paid` | — | — | Terminal state |
| `Defaulted` | `appeal_default` | `Appealed` | Within appeal window |
| `Appealed` | `resolve_appeal(true)` | `Defaulted` | Admin only; score restored |
| `Appealed` | `resolve_appeal(false)` | `Defaulted` | Admin only |
| `Disputed` | `resolve_dispute(1)` | `Cancelled` | Admin; payer right → refund LPs |
| `Disputed` | `resolve_dispute(2)` | `Funded`/`PartiallyFunded`/`Pending` | Admin; freelancer right |
| `Disputed` | `auto_resolve_dispute` | `Funded`/`PartiallyFunded`/`Pending` | Timeout passed |
| `Expired` | — | — | Terminal state |
| `Cancelled` | — | — | Terminal state |

### 2.3 Prohibited Transitions (Enforced)

| From State | Action | Error |
|---|---|---|
| `Funded` | `fund_invoice` | `AlreadyFunded` |
| `Funded` | `update_invoice` | `AlreadyFunded` |
| `Funded` | `transfer_invoice` | `AlreadyFunded` |
| `Paid` | `fund_invoice` | `AlreadyPaid` |
| `Paid` | `mark_paid` | `AlreadyPaid` |
| `Paid` | `claim_default` | `AlreadyPaid` |
| `Defaulted` | `fund_invoice` | `InvoiceDefaulted` |
| `Defaulted` | `mark_paid` | `InvoiceDefaulted` |
| `Defaulted` | `claim_default` | `InvoiceDefaulted` |
| `Pending` | `mark_paid` | `NotFunded` |
| `Pending` | `claim_default` | `NotFunded` |
| `PartiallyFunded` | `mark_paid` | `NotFunded` |
| `PartiallyFunded` | `claim_default` | `NotFunded` |
| Any non-`Pending` | `update_invoice` | Varies by state |

---

## 3. Balance Invariants

### Invariant B1: `amount_funded <= amount`
**Property:** For every invoice, `invoice.amount_funded` must never exceed `invoice.amount`.

**Rationale:** Prevents overfunding that would break accounting.

**Enforcement:** `fund_invoice()` at `src/lib.rs:1153`:
```rust
if invoice.amount_funded + fund_amount > invoice.amount {
    return Err(ContractError::OverfundingRejected);
}
```

### Invariant B2: `amount_paid <= amount`
**Property:** For every invoice, `invoice.amount_paid` must never exceed `invoice.amount`.

**Rationale:** Prevents overpayment that would inflate LP payouts.

**Enforcement:** `mark_paid()` at `src/lib.rs:1524-1527`:
```rust
let remaining = invoice.amount - invoice.amount_paid;
if amount > remaining {
    return Err(ContractError::OverpaymentRejected);
}
```

### Invariant B3: Total LP Payout == Amount Paid - Protocol Fee
**Property:** When an invoice is fully paid, the sum of all LP payouts equals `invoice.amount - protocol_fee`.

**Enforcement:** Proportional distribution at `src/lib.rs:1607-1614`:
```rust
for i in 0..funders.len() {
    let (funder_addr, fund_amt) = funders.get(i).unwrap();
    let funder_share = distribute_amount.checked_mul(fund_amt).unwrap_or(0) / invoice.amount;
    // ...
}
```

### Invariant B4: No Double-Claim on Default
**Property:** An invoice can only transition to `Defaulted` once. Subsequent `claim_default` calls fail.

**Enforcement:** Status guard at `src/lib.rs:1733-1744` — only `Funded` invoices can transition to `Defaulted`.

---

## 4. Authorization Invariants

### Invariant A1: Freelancer Authorization
| Action | Authorized Caller | Enforcement |
|---|---|---|
| `submit_invoice` | Freelancer address | `require_submitter` |
| `update_invoice` | Freelancer of invoice | `require_submitter_by_id` |
| `cancel_invoice` | Freelancer of invoice | `require_submitter_by_id` |
| `transfer_invoice` | Freelancer of invoice | `require_submitter_by_id` |
| `convert_invoice_token` | Freelancer of invoice | `require_submitter_by_id` |

### Invariant A2: Payer Authorization
| Action | Authorized Caller |
|---|---|
| `mark_paid` | Payer of invoice |
| `appeal_default` | Payer of invoice |
| `dispute_invoice` | Payer of invoice |

### Invariant A3: LP Authorization
| Action | Authorized Caller |
|---|---|
| `fund_invoice` | LP (authenticated via `require_lp` + queue check) |
| `claim_default` | LP who funded the invoice |
| `claim_yield` | LP who funded the invoice |
| `join_fund_queue` | LP |
| `transfer_lp_position` | Current LP of invoice |

### Invariant A4: Admin Authorization
| Action | Guard |
|---|---|
| `set_admin` | `require_admin` |
| `update_fee_rate` | `require_admin` |
| `update_max_discount` | `require_admin` |
| `add_token` | `require_admin` |
| `remove_token` | `require_admin` |
| `pause` / `unpause` | `require_admin` |
| `set_distribution_contract` | `require_admin` |
| `set_price_oracle` | `require_admin` |
| `resolve_appeal` | `require_admin` |
| `resolve_dispute` | `require_admin` |
| `upgrade` | `require_admin` |

---

## 5. Proof Specification

### 5.1 Safety Properties

**SP1 — State determinism:** Given a starting state and a sequence of actions, there is exactly one reachable final state. The state machine is deterministic.

**SP2 — No stuck funds:** For every terminal state (`Paid`, `Defaulted`, `Expired`, `Cancelled`), all funds are either:
- Distributed to the intended recipient (freelancer/LP), or
- Returned to the funder (on default/cancellation), or
- Held by the contract as protocol fees.

**SP3 — Auth enforcement:** Every state-mutating action requires the caller to pass an explicit authorization guard. No action can be invoked without satisfying its auth predicate.

### 5.2 Liveness Properties

**LP1 — Funding completion:** If `amount_funded == amount`, the invoice transitions to `Funded` and the freelancer receives `amount - discount`.

**LP2 — Settlement:** If a `Funded` invoice is paid before `due_date`, the invoice transitions to `Paid` and LPs receive principal + yield.

**LP3 — Default resolution:** If a `Funded` invoice remains unpaid past `due_date`, any LP may invoke `claim_default` to receive their principal back (minus discount).

### 5.3 Invariant Enforcement in Code

The function `check_invariants()` in `tests_invariants.rs` programmatically asserts:
- `Pending` → `funder.is_none()` && `amount_funded == 0`
- `PartiallyFunded` → `0 < amount_funded < amount`
- `Funded` → `funder.is_some()` && `funded_at.is_some()` && `amount_funded == amount`
- All invoice IDs are loadable from storage

---

## 6. Storage Isolation Guarantee

**Property:** Each invoice occupies an independent storage key (`DataKey::Invoice(id)`). Operations on invoice `i` never modify the storage of invoice `j` for `i ≠ j`.

**Enforcement:** All invoice mutations operate on a single invoice loaded by ID. Cross-invoice state isolation is verified by `test_storage_isolation_adjacent_invoice_ids()` in `tests_security.rs`.

---

## 7. Coverage

| Property | Verified By |
|---|---|
| State machine valid transitions | `tests_state_machine.rs` — 15+ test cases |
| State machine invalid transitions | `tests_state_machine.rs` — 10+ test cases |
| Balance invariants | `tests_security.rs` — overflow/underflow tests |
| Authorization invariants | `tests_access_control.rs`, `tests_auth.rs` |
| Storage isolation | `tests_security.rs` — adjacency test |
| Cross-invoice independence | `tests_invariants.rs` — `check_invariants` |
| Admin function guards | `tests_access_control.rs` |
| MEV funding queue single winner & no stuck funds | `tests_mev_mitigation.rs`, `tests_lp_priority_queue.rs` |

---

## 8. Funding Queue Resolution Invariant (MEV Mitigation)

### 8.1 Specification & Invariants

To mitigate front-running and MEV extraction around high-yield invoice funding, the contract implements a reputation-weighted queue with a mandatory maturity window.

#### Invariant Q1: Deterministic Single Winner
**Formal Property:**
$$\forall \text{invoice } i, \text{ if } |\text{Queue}(i)| \ge 1, \quad \text{resolve\_fund\_queue}(i) = LP^*$$
where:
$$LP^* = \operatorname{argmax}_{lp \in \text{Queue}(i)} (\text{score}(lp))$$
Ties are broken deterministically by initial queue join order (first-come, first-served). Exactly one LP is designated as `approved_lp`.

#### Invariant Q2: Zero Stuck Funds & Solvency Guarantee
**Formal Property:**
$$\forall lp \in \text{Queue}(i) \setminus \{LP^*\}, \quad \Delta \text{Balance}(lp) = 0$$
Joining the funding queue registers intent and snapshots reputation without escrowing or locking tokens. Non-winning LPs are rejected from calling `fund_invoice` with `ContractError::NotApprovedFunder` and retain 100% of their token balances with zero capital locked or stranded in contract storage.

#### Invariant Q3: Monotonic Maturity Delay Guard
**Formal Property:**
$$\text{resolve\_fund\_queue}(i) \text{ succeeds} \iff \text{LedgerSeq} \ge \text{OpenedAt}(i) + \text{QUEUE\_DELAY\_LEDGERS}$$
where $\text{OpenedAt}(i)$ is permanently anchored to the ledger sequence of the *first* LP joining the queue. Subsequent LP joins strictly preserve $\text{OpenedAt}(i)$ and cannot reset the maturity timer. Calls prior to maturity strictly revert with `ContractError::QueueNotMature`.

#### Invariant Q4: Resolution Idempotency
**Formal Property:**
$$\forall t \ge t_{\text{resolved}}, \quad \text{resolve\_fund\_queue}_t(i) = \text{resolve\_fund\_queue}_{t_{\text{resolved}}}(i) = LP^*$$

### 8.2 Guard Summary

| Function | Pre-condition Guard | Failure Error |
|---|---|---|
| `join_fund_queue(lp, id)` | Invoice exists and is in `Pending` / `PartiallyFunded` | `InvoiceNotFound` / `AlreadyFunded` / etc. |
| `join_fund_queue(lp, id)` | Queue not yet resolved | `NotApprovedFunder` |
| `join_fund_queue(lp, id)` | LP not already in queue | `AlreadyInQueue` |
| `resolve_fund_queue(id)` | At least one LP in queue | `NotFunded` |
| `resolve_fund_queue(id)` | Current ledger $\ge \text{OpenedAt} + \text{QUEUE\_DELAY\_LEDGERS}$ | `QueueNotMature` |
| `fund_invoice(lp, id, ...)` | If queue resolved, caller $lp == LP^*$ | `NotApprovedFunder` |

