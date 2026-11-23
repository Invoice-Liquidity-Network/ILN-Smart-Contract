import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initializeSchema } from '../src/db/schema.js';
import {
  cloneSchema,
  defaultIndexName,
  describeSchema,
  emptySchema,
  runMigration,
  schemaWith,
  type Migration,
} from './helpers/fakePgm.js';

/**
 * Rollback and failure-safety tests for indexer/migrations/*.js.
 * Migrations are executed against the in-memory model in helpers/fakePgm.ts
 * (no Postgres in CI). See docs/indexer-migration-safety.md for what that does
 * and does not prove.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const require = createRequire(import.meta.url);
const load = (file: string): Migration => require(join(MIGRATIONS_DIR, file)) as Migration;

const INITIAL = '1719582000000_initial_schema.js';
const ANALYTICS = '1719582000001_add_analytics_indexes.js';

/** The six indexes the analytics migration creates, by node-pg-migrate default name. */
const ANALYTICS_INDEXES = [
  defaultIndexName('invoices', 'created_at'),
  defaultIndexName('invoices', 'token'),
  defaultIndexName('invoices', 'funder'),
  defaultIndexName('events', 'event_type'),
  defaultIndexName('events', 'contract_event_type'),
  defaultIndexName('reputation_updates', ['address', 'id']),
].sort();

/** Tables/columns the analytics migration needs (what the live indexer read model has). */
const READ_MODEL = {
  invoices: ['id', 'created_at', 'token', 'funder', 'status'],
  events: ['id', 'event_type', 'contract_event_type', 'ledger'],
  reputation_updates: ['id', 'address', 'new_score'],
};

describe('migration files', () => {
  it('load as CommonJS and export up/down (migrations/package.json scopes the folder out of "type": "module")', () => {
    for (const file of [INITIAL, ANALYTICS]) {
      const migration = load(file);
      expect(typeof migration.up, file).toBe('function');
      expect(typeof migration.down, file).toBe('function');
    }
  });

  it('have unique, strictly increasing timestamp prefixes and no unexpected files', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js')).sort();
    expect(files).toEqual([INITIAL, ANALYTICS]);
    const stamps = files.map((f) => Number(f.split('_')[0]));
    expect(stamps.every(Number.isFinite)).toBe(true);
    expect(stamps[1]!).toBeGreaterThan(stamps[0]!);
  });
});

describe('initial schema migration', () => {
  it('up then down returns to an empty database', () => {
    const state = emptySchema();
    runMigration(state, load(INITIAL), 'up');
    expect([...state.tables.keys()].sort()).toEqual(['events', 'invoices', 'reputation']);

    runMigration(state, load(INITIAL), 'down');
    expect(describeSchema(state)).toEqual(describeSchema(emptySchema()));
  });

  it('a repeated up fails loudly and changes nothing', () => {
    const state = emptySchema();
    runMigration(state, load(INITIAL), 'up');
    const before = describeSchema(state);
    expect(() => runMigration(state, load(INITIAL), 'up')).toThrow(/already exists/);
    expect(describeSchema(state)).toEqual(before);
  });

  it('down on an empty database fails loudly and changes nothing', () => {
    const state = emptySchema();
    expect(() => runMigration(state, load(INITIAL), 'down')).toThrow(/does not exist/);
    expect(describeSchema(state)).toEqual(describeSchema(emptySchema()));
  });
});

describe('analytics indexes migration', () => {
  it('up creates exactly the six indexes and down removes exactly those, restoring the prior schema', () => {
    const state = schemaWith(READ_MODEL);
    const before = describeSchema(state);

    runMigration(state, load(ANALYTICS), 'up');
    expect([...state.indexes.keys()].sort()).toEqual(ANALYTICS_INDEXES);

    runMigration(state, load(ANALYTICS), 'down');
    expect(describeSchema(state)).toEqual(before);
  });

  it('can be re-applied after a rollback (up, down, up)', () => {
    const state = schemaWith(READ_MODEL);
    runMigration(state, load(ANALYTICS), 'up');
    const applied = describeSchema(state);
    runMigration(state, load(ANALYTICS), 'down');
    runMigration(state, load(ANALYTICS), 'up');
    expect(describeSchema(state)).toEqual(applied);
  });

  it('is idempotent: a repeated up and a repeated down are no-ops, not errors', () => {
    const state = schemaWith(READ_MODEL);
    runMigration(state, load(ANALYTICS), 'up');
    const applied = describeSchema(state);
    expect(() => runMigration(state, load(ANALYTICS), 'up')).not.toThrow();
    expect(describeSchema(state)).toEqual(applied);

    runMigration(state, load(ANALYTICS), 'down');
    const rolledBack = describeSchema(state);
    expect(() => runMigration(state, load(ANALYTICS), 'down')).not.toThrow();
    expect(describeSchema(state)).toEqual(rolledBack);
  });

  it('down finishes a half-removed state (some indexes already dropped by hand)', () => {
    const state = schemaWith(READ_MODEL);
    runMigration(state, load(ANALYTICS), 'up');
    state.indexes.delete(defaultIndexName('invoices', 'token'));
    state.indexes.delete(defaultIndexName('events', 'event_type'));

    runMigration(state, load(ANALYTICS), 'down');
    expect(state.indexes.size).toBe(0);
  });

  it('up completes a half-applied state (some indexes already present)', () => {
    const state = schemaWith(READ_MODEL);
    state.indexes.set(defaultIndexName('invoices', 'created_at'), { table: 'invoices', columns: ['created_at'] });

    runMigration(state, load(ANALYTICS), 'up');
    expect([...state.indexes.keys()].sort()).toEqual(ANALYTICS_INDEXES);
  });

  it('down never touches indexes it did not create', () => {
    const state = schemaWith(READ_MODEL);
    state.indexes.set('invoices_status_manual', { table: 'invoices', columns: ['status'] });
    runMigration(state, load(ANALYTICS), 'up');
    runMigration(state, load(ANALYTICS), 'down');
    expect([...state.indexes.keys()]).toEqual(['invoices_status_manual']);
  });

  describe('incompatible schema', () => {
    it.each([
      ['a missing table', { invoices: READ_MODEL.invoices, events: READ_MODEL.events }, /relation "reputation_updates" does not exist/],
      [
        'a missing column on a later statement',
        { ...READ_MODEL, events: READ_MODEL.events.filter((c) => c !== 'contract_event_type') },
        /column "contract_event_type" does not exist/,
      ],
      [
        'a missing column on the first statement',
        { ...READ_MODEL, invoices: READ_MODEL.invoices.filter((c) => c !== 'created_at') },
        /column "created_at" does not exist/,
      ],
    ])('fails on %s and leaves no partial index set', (_label, tables, message) => {
      const state = schemaWith(tables);
      const before = describeSchema(state);
      expect(() => runMigration(state, load(ANALYTICS), 'up')).toThrow(message);
      expect(describeSchema(state)).toEqual(before);
      expect(state.indexes.size).toBe(0);
    });

    it('does not apply on top of the initial schema migration: the columns it needs are not created there', () => {
      // Verified defect, pinned so it is not forgotten: 1719582000000 creates
      // invoices(contract_id, amount, status, created_at), events(ledger,
      // contract_id, topics, data) and `reputation`, but the analytics migration
      // indexes invoices.token / funder, events.event_type / contract_event_type
      // and a `reputation_updates` table. Chaining them fails.
      const state = emptySchema();
      runMigration(state, load(INITIAL), 'up');
      const afterInitial = describeSchema(state);

      expect(() => runMigration(state, load(ANALYTICS), 'up')).toThrow(/column "token" does not exist/);
      // The invoices(created_at) index created before the failure was rolled back with the migration.
      expect(describeSchema(state)).toEqual(afterInitial);
      expect(state.indexes.size).toBe(0);
    });
  });

  it('is a safe no-op to roll back after a failed up (nothing to remove)', () => {
    const state = schemaWith({ invoices: READ_MODEL.invoices });
    expect(() => runMigration(state, load(ANALYTICS), 'up')).toThrow();
    expect(() => runMigration(state, load(ANALYTICS), 'down')).not.toThrow();
    expect(state.indexes.size).toBe(0);
  });
});

describe('migration atomicity model', () => {
  it('restores the schema when a later statement of the same migration throws', () => {
    const state = emptySchema();
    const failing: Migration = {
      up: (pgm: any) => {
        pgm.createTable('t', { id: 'id', a: { type: 'text' } });
        pgm.createIndex('t', 'a');
        pgm.createIndex('t', 'missing');
      },
      down: () => undefined,
    };
    const before = cloneSchema(state);
    expect(() => runMigration(state, failing, 'up')).toThrow(/column "missing" does not exist/);
    expect(describeSchema(state)).toEqual(describeSchema(before));
  });
});

describe('analytics migration matches the live SQLite read model', () => {
  // The migration files are Postgres; production runs SQLite via initializeSchema.
  // Each index the migration intends must already exist in the live schema on the
  // same table and columns, otherwise the two have diverged.
  const live = new Database(':memory:');
  initializeSchema(live);
  afterAll(() => live.close());

  const liveIndexes = (table: string): string[][] =>
    (live.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((index) =>
      (live.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>).map((c) => c.name)
    );

  it.each([
    ['invoices', ['created_at']],
    ['invoices', ['token']],
    ['invoices', ['funder']],
    ['events', ['event_type']],
    ['events', ['contract_event_type']],
    ['reputation_updates', ['address', 'id']],
  ])('has an index on %s(%j)', (table, columns) => {
    expect(liveIndexes(table)).toContainEqual(columns);
  });
});
