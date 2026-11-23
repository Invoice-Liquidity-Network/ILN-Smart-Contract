# Indexer database schema: constraint audit

Scope: [`indexer/src/db/schema.ts`](../indexer/src/db/schema.ts), the writes in
[`indexer/src/db/eventRepository.ts`](../indexer/src/db/eventRepository.ts) and the event normalisation in
[`indexer/src/ingestion/eventListener.ts`](../indexer/src/ingestion/eventListener.ts).
Tests: [`indexer/tests/schemaConstraints.test.ts`](../indexer/tests/schemaConstraints.test.ts).
Tooling: [`indexer/src/db/integrityCheck.ts`](../indexer/src/db/integrityCheck.ts) (read-only).

## Data source and assumptions

- The live database is SQLite (`better-sqlite3`), created by `initializeSchema`. `getDb()` and the test helper turn on
  `PRAGMA foreign_keys = ON`. SQLite itself leaves it off by default, so a connection that does not set it enforces no foreign keys.
- Rows come from Horizon transactions decoded into contract events. Persistence errors propagate: the transaction for a record
  and its cursor commit together, and on failure the stream reconnects from the last committed cursor.
  A constraint violation therefore stops ingestion at that record. It does not silently skip it.
- Amounts (`i128` on chain) are stored as base-10 TEXT so that no value is rounded.
- There is no authorization layer in the database. Authorization is enforced by the contract and by the API in front of this file.

## What the schema enforces

| Constraint | Where | Effect |
| --- | --- | --- |
| `events.invoice_id -> invoices(id)` | `events` | An event for an unknown invoice is rejected. `NULL` is allowed, and deleting a referenced invoice is refused. |
| `UNIQUE(transaction_hash, event_index)` | `events`, `reputation_updates` | A replayed event is a no-op because the repository uses `ON CONFLICT DO NOTHING`. |
| `UNIQUE(lp_address, contract_id, transaction_hash, event_index)` | enrollments, premiums | Replay-safe inserts. |
| `UNIQUE(invoice_id, contract_id, transaction_hash, event_index)` | claims | Replay-safe inserts. |
| `contract_id UNIQUE` | `insurance_pool_stats` | One stats row per pool, updated by upsert. |
| Primary keys | `invoices.id`, `indexer_state.state_key`, `ledger_headers.sequence` | One row per invoice, state key and ledger. |
| `NOT NULL` + defaults | most columns | Missing fields cannot leave `NULL` amounts or counters. |

## Findings

Each finding below was verified (by running the SQL in SQLite or by reading the code path) unless it is marked as residual.

1. **A second, broken copy of the schema existed.** `src/database/schema.ts` had its own DDL. Its index list referenced
   `events.contract_event_type`, a column its own `events` table lacks, so `initializeSchema` from that path threw on first use.
   The file now re-exports `src/db/schema.ts`. Only `tests/monitoring.test.ts` imported it.
2. **Accounting fields are not constrained.** The schema accepts a negative, decimal, empty or non-numeric `amount`,
   `amount_funded` and `amount_paid` (and the insurance equivalents), negative `discount_rate`, `due_date`, ledger and counter values,
   and `invoices.id = 0`. Normalisation falls back to `0` when a payload has no `invoice_id`, so id 0 is reachable.
   The contract never produces any of these values.
   `checkSchemaIntegrity()` now detects them, and the tests pin the current behaviour.
3. **`UNIQUE(transaction_hash, event_index)` does not deduplicate rows where either column is `NULL`.** SQLite treats `NULL`s as distinct.
   The live ingestion path always sets both, so this affects only legacy and fixture rows. It is reported as a warning.
4. **`initializeSchema` is not a migration.** It uses `CREATE TABLE IF NOT EXISTS`, so it never adds a column to an existing table.
   On a database from before the ingestion columns it throws `no such column` at the first index that needs one.
   It is also not atomic: statements that ran before the failure stay applied, so the database is left half-initialised.
   `findSchemaDrift()` reports the missing tables and columns before anything is run.
5. **`indexer/migrations/` does not describe this schema.** It holds Postgres `node-pg-migrate` files for a different table shape
   (`reputation`, `events.topics text[]`, no `token` or `funder` columns). Nothing in `package.json` runs them.
   `1719582000001_add_analytics_indexes.js` also indexes columns and tables the first migration never creates.
   This is handled in the migration-rollback work (issue 4).

## Failure behaviour by case

| Case | Behaviour |
| --- | --- |
| Normal | Parent invoice row is written before the child event row (FK order). All rows and the cursor commit in one transaction. |
| Repeated (replay, overlapping catch-up) | Events, reputation and insurance rows are no-ops on the unique key. Invoices are upserted by id. |
| Unauthorized | Not applicable at this layer. |
| Stale / out of order | An older event for an invoice is stored, then the invoice row is rebuilt from the full event history in chain order. |
| Interrupted | A crash between rows and cursor cannot occur (single transaction). `initializeSchema` on an old database is the exception (finding 4). |
| Invalid data | **Amount and counter columns:** accepted (finding 2). **Orphan event:** the write fails and ingestion stops at that record. |

## Residual risk (not changed here)

- **Enforcement versus availability.** CHECK constraints or triggers on amounts and counters would reject bad rows at write time.
  Under the "persistence errors propagate" rule, one malformed event would also stall ingestion indefinitely.
  This change adds detection and no enforcement. Enforcement needs a decision on quarantine or skip behaviour first.
- **Orphan events can stall ingestion (by code reading, not reproduced end to end).** With no stored cursor the stream starts at `now`.
  Events that do not create an invoice row (the `default` branch of `normalizeProcessedEvent`, and `InsurancePoolClaimed` with an invoice id)
  but carry an `invoice_id` for an invoice the indexer never saw would fail the foreign key.
- **`InvoicePaid` normalisation prefers `amount_paid` over the face amount** when it sets `invoices.amount`, and writes
  `lp_payout` into `amount_funded`. These are equal to the original values only when the invoice is paid in full.
  This is an ingestion-semantics question, not a schema one, and is worth a separate review.
- **Analytics cast amounts to `REAL`** in places (for example `CAST(amount AS REAL)` in the analytics queries). Values above 2^53 lose precision.
- **`insurance_pool_claims.invoice_id` has no foreign key.** This is intentional, since a claim may reference an invoice the indexer did not ingest.
  Claims for unknown invoices are therefore not detected.
