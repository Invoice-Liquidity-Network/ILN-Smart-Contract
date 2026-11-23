/**
 * A small in-memory model of the node-pg-migrate operations the indexer's
 * migrations use (createTable, dropTable, createIndex, dropIndex).
 *
 * It exists because the repository has no Postgres or node-pg-migrate
 * dependency, so migrations cannot be executed for real in CI. The model
 * reproduces the behaviours that matter for rollback safety:
 *
 *  - an operation on a missing table/column/index throws (as Postgres does),
 *  - `ifNotExists` / `ifExists` make index creation/removal idempotent,
 *  - index names follow node-pg-migrate's default `<table>_<cols>_index`,
 *  - a migration runs atomically: if any statement throws, every earlier
 *    statement of that migration is undone (node-pg-migrate wraps each
 *    migration in a transaction by default).
 *
 * It is a model, not Postgres: types, constraints and locking are not
 * simulated. See docs/indexer-migration-safety.md.
 */

export type ColumnSpec = string | { type: string; [key: string]: unknown };

export interface IndexSpec {
  table: string;
  columns: string[];
}

export interface SchemaState {
  /** table -> column names */
  tables: Map<string, Set<string>>;
  /** index name -> definition */
  indexes: Map<string, IndexSpec>;
}

export interface Migration {
  up: (pgm: unknown) => void;
  down: (pgm: unknown) => void;
}

export function emptySchema(): SchemaState {
  return { tables: new Map(), indexes: new Map() };
}

export function schemaWith(tables: Record<string, string[]>): SchemaState {
  const state = emptySchema();
  for (const [name, columns] of Object.entries(tables)) {
    state.tables.set(name, new Set(columns));
  }
  return state;
}

export function cloneSchema(state: SchemaState): SchemaState {
  return {
    tables: new Map([...state.tables].map(([name, cols]) => [name, new Set(cols)])),
    indexes: new Map([...state.indexes].map(([name, spec]) => [name, { ...spec, columns: [...spec.columns] }])),
  };
}

/** Plain-object view for `toEqual` assertions (Maps/Sets are order-insensitive here). */
export function describeSchema(state: SchemaState): {
  tables: Record<string, string[]>;
  indexes: Record<string, IndexSpec>;
} {
  return {
    tables: Object.fromEntries([...state.tables].map(([n, c]) => [n, [...c].sort()]).sort()),
    indexes: Object.fromEntries([...state.indexes].sort()),
  };
}

const toArray = (columns: string | string[]): string[] => (Array.isArray(columns) ? columns : [columns]);

export const defaultIndexName = (table: string, columns: string | string[]): string =>
  `${table}_${toArray(columns).join('_')}_index`;

function makePgm(state: SchemaState) {
  const requireTable = (table: string): Set<string> => {
    const columns = state.tables.get(table);
    if (!columns) throw new Error(`relation "${table}" does not exist`);
    return columns;
  };

  return {
    func: (name: string) => ({ __func: name }),

    createTable(name: string, columns: Record<string, ColumnSpec>, options: { ifNotExists?: boolean } = {}) {
      if (state.tables.has(name)) {
        if (options.ifNotExists) return;
        throw new Error(`relation "${name}" already exists`);
      }
      state.tables.set(name, new Set(Object.keys(columns)));
    },

    dropTable(name: string, options: { ifExists?: boolean } = {}) {
      if (!state.tables.has(name)) {
        if (options.ifExists) return;
        throw new Error(`table "${name}" does not exist`);
      }
      state.tables.delete(name);
      for (const [indexName, spec] of [...state.indexes]) {
        if (spec.table === name) state.indexes.delete(indexName);
      }
    },

    createIndex(
      table: string,
      columns: string | string[],
      options: { name?: string; ifNotExists?: boolean } = {}
    ) {
      const existing = requireTable(table);
      for (const column of toArray(columns)) {
        if (!existing.has(column)) throw new Error(`column "${column}" does not exist`);
      }
      const name = options.name ?? defaultIndexName(table, columns);
      if (state.indexes.has(name)) {
        if (options.ifNotExists) return;
        throw new Error(`relation "${name}" already exists`);
      }
      state.indexes.set(name, { table, columns: toArray(columns) });
    },

    dropIndex(
      table: string,
      columns: string | string[],
      options: { name?: string; ifExists?: boolean } = {}
    ) {
      const name = options.name ?? defaultIndexName(table, columns);
      if (!state.indexes.has(name)) {
        if (options.ifExists) return;
        throw new Error(`index "${name}" does not exist`);
      }
      state.indexes.delete(name);
    },
  };
}

/**
 * Run one direction of a migration atomically against `state`.
 * On failure `state` is restored to its pre-migration contents and the error is rethrown.
 */
export function runMigration(state: SchemaState, migration: Migration, direction: 'up' | 'down'): void {
  const before = cloneSchema(state);
  try {
    migration[direction](makePgm(state));
  } catch (error) {
    state.tables = before.tables;
    state.indexes = before.indexes;
    throw error;
  }
}
