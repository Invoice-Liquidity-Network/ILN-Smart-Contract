# Insurance Pool Design — Default Protection for LPs (Issue #123)

**Status:** Design-forward stub (interface + accounting implemented; economics & token settlement are follow-ups)
**Crate:** `contracts/insurance_pool`

## Motivation

Liquidity providers (LPs) who fund invoices bear the risk that a payer
*defaults*. Before mainnet, ILN should offer an **optional** insurance pool that
LPs can buy into for protection: they pay periodic premiums, and if an invoice
they funded defaults, the pool compensates them out of accumulated premiums.

This document describes the contract interface, the stub implementation shipped
in this PR, and the integration with the main `invoice_liquidity` contract.

## Interface

Defined in [`contracts/insurance_pool/src/insurance_interface.rs`] as the
`InsurancePoolInterface` trait (a typed `InsurancePoolInterfaceClient` is
generated for cross-contract calls):

| Method | Auth | Description |
|--------|------|-------------|
| `enroll(lp)` | `lp` | Opt an LP into the program. |
| `is_enrolled(lp) -> bool` | — | Whether `lp` is enrolled. |
| `deposit_premium(lp, amount)` | `lp` | Pay a premium; increases pool balance; auto-enrolls. |
| `claim(invoice_id) -> i128` | admin | Compensate for a defaulted invoice; returns payout. Idempotent per invoice. |
| `get_pool_balance() -> i128` | — | Total pool balance (premiums − payouts). |

Auxiliary views on the contract: `get_premiums_paid(lp)`, `get_coverage()`,
`is_claimed(invoice_id)`, plus `initialize(admin, coverage)`.

### Timelocked admin actions (Issue #542)

Coverage cap changes and admin transfers are sensitive to LPs, so they are
queued behind a `TIMELOCK_DELAY_SECONDS` (3 days) delay rather than applying
immediately:

| Method | Auth | Description |
|--------|------|-------------|
| `propose_coverage_change(new_coverage) -> u64` | admin | Queue a new coverage cap; returns the ledger timestamp (ETA) at which it becomes executable. |
| `execute_coverage_change()` | — | Apply the pending coverage change once its ETA has passed. Callable by anyone. |
| `cancel_coverage_change()` | admin | Cancel a pending coverage change before it executes. |
| `propose_admin_transfer(new_admin) -> u64` | admin | Queue an admin transfer; returns the ETA. |
| `execute_admin_transfer()` | — | Apply the pending admin transfer once its ETA has passed. Callable by anyone. |
| `cancel_admin_transfer()` | admin | Cancel a pending admin transfer before it executes. |
| `get_pending_coverage() -> Option<(i128, u64)>` | — | View the pending coverage proposal, if any. |
| `get_pending_admin() -> Option<(Address, u64)>` | — | View the pending admin proposal, if any. |

Each proposal overwrites any previously pending proposal of the same kind.
`execute_*` is intentionally open to any caller (like `execute_proposal` in
`iln_governance`) since the timelock itself — not caller identity — is the
security boundary once a change has been proposed by the admin.

## Stub semantics (what ships here)

The stub in `contracts/insurance_pool/src/lib.rs` is a **correct, fully-tested**
implementation of the interface with intentionally simplified economics:

- **Accounting, not custody.** `deposit_premium` records the premium as pool
  *accounting* balance. A production pool would move SAC tokens into the
  contract; that token settlement is deliberately out of scope for the stub.
- **Flat coverage cap.** `claim` pays `min(coverage, pool_balance)`, where
  `coverage` is a flat per-claim cap set at `initialize`. A production pool
  would price payouts against the invoice amount, the LP's premium history, and
  remaining pool solvency.
- **Idempotency & auth.** Each `invoice_id` can be claimed once; `claim`
  requires the configured admin (the liquidity contract in production).

Ten interface tests cover initialization, enrollment, premium accumulation,
coverage-capped vs balance-capped payouts, idempotency, and the empty-pool and
invalid-amount rejection paths (`cargo test -p insurance_pool`).

## Integration with `invoice_liquidity` (Issue #529)

The compensation hook lives on the liquidity contract's default-handling path
(`claim_default`), implemented directly in
`contracts/invoice_liquidity/src/lib.rs`. The design:

1. `invoice_liquidity` depends on the `insurance_pool` crate directly (a
   regular Cargo dependency, not just dev-only) so it can use the generated
   `InsurancePoolInterfaceClient` for typed cross-contract calls. The deployed
   pool address is stored as a new `DataKey::InsurancePool` instance key, set
   via the admin-gated `set_insurance_pool(pool)` / read via
   `get_insurance_pool()`.
2. After a default is confirmed for `invoice_id` (invoice marked `Defaulted`,
   funders refunded their principal), `claim_default` checks whether the
   *claiming* LP (the caller) is enrolled and, if so, attempts to claim on
   their behalf:

```rust
// inside claim_default(), after the principal refund loop:
if let Some(pool_addr) = crate::storage::get_insurance_pool(&env) {
    let pool_client = InsurancePoolInterfaceClient::new(&env, &pool_addr);
    let enrolled = matches!(pool_client.try_is_enrolled(&funder), Ok(Ok(true)));
    if enrolled {
        let (compensated, payout) = match pool_client.try_claim(&invoice_id, &funder) {
            Ok(Ok(payout)) => (true, payout),
            _ => (false, 0),
        };
        env.events().publish(
            (Symbol::new(&env, "insurance_claim_attempted"), invoice.id, funder.clone()),
            InsuranceClaimAttempted { invoice_id: invoice.id, lp: funder.clone(), compensated, payout },
        );
    }
}
```

3. The pool is configured with the liquidity contract's own address as its
   `admin`, so only a genuine confirmed default (the liquidity contract
   authorizing itself) can trigger `claim`. `claim()` transfers the payout
   directly from the pool's balance to the LP — `invoice_liquidity` never
   holds or forwards insurance funds itself.
4. **Graceful degradation**: the pool calls use `try_is_enrolled` /
   `try_claim` rather than the panicking variants. If the pool is paused,
   empty, unreachable, or the invoice was already claimed, `claim_default`
   still completes successfully (the principal refund and status update
   already happened, in the same atomic invocation) — it just reports
   `compensated: false` instead of reverting the whole default over an
   optional insurance top-up.

Tests covering this integration (using the real `insurance_pool` contract,
not a mock) are in `contracts/invoice_liquidity/src/tests_insurance_integration.rs`.

## SDK Integration

The `@iln/sdk` TypeScript package provides convenience methods to interact with the insurance pool:

### Querying pool status

```typescript
import { ILNClient } from "@iln/sdk";
import { Networks } from "@stellar/stellar-sdk";

const client = ILNClient.testnet(mySigner);

const poolBalance = await client.getPoolBalance(
  client.rpc,
  insurancePoolAddress
);

const coverage = await client.getCoverage(
  client.rpc,
  insurancePoolAddress
);

const isEnrolled = await client.isEnrolled(
  client.rpc,
  insurancePoolAddress,
  lpAddress
);

const premiumsPaid = await client.getPremiumsPaid(
  client.rpc,
  insurancePoolAddress,
  lpAddress
);
```

### Convenience methods

The SDK provides shorter method names for common queries:

```typescript
// Convenience wrapper for isEnrolled(...)
const enrolled = await client.isInsuranceEnrolled(
  client.rpc,
  insurancePoolAddress,
  lpAddress
);

// Convenience wrapper for getPremiumsPaid(...)
const premiums = await client.getInsurancePremiums(
  client.rpc,
  insurancePoolAddress,
  lpAddress
);
```

### Querying LP pool info

Fetch enrollment status, pool balance, coverage cap, and premiums paid in one call:

```typescript
const poolInfo = await client.getInsurancePoolInfo(
  client.rpc,
  insurancePoolAddress,
  lpAddress
);

console.log(`
  Enrolled: ${poolInfo.isEnrolled}
  Premiums paid: ${poolInfo.premiumsPaid}
  Pool balance: ${poolInfo.poolBalance}
  Coverage cap: ${poolInfo.coverage}
`);
```

### Enrolling in the pool

```typescript
import { Keypair } from "@stellar/stellar-sdk";

const lp = Keypair.fromSecret(lpSecretKey);
const sourceAccount = await client.rpc.getAccount(lp.publicKey());

const { txHash } = await client.enrollInsurancePool(
  client.rpc,
  insurancePoolAddress,
  lp.publicKey(),
  sourceAccount,
  (tx) => {
    tx.sign(lp);
    return tx;
  }
);

console.log(`Enrolled in insurance pool: ${txHash}`);
```

### Depositing premiums

Auto-enrolls the LP on first payment.

```typescript
const { txHash } = await client.depositInsurancePremium(
  client.rpc,
  insurancePoolAddress,
  lpAddress,
  premiumAmount,
  sourceAccount,
  (tx) => {
    tx.sign(lp);
    return tx;
  }
);

console.log(`Premium deposited: ${txHash}`);
```

### Filing a claim (admin-only)

In production, the `invoice_liquidity` contract is the pool admin and files claims automatically on confirmed defaults. For testing or standalone use:

```typescript
// Only the pool admin can call claim
const adminKeypair = Keypair.fromSecret(adminSecretKey);
const adminAccount = await client.rpc.getAccount(adminKeypair.publicKey());

const { txHash, payout } = await client.claimInsurance(
  client.rpc,
  insurancePoolAddress,
  invoiceId,
  adminAccount,
  (tx) => {
    tx.sign(adminKeypair);
    return tx;
  }
);

console.log(`Claim filed for invoice ${invoiceId}: payout ${payout} stroops`);
```

---

## Follow-up work (before mainnet)

- Real SAC token custody for premiums and payouts.
- Risk-priced premiums and coverage (vs. flat cap).
- Pool solvency guards and payout prioritization across simultaneous defaults.
- Governance parameters (premium schedule, coverage ratio).
- End-to-end integration tests across `invoice_liquidity` ⇄ `insurance_pool`.
