# Formal Verification Specification — Cross-Contract System Invariants

## 1. Overview

Per-contract specs cover local safety:

- [`formal-verification.md`](formal-verification.md) — `invoice_liquidity` lifecycle & governance
- [`formal-verification-insurance.md`](formal-verification-insurance.md) — `insurance_pool` solvency
- [`formal-verification-distribution.md`](formal-verification-distribution.md) — `iln_distribution` reward accounting

This document specifies **system-level** invariants that only make sense across
`invoice_liquidity` (ILN), `iln_distribution`, and `insurance_pool` together.
They are verified by integration tests under `contracts/tests/` (wired as
`[[test]]` targets on `invoice_liquidity`), not by single-contract `proptest`
suites — those cannot see foreign contract storage.

**Harness:** `contracts/tests/cross_contract_invariants_test.rs`  
**Run:** `cargo test -p invoice_liquidity --test cross_contract_invariants_test`

---

## 2. Invariant X1 — Funding notifies distribution (when wired)

**Property:** After `set_distribution_contract` and a successful `fund_invoice`,
`iln_distribution.get_accrual(lp)` is strictly greater than its pre-fund value.

**Why cross-contract:** Accrual lives in `iln_distribution`; the trigger is an
ILN hook (`notify_distribution_funding`). A per-contract ILN test cannot see
the accrual store; a per-contract distribution test cannot see `fund_invoice`.

**Verified by:** `x1_funding_increases_lp_distribution_accrual`

---

## 3. Invariant X2 — Settlement notifies distribution (when wired)

**Property:** After a successful on-time `mark_paid`, freelancer (and payer,
when rates are non-zero) distribution accruals are strictly greater than their
pre-settlement values.

**Why cross-contract:** Settlement state transitions are ILN-local; reward
accrual is distribution-local. The composition is the product guarantee.

**Verified by:** `x2_settlement_increases_freelancer_distribution_accrual`

---

## 4. Invariant X3 — Insurance claim payout is bounded by pool and enrollment

**Property:** For a defaulted, insurance-wired invoice whose LP is enrolled with
a solvent pool: `claim_default` succeeds, and afterward
`insurance_pool.get_pool_balance()` equals the pre-claim balance minus the
paid compensation (or remains unchanged if compensation is zero / not enrolled).
Pool balance never goes negative (composes with insurance S1).

**Why cross-contract:** `claim_default` in ILN invokes `insurance_pool.claim`;
neither side alone proves the paired state update.

**Verified by:** `x3_default_claim_reduces_insurance_pool_by_payout`

---

## 5. Invariant X4 — Escrow + insurance reserves do not exceed tracked inflows

**Property:** In the test harness, let `inflows` be the sum of all payment-token
`mint` amounts credited to actors for the scenario. After any sequence of fund /
premium-deposit / settle / claim operations in the harness:

```text
token.balance(iln) + insurance_pool.get_pool_balance() + Σ user_balances(tracked)
  == inflows
```

i.e. ILN escrow plus insurance reserves plus remaining user balances conserve
minted supply — the pool and escrow cannot manufacture tokens.

**Why cross-contract:** TVL is the sum of balances across contracts and users;
no single contract stores the global conservation predicate.

**Verified by:** `x4_payment_token_conserved_across_iln_and_insurance`

---

## 6. Invariant X5 — Cross-module default compensation is single-shot per invoice

**Property:** After a successful `claim_default` that pulled insurance
compensation for `invoice_id`, a second `claim_default` for the same id fails
(or is a no-op that does not reduce the pool again), and
`insurance_pool` rejects a second `claim(invoice_id)` with already-claimed
semantics when invoked consistently with ILN’s integration.

**Why cross-contract:** Idempotency is specified for the pool (S3) and for ILN
default handling separately; the system property is that the *pair* cannot pay
insurance twice for one invoice.

**Verified by:** `x5_insurance_compensation_not_paid_twice_for_same_invoice`

---

## 7. Residual risks

- Distribution rates of zero trivially satisfy X1/X2 with “no increase”; tests
  use positive default rates after `initialize`.
- X4 is harness-level conservation for the payment token mock/SAC used in
  tests, not a consensus proof over every possible token implementation.
- Governance and `reputation_bonus` are out of scope here (covered by the
  full-protocol lifecycle test and Part II of `formal-verification.md`).

## 8. Coverage

| Invariant | Verified by |
|-----------|-------------|
| X1 Funding → LP accrual | `x1_funding_increases_lp_distribution_accrual` |
| X2 Settlement → freelancer accrual | `x2_settlement_increases_freelancer_distribution_accrual` |
| X3 Default claim vs pool balance | `x3_default_claim_reduces_insurance_pool_by_payout` |
| X4 Token conservation | `x4_payment_token_conserved_across_iln_and_insurance` |
| X5 No double insurance pay | `x5_insurance_compensation_not_paid_twice_for_same_invoice` |
