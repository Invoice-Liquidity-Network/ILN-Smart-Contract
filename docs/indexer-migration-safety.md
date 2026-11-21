# Indexer migrations, rollback and restore: failure safety

Scope: [`indexer/migrations/`](../indexer/migrations) (notably `1719582000001_add_analytics_indexes.js`),
`initializeSchema`, and the backup/restore scripts in [`indexer/scripts/`](../indexer/scripts).
Tests: [`indexer/tests/migrations.test.ts`](../indexer/tests/migrations.test.ts) and
[`indexer/tests/restoreIncompatible.test.ts`](../indexer/tests/restoreIncompatible.test.ts).

## Data sources and assumptions

- **The live database is SQLite**, shaped by `initializeSchema` (`CREATE TABLE/INDEX IF NOT EXISTS`).
  It has no versioned migrations. See [indexer-schema-constraints-audit.md](indexer-schema-constraints-audit.md).
- **`indexer/migrations/*.js` are `node-pg-migrate` (Postgres) files.** Nothing in the indexer runs them: `package.json` has no
  `pg` or `node-pg-migrate` dependency and no migrate script.
  They describe a different table shape from the one the indexer persists. Treat them as an unapplied design.
- Because there is no Postgres in CI, the migration tests run the files against an in-memory model of the operations they use
  ([`indexer/tests/helpers/fakePgm.ts`](../indexer/tests/helpers/fakePgm.ts)).
  The model covers missing table/column/index errors, `ifExists`/`ifNotExists`, default index names, and atomic rollback of a failed
  migration. It does not simulate types, constraints or locking. A real-Postgres run is residual risk.

## Findings

Verified by reading the code and covered by tests:

1. **The migration folder could not be loaded.** The package is `"type": "module"`, so the `.js` migrations, which use `exports.up = ...`,
   would be evaluated as ES modules and throw `exports is not defined`. `migrations/package.json` (`{"type": "commonjs"}`) scopes the folder to CommonJS
   without renaming the files, because the file names are the migration identities.
2. **`add_analytics_indexes` cannot apply on top of `initial_schema`.** It indexes `invoices.token`, `invoices.funder`, `events.event_type`,
   `events.contract_event_type` and a `reputation_updates` table, none of which the initial migration creates. It fails at the second
   statement. Because migrations run in a transaction, the first index is rolled back and nothing is left behind.
   The test pins this so the mismatch is not forgotten. Closing it means designing the Postgres schema, which this change does not do.
3. **The analytics migration was not re-runnable.** `up` aborted if an index already existed, and `down` aborted if one was already gone.
   Both directions now use `ifNotExists` / `ifExists`. Normal behaviour is unchanged. A half-applied or half-removed state is now completed instead of aborting.
4. **Every index the analytics migration intends already exists in the live SQLite schema** (same table and columns). A test checks this so the two do not drift.
5. **Backup could fail or leak files on a non-conforming database.** A database with no `indexer_state` table made `createBackup` throw after
   writing the temporary snapshot, leaving `.tmp-snapshot-*` behind. A non-SQLite source file left the same debris.
   The backup now records an unknown checkpoint when `indexer_state` is absent and removes its temp snapshot, archive and manifest on any failure.
6. **Restore accepted any snapshot that passed `integrity_check` and the manifest row counts.** That includes a snapshot missing columns the
   indexer needs, or holding negative or non-numeric amounts and orphan events, all of which are valid SQLite. Restore now runs the schema-drift and invariant
   checks from `src/db/integrityCheck.ts` before installing.
   Errors refuse the restore and warnings (legacy rows without a dedupe key) are printed. `--allow-incompatible` overrides.
   The checkpoint read also tolerates a missing `indexer_state` table, so the override can complete.

## Failure behaviour by case

| Case | Migration (Postgres, modelled) | Restore (SQLite) |
| --- | --- | --- |
| Normal | `up` creates exactly the six analytics indexes. `down` removes exactly those and restores the prior schema. `up`, `down`, `up` ends in the same state. | Checksum, integrity, row counts and schema checks pass. The file is installed by rename. |
| Repeated | Analytics `up`/`down` are no-ops when already applied or removed. Initial `up` twice fails loudly with `already exists` and changes nothing. | An existing target is refused without `--force-overwrite`. |
| Stale / partial | A half-applied or half-removed analytics state is completed. `down` never drops an index it did not create. | A snapshot older than the current schema is refused, and the missing columns are named. |
| Incompatible | A missing table or column fails the migration, and every earlier statement of it is rolled back. Rolling back after a failed `up` is a no-op. | Missing columns/tables, orphan events and invalid amounts are refused before install. The existing target is untouched, even with `--force-overwrite`. |
| Interrupted / damaged | A migration is atomic: it applies completely or not at all. | A bad checksum, truncated archive, non-SQLite contents or manifest row-count mismatch is refused, the temp file is removed and the target is not created. |
| Unauthorized | Not applicable: there is no authorization layer in the migration or restore scripts. Protect the backup directory and `DB_PATH` with filesystem permissions. | Same. |

## Residual risk

- **Postgres migrations are unapplied and diverge from SQLite.** Either make them the real mechanism (a runner, a versioned baseline, a data migration from SQLite)
  or remove them. Until then, schema changes to the live database ship only through `initializeSchema`, which cannot add columns to an existing table.
  Operators should run `findSchemaDrift` (`src/db/integrityCheck.ts`) before an upgrade.
- **The model is not Postgres.** The tests cannot show lock behaviour, long-running index builds, or `CREATE INDEX CONCURRENTLY` constraints.
  Large `invoices` or `events` tables need a real staging run.
- **`down` for the initial migration drops tables and their data.** It is not data-preserving. Take a backup first.
- **Restore does not check the contract state.** It verifies internal consistency, not that the data matches the chain.
  Use `reconcile` (`scripts/reconcile.ts`) after a restore.
- **`--allow-incompatible` installs a snapshot the indexer may not be able to run.** It is meant for forensics.
