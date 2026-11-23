import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../src/db/schema.js';
import { initializeSchema as initializeSchemaViaLegacyPath } from '../src/database/schema.js';
import { createSqlEventRepository, type IngestedEventRecord } from '../src/db/eventRepository.js';
import {
  checkSchemaIntegrity,
  findSchemaDrift,
  isIntegral,
} from '../src/db/integrityCheck.js';
import { createTestDb, seedInvoice } from './helpers.js';

/**
 * Pins the persisted-schema behaviour documented in
 * docs/indexer-schema-constraints-audit.md: what the schema enforces, what it
 * deliberately does not, and how the read-only integrity check reports the gap.
 */

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

function insertRawEvent(
  overrides: Partial<{
    invoice_id: number | null;
    transaction_hash: string | null;
    event_index: number | null;
    ledger: number;
  }> = {}
): void {
  const row = {
    invoice_id: null,
    transaction_hash: 'tx-1',
    event_index: 0,
    ledger: 100,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO events (invoice_id, event_type, ledger, timestamp, transaction_hash, event_index)
     VALUES (@invoice_id, 'InvoiceSubmitted', @ledger, 1000, @transaction_hash, @event_index)`
  ).run(row);
}

function ingestedEvent(overrides: Partial<IngestedEventRecord> = {}): IngestedEventRecord {
  return {
    invoice_id: null,
    event_type: 'submitted',
    ledger: 100,
    timestamp: 1000,
    data: '{}',
    contract_id: 'CCONTRACT',
    contract_event_type: 'InvoiceSubmitted',
    transaction_hash: 'tx-1',
    transaction_paging_token: '100',
    event_index: 0,
    topics_json: '[]',
    ...overrides,
  };
}

const countRows = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('foreign keys', () => {
  it('rejects an event that references a missing invoice (enforced when foreign_keys=ON)', () => {
    expect(() => insertRawEvent({ invoice_id: 999 })).toThrow(/FOREIGN KEY constraint failed/);
    expect(countRows('events')).toBe(0);
  });

  it('accepts an event for an existing invoice and an event with no invoice', () => {
    seedInvoice(db, { id: 7 });
    insertRawEvent({ invoice_id: 7, transaction_hash: 'tx-a' });
    insertRawEvent({ invoice_id: null, transaction_hash: 'tx-b' });
    expect(countRows('events')).toBe(2);
  });

  it('refuses to delete an invoice that events still reference', () => {
    seedInvoice(db, { id: 7 });
    insertRawEvent({ invoice_id: 7 });
    expect(() => db.prepare('DELETE FROM invoices WHERE id = 7').run()).toThrow(
      /FOREIGN KEY constraint failed/
    );
  });

  it('does not constrain insurance_pool_claims.invoice_id (claims may precede/ignore the invoice row)', () => {
    db.prepare(
      `INSERT INTO insurance_pool_claims
         (invoice_id, lp_address, contract_id, payout_amount, claimed_at, ledger, transaction_hash, event_index)
       VALUES (404, 'GLP', 'CPOOL', '10', 1, 1, 'tx-c', 0)`
    ).run();
    expect(countRows('insurance_pool_claims')).toBe(1);
    expect(checkSchemaIntegrity(db)).toEqual([]);
  });

  it('is reported by the integrity check when rows were written with foreign_keys=OFF', () => {
    db.pragma('foreign_keys = OFF');
    insertRawEvent({ invoice_id: 999 });
    const violations = checkSchemaIntegrity(db);
    expect(violations).toContainEqual(
      expect.objectContaining({ check: 'foreign_key_violation', table: 'events', count: 1, severity: 'error' })
    );
    expect(isIntegral(violations)).toBe(false);
  });
});

describe('uniqueness and idempotent writes', () => {
  it('rejects a duplicate (transaction_hash, event_index) on a raw insert', () => {
    insertRawEvent();
    expect(() => insertRawEvent()).toThrow(/UNIQUE constraint failed: events.transaction_hash, events.event_index/);
  });

  it('makes repository.insertEvent idempotent for a replayed event', () => {
    const repo = createSqlEventRepository(db);
    repo.insertEvent(ingestedEvent());
    repo.insertEvent(ingestedEvent());
    repo.insertEvent(ingestedEvent({ event_index: 1 }));
    expect(countRows('events')).toBe(2);
  });

  it('does NOT deduplicate rows whose hash or index is NULL (SQLite treats NULLs as distinct)', () => {
    const repo = createSqlEventRepository(db);
    repo.insertEvent(ingestedEvent({ transaction_hash: null, event_index: null }));
    repo.insertEvent(ingestedEvent({ transaction_hash: null, event_index: null }));
    expect(countRows('events')).toBe(2);
    expect(checkSchemaIntegrity(db)).toContainEqual(
      expect.objectContaining({ check: 'undeduplicated_rows', table: 'events', count: 2, severity: 'warning' })
    );
  });

  it('deduplicates reputation updates and insurance rows on replay', () => {
    const repo = createSqlEventRepository(db);
    const reputation = {
      address: 'GFL', event_type: 'reputation_updated', old_score: 0, new_score: 10,
      invoices_submitted: 1, invoices_paid: 0, invoices_defaulted: 0, ledger: 100, timestamp: 1000,
      contract_id: 'C', transaction_hash: 'tx-r', transaction_paging_token: '100', event_index: 0, topics_json: '[]',
    };
    repo.insertReputationUpdate(reputation);
    repo.insertReputationUpdate(reputation);
    expect(countRows('reputation_updates')).toBe(1);

    const base = { lp_address: 'GLP', contract_id: 'CPOOL', ledger: 100, transaction_hash: 'tx-i', event_index: 0 };
    repo.insertInsuranceEnrollment({ ...base, enrolled_at: 1 });
    repo.insertInsuranceEnrollment({ ...base, enrolled_at: 1 });
    repo.insertInsurancePremium({ ...base, amount: '5', premium_at: 1 });
    repo.insertInsurancePremium({ ...base, amount: '5', premium_at: 1 });
    repo.insertInsuranceClaim({ ...base, invoice_id: 1, payout_amount: '9', claimed_at: 1 });
    repo.insertInsuranceClaim({ ...base, invoice_id: 1, payout_amount: '9', claimed_at: 1 });
    expect(countRows('insurance_pool_enrollments')).toBe(1);
    expect(countRows('insurance_pool_premiums')).toBe(1);
    expect(countRows('insurance_pool_claims')).toBe(1);
  });

  it('keeps one row per insurance pool contract and per indexer state key', () => {
    const repo = createSqlEventRepository(db);
    repo.upsertInsurancePoolStats('CPOOL', '100', '10', '0', 1);
    repo.upsertInsurancePoolStats('CPOOL', '120', '12', '0', 2);
    expect(countRows('insurance_pool_stats')).toBe(1);
    expect(repo.getInsurancePoolStats('CPOOL')?.pool_balance).toBe('120');

    repo.setState('last_processed_ledger', '1');
    repo.setState('last_processed_ledger', '2');
    expect(countRows('indexer_state')).toBe(1);
    expect(repo.getState('last_processed_ledger')).toBe('2');
  });

  it('upserts an invoice by id instead of duplicating it, and rejects a second raw insert', () => {
    const repo = createSqlEventRepository(db);
    seedInvoice(db, { id: 3, status: 'Pending' });
    const row = repo.getInvoice(3)!;
    repo.upsertInvoice({ ...row, status: 'Funded' });
    expect(countRows('invoices')).toBe(1);
    expect(repo.getInvoice(3)?.status).toBe('Funded');
    expect(() => seedInvoice(db, { id: 3 })).toThrow(/UNIQUE constraint failed: invoices.id/);
  });

  it('allows one header per ledger sequence', () => {
    db.prepare(`INSERT INTO ledger_headers (sequence, hash, parent_hash, ingested_at) VALUES (1, 'h', 'p', 1)`).run();
    expect(() =>
      db.prepare(`INSERT INTO ledger_headers (sequence, hash, parent_hash, ingested_at) VALUES (1, 'h2', 'p', 1)`).run()
    ).toThrow(/UNIQUE constraint failed: ledger_headers.sequence/);
  });
});

describe('accounting fields: what the schema does not enforce', () => {
  // These tests document a deliberate gap: amounts are TEXT and numeric columns
  // have no CHECK, so the database itself accepts values the contract can never
  // produce. checkSchemaIntegrity() is the detection path. If a future change
  // adds constraints, update these expectations and the audit doc together.
  it('stores a negative, decimal or non-numeric amount without complaint', () => {
    seedInvoice(db, { id: 1, amount: '-5' });
    seedInvoice(db, { id: 2, amount: '1.5' });
    seedInvoice(db, { id: 3, amount: 'abc', amount_funded: '', amount_paid: '1e3' });
    expect(countRows('invoices')).toBe(3);

    const invalid = checkSchemaIntegrity(db).filter((v) => v.check === 'invalid_amount');
    expect(invalid).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'invoices', column: 'amount', count: 3 }),
        expect.objectContaining({ table: 'invoices', column: 'amount_funded', count: 1 }),
        expect.objectContaining({ table: 'invoices', column: 'amount_paid', count: 1 }),
      ])
    );
  });

  it('stores negative rates, timestamps, ledgers and counters, and id 0', () => {
    seedInvoice(db, { id: 0, discount_rate: -1, due_date: -1 });
    insertRawEvent({ ledger: -5 });
    db.prepare(
      `INSERT INTO reputation_updates (address, ledger, timestamp, invoices_paid) VALUES ('G', 1, 1, -2)`
    ).run();

    const violations = checkSchemaIntegrity(db);
    const negatives = violations.filter((v) => v.check === 'negative_value').map((v) => `${v.table}.${v.column}`);
    expect(negatives).toEqual(
      expect.arrayContaining([
        'invoices.discount_rate',
        'invoices.due_date',
        'events.ledger',
        'reputation_updates.invoices_paid',
      ])
    );
    expect(violations).toContainEqual(expect.objectContaining({ check: 'non_positive_invoice_id', count: 1 }));
  });

  it('accepts amounts larger than 2^63 as exact digit strings (no REAL/INTEGER coercion)', () => {
    const huge = '170141183460469231731687303715884105727'; // i128::MAX
    seedInvoice(db, { id: 1, amount: huge, amount_funded: huge });
    const row = db.prepare('SELECT amount, amount_funded, typeof(amount) AS t FROM invoices WHERE id = 1').get() as {
      amount: string; amount_funded: string; t: string;
    };
    expect(row).toEqual({ amount: huge, amount_funded: huge, t: 'text' });
    expect(checkSchemaIntegrity(db)).toEqual([]);
  });
});

describe('integrity check on valid data', () => {
  it('reports nothing for a database populated through the repository', () => {
    const repo = createSqlEventRepository(db);
    seedInvoice(db, { id: 1 });
    repo.insertEvent(ingestedEvent({ invoice_id: 1 }));
    repo.upsertInsurancePoolStats('CPOOL', '1', '2', '3', 4);
    expect(checkSchemaIntegrity(db)).toEqual([]);
    expect(findSchemaDrift(db)).toEqual([]);
  });
});

describe('schema drift and initializeSchema', () => {
  /** An events/reputation shape from before ingestion metadata columns existed. */
  function createLegacyDatabase(): Database.Database {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE invoices (
        id INTEGER PRIMARY KEY, freelancer TEXT NOT NULL, payer TEXT NOT NULL, token TEXT NOT NULL,
        amount TEXT NOT NULL, due_date INTEGER NOT NULL, discount_rate INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'Pending', funder TEXT, funded_at INTEGER,
        amount_funded TEXT NOT NULL DEFAULT '0', amount_paid TEXT NOT NULL DEFAULT '0',
        referral_code TEXT, submitter_reputation INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL, event_type TEXT NOT NULL,
        ledger INTEGER NOT NULL, timestamp INTEGER NOT NULL, data TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (invoice_id) REFERENCES invoices(id)
      );
      CREATE TABLE reputation_updates (
        id INTEGER PRIMARY KEY, address TEXT NOT NULL, event_type TEXT NOT NULL DEFAULT 'reputation_updated',
        old_score INTEGER NOT NULL DEFAULT 0, new_score INTEGER NOT NULL DEFAULT 0,
        invoices_submitted INTEGER NOT NULL DEFAULT 0, invoices_paid INTEGER NOT NULL DEFAULT 0,
        invoices_defaulted INTEGER NOT NULL DEFAULT 0, ledger INTEGER NOT NULL, timestamp INTEGER NOT NULL
      );
    `);
    return legacy;
  }

  it('is idempotent on a populated, current database (data survives a second init)', () => {
    seedInvoice(db, { id: 1 });
    initializeSchema(db);
    initializeSchema(db);
    expect(countRows('invoices')).toBe(1);
    expect(findSchemaDrift(db)).toEqual([]);
  });

  it('keeps the old src/database/schema.js import path pointing at the same schema', () => {
    const viaOldPath = new Database(':memory:');
    try {
      initializeSchemaViaLegacyPath(viaOldPath);
      expect(findSchemaDrift(viaOldPath)).toEqual([]);
    } finally {
      viaOldPath.close();
    }
  });

  it('cannot upgrade an older database: init throws on a missing column and is not atomic', () => {
    const legacy = createLegacyDatabase();
    try {
      expect(() => initializeSchema(legacy)).toThrow(/no such column/);
      // CREATE TABLE IF NOT EXISTS left the old tables unchanged...
      const eventColumns = (legacy.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map(
        (c) => c.name
      );
      expect(eventColumns).not.toContain('transaction_hash');
      // ...while statements before the failing index were already committed.
      const tables = (
        legacy.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
      ).map((t) => t.name);
      expect(tables).toContain('indexer_state');
    } finally {
      legacy.close();
    }
  });

  it('reports exactly what an older database is missing, before anything is run against it', () => {
    const legacy = createLegacyDatabase();
    try {
      const drift = findSchemaDrift(legacy);
      expect(drift).toContainEqual(
        expect.objectContaining({ check: 'missing_column', table: 'events', column: 'transaction_hash' })
      );
      expect(drift).toContainEqual(
        expect.objectContaining({ check: 'missing_column', table: 'reputation_updates', column: 'event_index' })
      );
      expect(drift).toContainEqual(expect.objectContaining({ check: 'missing_table', table: 'insurance_pool_claims' }));
      expect(isIntegral(drift)).toBe(false);
    } finally {
      legacy.close();
    }
  });

  it('tolerates extra columns from a newer schema but flags changed column types as warnings', () => {
    db.exec('ALTER TABLE invoices ADD COLUMN future_field TEXT');
    expect(findSchemaDrift(db)).toEqual([]);

    const other = new Database(':memory:');
    try {
      other.exec(`CREATE TABLE indexer_state (state_key TEXT PRIMARY KEY, state_value INTEGER NOT NULL)`);
      const drift = findSchemaDrift(other).filter((v) => v.table === 'indexer_state');
      expect(drift).toEqual([
        expect.objectContaining({ check: 'column_type_mismatch', column: 'state_value', severity: 'warning' }),
      ]);
    } finally {
      other.close();
    }
  });
});
