import Database from 'better-sqlite3';
import { initializeSchema } from './schema.js';

/**
 * Read-only verification of an indexer database against the invariants the
 * ingestion pipeline relies on. It never writes and never throws on bad data:
 * every problem is reported as a violation so callers (restore verification,
 * migration pre-flight, operators) can decide how to fail.
 *
 * Why this exists: `initializeSchema` uses `CREATE TABLE IF NOT EXISTS`, so it
 * can neither upgrade an older database nor reject incompatible rows, and the
 * schema stores accounting amounts as TEXT with no CHECK constraints (see
 * docs/indexer-schema-constraints-audit.md). These checks make those
 * properties observable without changing ingestion behaviour.
 */

export type ViolationSeverity = 'error' | 'warning';

export interface IntegrityViolation {
  check: string;
  severity: ViolationSeverity;
  table: string;
  column?: string;
  count: number;
  detail: string;
}

/** Columns that hold token amounts as base-10 TEXT (i128 values, never decimals). */
export const AMOUNT_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ['invoices', 'amount'],
  ['invoices', 'amount_funded'],
  ['invoices', 'amount_paid'],
  ['insurance_pool_premiums', 'amount'],
  ['insurance_pool_claims', 'payout_amount'],
  ['insurance_pool_stats', 'pool_balance'],
  ['insurance_pool_stats', 'total_premiums_collected'],
  ['insurance_pool_stats', 'total_claims_paid'],
  ['stats_history', 'total_volume'],
];

/** INTEGER columns that must never be negative (ledgers, timestamps, rates, counters). */
export const NON_NEGATIVE_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ['invoices', 'due_date'],
  ['invoices', 'discount_rate'],
  ['invoices', 'created_at'],
  ['invoices', 'submitter_reputation'],
  ['events', 'ledger'],
  ['events', 'timestamp'],
  ['events', 'event_index'],
  ['reputation_updates', 'ledger'],
  ['reputation_updates', 'timestamp'],
  ['reputation_updates', 'event_index'],
  ['reputation_updates', 'invoices_submitted'],
  ['reputation_updates', 'invoices_paid'],
  ['reputation_updates', 'invoices_defaulted'],
  ['insurance_pool_enrollments', 'ledger'],
  ['insurance_pool_enrollments', 'event_index'],
  ['insurance_pool_premiums', 'ledger'],
  ['insurance_pool_premiums', 'event_index'],
  ['insurance_pool_claims', 'ledger'],
  ['insurance_pool_claims', 'event_index'],
  ['insurance_pool_stats', 'enrolled_lp_count'],
  ['insurance_pool_stats', 'total_enrollment_events'],
  ['stats_snapshots', 'total_invoices'],
  ['stats_snapshots', 'total_funded'],
  ['stats_snapshots', 'total_paid'],
  ['stats_snapshots', 'total_cancelled'],
  ['stats_snapshots', 'total_expired'],
  ['stats_snapshots', 'total_disputed'],
  ['ledger_headers', 'sequence'],
];

/** Tables whose `UNIQUE(transaction_hash, event_index)` only deduplicates when both are non-NULL. */
const DEDUPE_KEYED_TABLES = ['events', 'reputation_updates'] as const;

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function tableColumns(db: Database.Database, table: string): Map<string, string> {
  const rows = db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<{
    name: string;
    type: string;
  }>;
  return new Map(rows.map((row) => [row.name, row.type.toUpperCase()]));
}

/**
 * Compare a database's tables and columns against what `initializeSchema`
 * creates today. Missing tables/columns are errors: `CREATE TABLE IF NOT
 * EXISTS` will not add them, so queries against them fail at runtime. Extra
 * columns are tolerated (forward-compatible restores).
 */
export function findSchemaDrift(db: Database.Database): IntegrityViolation[] {
  const reference = new Database(':memory:');
  try {
    initializeSchema(reference);
    const tables = (
      reference
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
        .all() as Array<{ name: string }>
    ).map((row) => row.name);

    const violations: IntegrityViolation[] = [];
    for (const table of tables) {
      const expected = tableColumns(reference, table);
      const actual = tableColumns(db, table);
      if (actual.size === 0) {
        violations.push({
          check: 'missing_table',
          severity: 'error',
          table,
          count: 1,
          detail: `table ${table} does not exist`,
        });
        continue;
      }
      for (const [column, type] of expected) {
        const actualType = actual.get(column);
        if (actualType === undefined) {
          violations.push({
            check: 'missing_column',
            severity: 'error',
            table,
            column,
            count: 1,
            detail: `column ${table}.${column} (${type}) does not exist`,
          });
        } else if (actualType !== type) {
          violations.push({
            check: 'column_type_mismatch',
            severity: 'warning',
            table,
            column,
            count: 1,
            detail: `column ${table}.${column} is ${actualType}, expected ${type}`,
          });
        }
      }
    }
    return violations;
  } finally {
    reference.close();
  }
}

/**
 * Scan an indexer database for rows that break the invariants documented in
 * docs/indexer-schema-constraints-audit.md. Checks whose table or column is
 * absent are skipped here (they are reported by {@link findSchemaDrift}).
 */
export function checkSchemaIntegrity(db: Database.Database): IntegrityViolation[] {
  const violations: IntegrityViolation[] = [];
  const hasColumn = (table: string, column: string) => tableColumns(db, table).has(column);

  // 1. Foreign keys, independent of whether PRAGMA foreign_keys was ON when the rows were written.
  const fkRows = db.prepare('PRAGMA foreign_key_check').all() as Array<{
    table: string;
    parent: string;
  }>;
  const fkByTable = new Map<string, { parent: string; count: number }>();
  for (const row of fkRows) {
    const entry = fkByTable.get(row.table) ?? { parent: row.parent, count: 0 };
    entry.count += 1;
    fkByTable.set(row.table, entry);
  }
  for (const [table, { parent, count }] of fkByTable) {
    violations.push({
      check: 'foreign_key_violation',
      severity: 'error',
      table,
      count,
      detail: `${count} row(s) in ${table} reference a missing ${parent} row`,
    });
  }

  // 2. Amounts are base-10 digit strings: no sign, decimals, exponent, whitespace or empty string.
  for (const [table, column] of AMOUNT_COLUMNS) {
    if (!hasColumn(table, column)) continue;
    const col = quote(column);
    const { n } = db
      .prepare(
        `SELECT COUNT(*) AS n FROM ${quote(table)}
          WHERE ${col} IS NULL OR CAST(${col} AS TEXT) = '' OR CAST(${col} AS TEXT) GLOB '*[^0-9]*'`
      )
      .get() as { n: number };
    if (n > 0) {
      violations.push({
        check: 'invalid_amount',
        severity: 'error',
        table,
        column,
        count: n,
        detail: `${n} row(s) hold a ${table}.${column} that is not a non-negative integer string`,
      });
    }
  }

  // 3. Counters, timestamps, ledgers and rates are non-negative integers.
  for (const [table, column] of NON_NEGATIVE_COLUMNS) {
    if (!hasColumn(table, column)) continue;
    const col = quote(column);
    const { n } = db
      .prepare(`SELECT COUNT(*) AS n FROM ${quote(table)} WHERE ${col} < 0`)
      .get() as { n: number };
    if (n > 0) {
      violations.push({
        check: 'negative_value',
        severity: 'error',
        table,
        column,
        count: n,
        detail: `${n} row(s) have a negative ${table}.${column}`,
      });
    }
  }

  // 4. Invoice ids are positive: ingestion falls back to 0 when a payload carries no invoice_id.
  if (hasColumn('invoices', 'id')) {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE id <= 0').get() as { n: number };
    if (n > 0) {
      violations.push({
        check: 'non_positive_invoice_id',
        severity: 'error',
        table: 'invoices',
        column: 'id',
        count: n,
        detail: `${n} invoice row(s) have id <= 0, which the contract never issues`,
      });
    }
  }

  // 5. SQLite treats NULLs as distinct inside UNIQUE, so rows without a hash or index are never deduplicated.
  for (const table of DEDUPE_KEYED_TABLES) {
    if (!hasColumn(table, 'transaction_hash') || !hasColumn(table, 'event_index')) continue;
    const { n } = db
      .prepare(
        `SELECT COUNT(*) AS n FROM ${quote(table)} WHERE transaction_hash IS NULL OR event_index IS NULL`
      )
      .get() as { n: number };
    if (n > 0) {
      violations.push({
        check: 'undeduplicated_rows',
        severity: 'warning',
        table,
        count: n,
        detail: `${n} row(s) in ${table} lack transaction_hash or event_index, so UNIQUE(transaction_hash, event_index) cannot dedupe them (legacy rows)`,
      });
    }
  }

  return violations;
}

/** True when no `error`-severity violation was found. */
export function isIntegral(violations: IntegrityViolation[]): boolean {
  return violations.every((violation) => violation.severity !== 'error');
}
