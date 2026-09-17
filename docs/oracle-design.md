# Oracle Design — Payer Verification

## Overview

The Invoice Liquidity Network (ILN) supports an optional off-chain payer verification oracle. The oracle surfaces KYC or creditworthiness data gathered off-chain into the smart contract, allowing invoice funding to be gated on verified payers.

The oracle is entirely optional. When no oracle address is registered, all payer-verification checks pass (fail-open). This preserves backwards compatibility and lets the system operate without an oracle in development or permissive deployments.

---

## Oracle Data Format

Each payer verification record carries two fields:

| Field | Type | Description |
|---|---|---|
| `verified` | `bool` | Whether the payer has been verified by the oracle operator |
| `timestamp` | `u64` | Unix epoch seconds when the oracle last updated this entry |

The ILN contract reads these fields via a single cross-contract call per query. The oracle contract is responsible for storing and updating them per-address.

---

## Update Mechanism

The oracle follows a **pull model**:

1. The oracle operator calls `update_verification(payer, verified)` on the oracle contract off-chain at any time (e.g., after completing a KYC check).
2. When the ILN contract needs to verify a payer, it calls `oracle.get_verification(payer)` and reads the current record.
3. There is no push or callback mechanism — the ILN contract reads on demand.

This design keeps the oracle stateless from ILN's perspective and avoids the complexity of push-based oracle patterns.

---

## Trust Model

- A single oracle address is stored in `Config.price_oracle` (shared with the price oracle slot for MVP simplicity).
- The oracle address is set by the ILN admin via `set_price_oracle(oracle_address)` in a separate transaction after `initialize()`.
- The oracle contract is fully trusted once registered — ILN does not validate oracle operator identity beyond the on-chain address.
- **Future work**: multi-oracle quorum (e.g., require 2-of-3 oracles to agree) is out of scope for this design.

---

## Failure Modes

| Scenario | ILN Behaviour |
|---|---|
| No oracle registered | Permissive — verification always passes |
| Oracle reports `verified = false` | Check fails; payer cannot proceed |
| Oracle data is stale (age > 7 days) | Treated as unverified; check fails |
| Oracle contract panics / traps | Treated as unverified (caller catches trap) |
| Oracle contract address is wrong / undeployed | Cross-contract call panics; ILN treats as unverified |

---

## Staleness Threshold

The default staleness threshold is **7 days** (604 800 seconds), defined as `ORACLE_STALENESS_THRESHOLD_SECS` in `oracle_interface.rs`.

Staleness is computed as:

```
now_seconds - oracle_timestamp > ORACLE_STALENESS_THRESHOLD_SECS
```

where `now_seconds` comes from `env.ledger().timestamp()`.

Oracle operators **must** refresh verification records at least every 7 days to keep payers active. The threshold can be tightened by changing the constant in a future contract upgrade if stricter freshness is required.

---

## Security Considerations

- The oracle is a **read-only dependency** — it cannot initiate token transfers or modify ILN state.
- The admin key that controls `set_price_oracle` is a single point of control. A compromised admin can register a malicious oracle. Governance timelock on oracle registration changes is recommended.
- Fail-open behaviour (no oracle → all pass) is appropriate for the MVP. High-security deployments should consider fail-closed defaults.
- Oracle address changes take effect immediately. There is no delay between registering a new oracle and it being used for checks. Consider adding a timelock.
