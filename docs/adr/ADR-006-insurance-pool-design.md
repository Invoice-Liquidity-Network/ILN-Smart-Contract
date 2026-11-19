# ADR-006: Insurance Pool Design

**Date:** 2026-07-26
**Status:** Accepted

## Context

Liquidity providers (LPs) who fund invoices bear the risk that a payer
*defaults*. Before mainnet, ILN needs a way for LPs to hedge that risk without
forcing every LP to accept it — some LPs want default protection and are
willing to pay for it; others are comfortable pricing default risk into their
discount rate and don't want the overhead.

The team had to decide how to structure that protection: build it into the
core `invoice_liquidity` contract directly, or as a separate, optional
contract that LPs opt into. A related question was how much of the real
economics (token custody, risk-based pricing, solvency guarantees) to build in
the first iteration versus deferring to a follow-up once the interface and
integration points are proven.

Key requirements:

- **Optionality** — LPs who don't want insurance shouldn't pay for it or be
  affected by it (no forced premium, no coupling to the invoice lifecycle for
  uninsured LPs).
- **Separation of concerns** — the core lending contract already carries
  significant complexity (funding, discounting, reputation, disputes,
  governance); bolting a full insurance economy onto it directly would bloat
  its audit surface.
- **Auditable, incremental delivery** — a fully-priced, fully-custodied
  insurance pool (real token transfers, actuarial premium pricing, solvency
  guards across concurrent claims) is a substantial system in its own right.
  Shipping a correct, tested stub first — with the interface and integration
  points frozen — lets the surrounding contracts and SDK be built and tested
  against a stable API while the economics harden separately.
- **Admin-gated payouts** — claims must only be payable by a caller the pool
  trusts to have actually verified a default, not by the LP or payer directly.

## Decision

Implement the insurance pool as a **separate Soroban contract**
(`contracts/insurance_pool`) with a narrow, typed interface
(`InsurancePoolInterface` in `insurance_interface.rs`), rather than embedding
insurance logic in `invoice_liquidity`.

The pool ships as a **design-forward stub**: the full public interface is
implemented and tested, but the underlying economics are deliberately
simplified for v1:

- **Accounting, not custody.** `deposit_premium(lp, amount)` records the
  premium as an accounting balance on the pool. No SAC tokens actually move
  into the contract yet — real token settlement is explicit follow-up work.
- **Flat coverage cap.** `claim(invoice_id)` pays out
  `min(coverage, pool_balance)`, where `coverage` is a single flat cap set at
  `initialize` — not priced against the specific invoice amount, the LP's
  premium history, or remaining pool solvency.
- **Idempotent, admin-gated claims.** Each `invoice_id` can be claimed exactly
  once. `claim` requires the configured pool admin — in production, the
  `invoice_liquidity` contract itself — so a payout can only be triggered by a
  confirmed default, not by an LP or payer directly.
- **Timelocked admin actions.** Coverage cap changes and admin transfers are
  queued behind a `TIMELOCK_DELAY_SECONDS` (3-day) delay
  (`propose_coverage_change` / `execute_coverage_change`,
  `propose_admin_transfer` / `execute_admin_transfer`), rather than applying
  immediately, since both are sensitive to enrolled LPs.

Integration with `invoice_liquidity` is a one-way hook on the default path:
when `claim_default` confirms a default for an enrolled LP, it calls
`InsurancePoolInterfaceClient::claim(invoice_id)` on the configured pool
address and emits a compensation event. The pool is configured with the
liquidity contract as its `admin`, so only a genuine confirmed default can
trigger a payout.

## Alternatives Considered

| Alternative | Why rejected |
|-------------|--------------|
| **Embed insurance state and logic directly in `invoice_liquidity`** | Couples an optional, still-evolving subsystem to the core lending contract's storage and audit surface; every future insurance change would risk regressing core lending logic. |
| **Ship full token custody and risk-priced premiums in v1** | Correct long-term design, but a much larger scope (SAC integration, actuarial pricing, solvency guards across concurrent claims) that would delay shipping the interface LPs and the SDK need to build against. Deferred to follow-up work. |
| **Let LPs or payers call `claim` directly** | Removes the guarantee that a payout only follows a genuine confirmed default; an admin-gated hook from `claim_default` is the only caller that can assert that invariant. |
| **Apply coverage/admin changes immediately (no timelock)** | Coverage cap and admin identity are trust-critical parameters for enrolled LPs; an immediate change gives LPs no time to react to a compromised or malicious admin. Mirrors the timelock pattern already used elsewhere in the protocol (see [ADR-005](ADR-005-governance-timelock.md)). |

## Consequences

**Positive:**
- LPs get an opt-in default-protection product without affecting LPs who
  don't enroll.
- The interface (`enroll`, `deposit_premium`, `claim`, `get_pool_balance`,
  and the timelocked admin flows) is frozen and fully tested, so the SDK
  (`getPoolBalance`, `getCoverage`, `isEnrolled`, `getPremiumsPaid`,
  `getInsurancePoolInfo`, plus write methods) and downstream integrations can
  be built now, before the economics are finalized.
- Keeping the pool in its own contract limits the blast radius of insurance
  bugs — a defect in premium accounting cannot corrupt invoice or escrow
  state in `invoice_liquidity`.
- The timelock on coverage/admin changes gives enrolled LPs visibility and
  reaction time before a sensitive parameter change takes effect.

**Negative / Trade-offs:**
- The stub does not custody real tokens: `deposit_premium` and `claim` move
  accounting balances only. Until real SAC settlement ships, the pool cannot
  be used with real funds in production.
- The flat coverage cap does not reflect actual risk (invoice size, LP
  concentration, or pool solvency under multiple simultaneous defaults) —
  a follow-up must add risk-priced payouts and solvency guards before
  mainnet.
- **Integration is documented but not wired into `claim_default`** in the
  current `invoice_liquidity` source — the crate did not compile on `main` at
  the time the pool was built (an unrelated merge issue), so the hook shown
  in `docs/insurance-pool-design.md` is a drop-in that still needs to be
  added once available. Contributors should not assume defaults are
  automatically compensated today.
- Cross-contract calls between `invoice_liquidity` and `insurance_pool` add
  CPU/instruction cost to `claim_default` versus an embedded design.

## Follow-up work (before mainnet)

- Real SAC token custody for premiums and payouts.
- Risk-priced premiums and coverage (vs. a flat cap).
- Pool solvency guards and payout prioritization across simultaneous
  defaults.
- Wire the `claim_default` → pool `claim` hook into `invoice_liquidity`.
- End-to-end integration tests across `invoice_liquidity` ⇄ `insurance_pool`.

See `docs/insurance-pool-design.md` for the full interface reference and SDK
usage examples.
