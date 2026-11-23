# Event Topic & Payload Stability Audit

Scope: `contracts/invoice_liquidity/src/events.rs` and every `env.events().publish(..)`
site in the `invoice_liquidity` crate (`lib.rs`, `oracle_registry.rs`, `nft.rs`,
`token_safety.rs`, `config.rs`, `invoice.rs`).

Regression guard: `contracts/invoice_liquidity/src/tests_event_topics.rs`. It scans
the sources (no scenario setup) and fails when a topic, its payload type, a
publish-site count or a lifecycle field list changes. Companion docs:
[`events.md`](./events.md) (per-event field reference and the mutator coverage
matrix) and [`event-types.md`](./event-types.md).

## Data sources and assumptions

* The registry below is derived from the publish sites in the source, not from
  documentation. Every publish site uses `Symbol::new(env, "<topic>")` as topic 0.
* "Observable" means visible to an off-chain consumer reading ledger events. Soroban
  discards the events (and storage writes) of an invocation that returns `Err`, so
  only events from *successful* invocations are observable.
* Ledger sequence and close time of an event come from the event envelope
  (RPC `getEvents`), not from the payload. Payload `timestamp`-style fields are a
  convenience that reflects `env.ledger().timestamp()` at emission.
* Authorization is decided by the emitting entrypoint, not by the event. Events
  carry the acting party (`updated_by`, `funder`, `payer`, ...) where the entrypoint
  has one; permissionless entrypoints (`expire_invoice`, `recover_fund_queue`,
  `auto_resolve_dispute`, `resolve_fund_queue`, `check_oracle_*`) carry none.

## Verified: topic → payload registry

A topic symbol identifies exactly one payload type and each typed payload is
published under exactly one topic (enforced by
`a_topic_never_carries_two_payload_types` and
`a_typed_payload_is_never_published_under_two_topics`). Topics with more than one
publish site are deliberate fan-in with an identical payload type:

| Topic (`topic[0]`) | Payload | Sites | Emitting entrypoints |
| --- | --- | --- | --- |
| `parameter_updated` | `ParameterUpdated` | 12 | `update_fee_rate`, `update_max_discount`, `set_max_oracle_age`, `set_min_payer_reputation`, `set_max_invoice_amount`, `set_token_volume_cap`, `update_decay_params` (×2), `update_config`, `set_identity_quorum`, `execute_proposal` (fee / max-discount ×2) — discriminated by the payload's `param_name`, **not** by the topic |
| `queue_resolve_attempt` | `FundQueueResolutionAttempted` | 3 | `resolve_fund_queue` (archived, not-mature, success) |
| `submitted` | `InvoiceSubmitted` | 2 | `submit_invoice`, `submit_invoices_batch` (one per invoice) |
| `expired` | `InvoiceExpired` | 2 | `expire_invoice`, inline expiry in `fund_invoice` |
| `dispute_resolved` | `DisputeResolved` | 2 | `resolve_dispute`, `auto_resolve_dispute` |
| `paused` / `unpaused` | `ContractPaused` / `ContractUnpaused` | 2 each | `pause`/`unpause`, `execute_proposal` |
| `token_removed` | `TokenRemoved` | 2 | `remove_token`, `execute_proposal` |
| `fund_queue_recovered` | `FundQueueRecovered` | 2 | `recover_fund_queue` (purge, reopen) |
| `oracle_registered` / `oracle_removed` | `OracleRegistered` / `OracleUnregistered` | 2 each | default-feed and per-token variants (`token: Option<Address>` discriminates) |

Every other topic has a single publish site. The full pinned table is
`EXPECTED_PUBLISH_SITES` in `tests_event_topics.rs`.

Note the topic and struct names differ in a few places; indexers must key on the
**topic**: `oracle_removed` → `OracleUnregistered`, `queue_resolve_attempt` →
`FundQueueResolutionAttempted`, `fund_queue_displaced` → `FundQueueEntryDisplaced`,
`token_changed` → `InvoiceTokenChanged`, `rollback_rehearsal` →
`RollbackRehearsalCompleted`, `initialized` → `ContractInitialized`.

## Verified: ledger fields on lifecycle payloads

`lifecycle_payload_fields_are_stable_and_carry_invoice_id` pins the sorted field
list of 22 invoice-scoped payloads and asserts each one keeps `invoice_id`. The
money-moving events carry the full accounting picture:

| Event | Ledger fields carried |
| --- | --- |
| `InvoiceSubmitted` | parties, token, `amount`, `due_date`, `discount_rate`, `referral_code`, `status`, `timestamp` |
| `InvoiceFunded` | `funder`/`lp`, `fund_amount` (this contribution), `amount_funded` (running total), `invoice_amount`, `funded_at`, `effective_yield_bps`, `status`, `timestamp` |
| `InvoicePartiallyPaid` | `amount_paid_now`, `total_amount_paid`, `remaining_amount` |
| `InvoicePaid` | `amount_paid`, `lp_earned`, `lp_payout`, `settlement_timestamp`, `paid_on_time`, `status` |
| `InvoiceDefaulted` | `funder`, `amount`, `discount_amount`, `defaulted_at`, `status` |
| `PayoutEscrowed` | `recipient`, `token`, `amount`, `total_pending` |

## Findings

### F1 — Declared but never published (verified)

Six structs in `events.rs` are never constructed by any code path, so they are
dead schema that consumers must not wait for. They are pinned in
`EXPECTED_UNPUBLISHED`; wiring one up (or deleting it) must update that list.

| Struct | Why it is never emitted |
| --- | --- |
| `EvidenceSubmitted`, `EvidenceVerified`, `EvidenceRejected` | The entrypoints that would emit them (`attach_invoice_evidence`, `verify_invoice_evidence`) do not exist in `lib.rs`; only storage helpers do. `tests_evidence_lifecycle.rs` is not registered as a module, so it neither compiles nor runs. |
| `EqualScoreManipulationSimulated`, `QueueTieScoreMarginUpdated` | `simulate_equal_score_attack` / `set_queue_tie_score_margin` are not contract entrypoints; the margin setter exists only as an internal helper in `storage.rs` / `invoice.rs`. |
| `InsuranceCompensationFailed` | `claim_default` reports a failed or skipped pool claim through `InsuranceClaimAttempted { compensated: false, payout: 0 }`; no separate failure event is published. |

Observable impact: none today (nothing is emitted). Risk: a consumer or SDK that
subscribes to these topics will wait forever. Decision left to maintainers; this
audit does not add entrypoints.

### F2 — Two events use untyped positional payloads (verified)

* `migrated`: payload is the tuple `(from_version: u32, to_version: u32, timestamp: u64)`.
* `fee_tiers_updated` (`topic[1]` = admin): payload is only `tiers.len()` (`u32`).
  **The tier brackets/rates themselves are not in the event**, so an indexer cannot
  reconstruct the fee schedule history from events alone; it must read
  `get_fee_tiers()` at each ledger.

These are pinned as `(untyped)` in the registry. Changing them to named structs
would break existing decoders, so it is recorded here rather than changed.

### F3 — Rejection events are discarded with the failed call (verified)

`resolve_fund_queue` publishes `queue_resolve_attempt` with `success = false`
immediately before returning `Err(QueueStateArchived)` / `Err(QueueNotMature)`, and
`fund_invoice` publishes `expired` (after writing `Expired`) before returning
`Err(InvoiceExpired)`. Because the invocation fails, Soroban discards those events
and the status write. Consequences:

* `FundQueueResolutionAttempted.success == false` is **never observable** on
  mainnet; only `success == true` events exist. Do not build MEV-probing alerts on
  the failure variant. (Failed attempts are visible only as failed transactions.)
* The inline expiry in `fund_invoice` does not persist `Expired`; the invoice is
  expired for real only by a later successful `expire_invoice`. This matches the
  lifecycle invariant NE-4 in `invoice-lifecycle-invariants.md`.

### F4 — `FundQueueResolutionAttempted.caller_ledger` is not a caller (verified, doc fixed)

The field holds the ledger sequence at which the queue was opened (`0` if that
record was missing), not an address. The rustdoc previously said "Caller that
triggered the resolution attempt". The doc comment was corrected in this audit;
the field name is unchanged for wire compatibility.

### F5 — Several lifecycle payloads have no timestamp (verified, residual risk)

`InvoiceUpdated`, `InvoiceTransferred`, `InvoiceCancelled`, `InvoiceExpired`,
`LPPositionTransferred`, `InvoiceTokenChanged`, `InvoicePartiallyPaid`,
`FundRequested`, `FundQueueResolved` carry no timestamp. This is not a data-loss
bug — the event envelope carries ledger sequence and close time — but a consumer
that stores only decoded payloads loses *when*. Adding fields is a breaking change
for strict decoders, so it is deliberately not done here.

### F6 — `set_identity_quorum` mutated state silently (verified, fixed)

`set_identity_quorum` (admin-only, rate-limited) wrote `DataKey::IdentityQuorum`
without publishing anything, and `scripts/check-event-coverage.ts --check` was
failing on it. The quorum decides how many Identity oracles must agree before
oracle-gated funding proceeds, so a silent change is an audit gap. It now emits
`parameter_updated` with `param_name = "identity_quorum"`, `old_value` (the previous
or default quorum), `new_value` and `updated_by`, following the shape of the other
governance parameters. This is additive: no existing topic or payload changed.

## Behaviour matrix

| Case | Event behaviour |
| --- | --- |
| Normal | Exactly the topic/payload in the registry, once per state change (`submitted` once per invoice in a batch). |
| Repeated call | An idempotent no-op state transition that returns `Err` (e.g. second `cancel_invoice`, second `dispute_invoice`) emits nothing; a successful repeat emits again with new values (e.g. `parameter_updated` after cooldown). |
| Unauthorized | `require_auth` / admin-gate failure aborts before any publish; no event. |
| Stale / expired | `Err(InvoiceExpired)`, `Err(OracleDataStale)` etc. discard events (F3). The one exception is `check_oracle_verification`, which returns `Ok` and therefore *keeps* `oracle_stale_data_rejected`. |
| Interrupted (failed transfer, trapped call) | Whole invocation rolls back: no event, no storage change (see `failed-transfer-rollback.md`). |

## Residual risks (not changed)

1. F1–F5 above — each needs a maintainer decision because the fix changes an
   external schema or adds entrypoints.
2. The scanner in `tests_event_topics.rs` is textual: it reads the topic literal
   and the first struct literal after `.publish(` within a 700-byte window. A
   publish site that builds its payload in a variable or uses a non-literal topic
   will make the test panic or report `(untyped)`, which forces a human review —
   the safe failure mode.
3. Cross-contract events (`iln_governance`, `iln_distribution`, `insurance_pool`,
   `reputation_bonus`) are out of scope; see `events.md`.
