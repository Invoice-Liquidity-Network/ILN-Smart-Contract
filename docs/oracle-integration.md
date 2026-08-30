# Oracle Integration Guide

This guide explains how third-party providers can deploy a compatible payer-verification oracle and register it with the Invoice Liquidity Network.

---

## Overview

The ILN payer-verification oracle is an optional on-chain component. When registered, the ILN contract calls it to check whether a payer's identity or creditworthiness has been verified off-chain before allowing invoice funding. See [oracle-design.md](./oracle-design.md) for the full design specification.

---

## Oracle Interface Specification

> **⚠️ This section describes the interface `fund_invoice` actually calls.**
> `oracle_interface.rs` also declares a formal `OracleInterface` trait
> (`#[contractclient(name = "OracleClient")]`) with `get_verification`/
> `update_verification`/`VerificationResult` — that trait is **legacy and
> only ever used for the `interface_version()` check** at registration time
> (`verify_oracle_interface_version` in `oracle_registry.rs`). Its
> `get_verification`/`update_verification` methods are **never called**
> (`check_payer_verified()`, the one function that would call
> `get_verification`, is itself dead code — see
> [Staleness Policy](#staleness-policy) above). An oracle that implements
> *only* the formal trait as previously documented here would pass
> registration's version check and then **panic on every subsequent
> `fund_invoice` call** that requests verification, because the method
> below is what's actually invoked and it wouldn't exist. Implement the
> interface below, not the trait in `oracle_interface.rs`.

Any oracle contract must expose:

```rust
// Returns ORACLE_INTERFACE_VERSION (checked once, at registration time,
// via oracle_registry.rs's verify_oracle_interface_version).
fn interface_version(env: Env) -> u32

// Returns the verification record for `payer`. Called directly by
// fund_invoice via env.invoke_contract — a raw dynamic call, not through
// any typed client — on every funding call that passes
// require_oracle_verification=true and resolves to this oracle.
fn get_payer_data(env: Env, payer: Address) -> OracleVerificationResponse
```

Where `OracleVerificationResponse` is a `#[contracttype]` struct (defined at
`invoice_liquidity`'s crate root, `lib.rs`):

```rust
#[contracttype]
pub struct OracleVerificationResponse {
    pub is_verified: bool, // true = payer is verified
    pub timestamp: u32,    // LEDGER SEQUENCE (not Unix time) of last update
}
```

Two things worth calling out explicitly since they differ from the legacy
trait's shape: the field is `is_verified`, not `verified`; and `timestamp`
is a ledger **sequence number** (compared against `max_oracle_age_ledgers` —
see [Staleness Policy](#staleness-policy)), not a Unix epoch second count.

**`get_payer_data` must never panic.** `fund_invoice` calls it via
`env.invoke_contract` — the panicking variant, not `try_invoke_contract` —
so a trap here aborts the *entire* funding transaction rather than
gracefully failing verification. If no record exists for a payer, return
`OracleVerificationResponse { is_verified: false, timestamp: 0 }` (an
all-zero/absent record reads as maximally stale, which correctly fails
closed rather than passing an unrecognized payer).

There is no `update_verification`-equivalent call from the ILN contract —
how the oracle's own data gets populated (a pull from a KYC provider, a
push from an admin key, etc.) is entirely up to the oracle implementation
and outside ILN's interface contract.

---

## Staleness Policy

`fund_invoice`'s `require_oracle_verification` path (the live enforcement point) checks freshness against `max_oracle_age_ledgers`, a per-protocol setting in **ledgers**, not seconds — default `DEFAULT_MAX_ORACLE_AGE_LEDGERS` = 17 280 ledgers, ≈ **24 hours** at 5 seconds/ledger. It's read/set via `get_max_oracle_age()` / `set_max_oracle_age()` (admin-gated, rate-limited to one call per ~10 minutes). Oracle operators must refresh records more often than this window to keep payers passing verification.

`oracle_interface.rs` also defines `ORACLE_STALENESS_THRESHOLD_SECS` (7 days) and an `is_fresh()` helper — this is **legacy/unused**: nothing in `fund_invoice` or any other live code path calls `is_fresh()`. Don't rely on the 7-day figure; it does not reflect enforced behavior. See [oracle-attack-economics.md](oracle-attack-economics.md) for why the actual enforced window matters to attack-cost modeling.

---

## Deploying a Custom Oracle

### Step 1 — Implement the interface

Create a Soroban contract that implements `interface_version` and `get_payer_data` as shown in [Oracle Interface Specification](#oracle-interface-specification) above. `contracts/tests/mocks/mock_oracle.rs`'s `MockOracle` implements the legacy `get_verification` trait instead (see the warning above) and is **not** a correct reference for the interface `fund_invoice` actually calls; use `MockRegistryOracle` in `contracts/invoice_liquidity/src/tests_oracle_registry.rs` as the reference implementation instead — it implements `interface_version`/`get_payer_data` correctly and is exercised by that file's own test suite.

### Step 2 — Deploy to the target network

```sh
stellar contract deploy \
  --wasm oracle.wasm \
  --source <operator-keypair> \
  --network <testnet|mainnet>
```

Note the deployed contract address.

### Step 3 — Register with ILN

Two registration paths exist:

- **`set_price_oracle(oracle)`** — the original, single-slot mechanism (`Config.price_oracle`). Still supported as the final fallback in the resolution order (see [ADR-010](adr/ADR-010-oracle-registry.md)), but new integrations should prefer the registry below.
- **`register_oracle(feed_type, oracle)`** / **`register_token_oracle(feed_type, token, oracle)`** — the governance-controlled registry (Issue #532): a feed-type-wide default, optionally overridden per token. Both validate the target's `interface_version()` before persisting.

```typescript
// Using the Soroban TypeScript SDK — registry path (preferred)
await ilnClient.register_oracle({
  feedType: "Identity",
  oracle: oracleContractAddress,
}, { fee: 100 });
```

Once registered, all subsequent payer-verification checks use the new oracle. There is no delay — the oracle takes effect immediately, including for invoices submitted before the registration call. See [Replacing an Already-Registered Oracle](#replacing-an-already-registered-oracle) below for what this means when swapping an oracle that's already live.

### Step 4 — Populate verification data

There is no ILN-initiated call analogous to a hypothetical `update_verification` — the ILN contract only ever *reads* `get_payer_data`. How your oracle's own records get populated (a KYC pipeline pushing updates, an admin-key-gated write, a pull from a third-party API cached on-chain, etc.) is entirely internal to your oracle contract and outside ILN's interface contract.

Refresh records more often than `max_oracle_age_ledgers` (~24h by default — see [Staleness Policy](#staleness-policy)) to keep payers passing verification.

---

## Replacing an Already-Registered Oracle

Registering a new address for a feed type/token that already has one registered **overwrites it in place** — `register_oracle`/`register_token_oracle` are documented as "register (or update)". This is the mechanism for swapping in, e.g., a Reflector-style oracle's upgraded contract after it changes its own interface internally, or replacing a provider entirely.

**This takes effect immediately, for every invoice, including ones already submitted or partially funded before the swap.** There is no grandfathering and no transition window, by explicit design — see [ADR-010's "Oracle Swap Semantics for In-Flight Invoices"](adr/ADR-010-oracle-registry.md#oracle-swap-semantics-for-in-flight-invoices) for the full rationale. In short: `require_oracle_verification` is a per-`fund_invoice`-call argument, never stored on the invoice, and resolution always reads the registry's *current* state — so there is nothing invoice-side that a swap could leave in an inconsistent state. Two funding calls against the same invoice, one before a swap and one after, will correctly and independently resolve against whichever oracle was registered at the moment each call ran.

Practical checklist for a live swap:

- [ ] Confirm the new oracle's `interface_version()` matches `ORACLE_INTERFACE_VERSION` — registration rejects a mismatch automatically, but verify before relying on it.
- [ ] Confirm the new oracle's `get_payer_data` is already populated for payers with invoices currently in flight — a swap to an oracle with no data for an existing payer will report them unverified (or, if it panics on an unrecognized payer instead of returning a zero-value record, will abort funding entirely — see the panic warning in [Oracle Interface Specification](#oracle-interface-specification)).
- [ ] If continuity for in-flight invoices matters operationally, populate the new oracle's data *before* registering it, not after.
- [ ] Expect `get_oracle_health`/`check_oracle_health`'s recorded snapshot for this feed type/token to reflect whichever oracle was queried most recently — a swap does not reset or carry forward the health history from the old address.

---

## Failure Handling

| Situation | ILN Response |
|---|---|
| No oracle registered | All payers pass (fail-open) |
| Oracle returns `is_verified = false` | Payer check fails (`PayerUnverified`) |
| Oracle timestamp older than `max_oracle_age_ledgers` | Rejected as stale (`OracleDataStale`) — see [Staleness Policy](#staleness-policy) for the actual ~24h default, not the dead 7-day constant |
| Oracle contract panics | **Aborts the entire `fund_invoice` transaction** — `env.invoke_contract` is the panicking variant, not a caught one. This differs from `check_oracle_health`, which never panics regardless of what the oracle does. |

---

## Testing with MockOracle

> **⚠️** `contracts/tests/mocks/mock_oracle.rs`'s `MockOracle` (and
> `contracts/tests/oracle_integration_test.rs`, which exercises it)
> implement the **legacy, dead** `get_verification`/`VerificationResult`
> interface — useful for testing that specific mock's own behavior, but it
> does not exercise `fund_invoice`'s actual `get_payer_data` code path.
> For tests that need to exercise real oracle-gated funding behavior, use
> `MockRegistryOracle` from
> `contracts/invoice_liquidity/src/tests_oracle_registry.rs` as the
> reference pattern instead (`interface_version` + `get_payer_data`,
> configurable `is_verified`/`timestamp` via a `set_response` test helper).
> That file's own test suite (including the oracle-swap tests referenced in
> [ADR-010](adr/ADR-010-oracle-registry.md#oracle-swap-semantics-for-in-flight-invoices))
> is the current, correct set of examples to follow.

---

## Security Checklist

- [ ] Oracle's own data-population path enforces appropriate access control internally (there is no ILN-side `update_verification` call to rely on — see Step 4)
- [ ] The ILN admin key that calls `set_price_oracle`/`register_oracle`/`register_token_oracle` is protected (hardware wallet / multisig)
- [ ] Consider a governance timelock on oracle registration changes (see [governance.md](./governance.md))
- [ ] Refresh verification records more often than `max_oracle_age_ledgers` (~24h default)
- [ ] Monitor oracle contract for unexpected upgrades or admin key changes
- [ ] The oracle is a single trust point unless multiple sources are registered for cross-checking — see [oracle-design.md](oracle-design.md#multi-source-price-deviation-checking-price-feed) (price feeds) and [oracle-attack-economics.md](oracle-attack-economics.md) (the cost/benefit model of a single-source compromise)
- [ ] Before swapping an already-registered oracle, read [Replacing an Already-Registered Oracle](#replacing-an-already-registered-oracle) above — the swap applies immediately to in-flight invoices, by design
