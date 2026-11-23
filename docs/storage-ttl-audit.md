# Storage TTL and Archival Audit

Scope: `contracts/invoice_liquidity/src/storage.rs` (plus the `invoice.rs` helpers it
delegates to). Regression tests: `contracts/invoice_liquidity/tests/storage_ttl_audit.rs`
(this audit) and `src/tests_queue_archival.rs` (queue TTL/archival, issues
#1011-#1015, already covers queue recovery across ledger advances).

## Verified behaviour

| Record | Extended when | Policy |
| --- | --- | --- |
| `InvoiceCore(id)`, `InvoiceMetadata(id)` | every `save_invoice` | `extend_ttl(1_000_000, 2_000_000)` — i.e. topped up to 2M ledgers whenever below 1M |
| `FundQueue`, `FundQueueOpenedAt`, `QueueResolution` | save **and** read (`extend_fund_queue_ttl`) | `QUEUE_TTL_THRESHOLD_LEDGERS` / `QUEUE_TTL_EXTEND_TO_LEDGERS`; guarded by `has()` because `extend_ttl` on a missing key traps |
| Reputation / other `invoice.rs` records | on write (`invoice.rs` `extend_ttl(1_000_000, 2_000_000)` sites) | same 1M/2M policy |
| Multisig proposals | on write | `extend_ttl(100_000, 200_000)` |

Failure behaviour:

* **Missing invoice** (never existed or archived and not restored): `get_invoice`
  returns `Err(InvoiceNotFound)`; mutating entrypoints return the same error.
  Tested by `missing_invoice_lookup_fails_cleanly_instead_of_trapping`.
* **Queue state archived mid-queue**: `resolve_fund_queue` fails closed with
  `QueueStateArchived` instead of resolving without the MEV delay (issue #1013).
* Reads of invoice core/metadata do **not** extend TTL; only writes do. An invoice
  that is only read for ~2M ledgers will archive. Restoration is a standard Soroban
  restore-footprint operation and needs no contract call.
* Repeated and unauthorized calls do not touch TTLs: extension happens only on the
  success path of a write, and failed invocations roll back.
* Ledger rollover / interruption: an interrupted (trapped) invocation rolls back
  its writes *and* its TTL bumps atomically.

## Findings

### F1 — `InvoiceFunders` has no TTL extension (verified, not changed)

`save_invoice_funders` (`storage.rs`) calls `persistent().set` with no `extend_ttl`,
so the funder list keeps the network default TTL while the invoice record it belongs
to is extended to ~2M ledgers. `get_invoice_funders` returns an **empty list** for a
missing key, so an archived funder list is indistinguishable from "no funders":
`claim_default` would return `Unauthorized` for a genuine funder and settlement loops
that iterate funders would pay nobody. This is the largest TTL risk found.

Not fixed here because it changes which entries pay rent and warrants a maintainer
decision (extend on write, extend on read, and/or fail closed like
`QueueStateArchived`). Current behaviour is pinned by
`invoice_funders_ttl_is_not_extended_known_gap`; flip that assertion when fixed.

### F2 — Reads do not refresh invoice TTL (verified, residual risk)

Only writes bump `InvoiceCore`/`InvoiceMetadata`. Long-lived, rarely-written invoices
(e.g. `Funded` and awaiting payment for years) depend on someone restoring them.
Documented, no change.

## Assumptions

TTL values are ledger counts; the network's maximum entry TTL caps `extend_to`
(`2_000_000` is within current mainnet limits). Instance-storage TTL (admin/config)
is out of scope here and covered by the upgrade pre-check
(`validate_ttl_fields_pre_upgrade`, issue #1082).
