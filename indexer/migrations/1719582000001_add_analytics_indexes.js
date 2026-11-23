// Analytics indexes for the invoice / event / reputation read model.
//
// Preconditions (checked by indexer/tests/migrations.test.ts): the tables
// `invoices` (created_at, token, funder), `events` (event_type,
// contract_event_type) and `reputation_updates` (address, id) must exist.
// If any is missing the statement fails and node-pg-migrate rolls the whole
// migration back (migrations run in a transaction), so no partial index set
// is left behind.
//
// Both directions are idempotent: `up` skips indexes that already exist and
// `down` skips indexes that are already gone, so a repeated run or a
// rollback after a partial manual cleanup does not abort.
exports.up = (pgm) => {
  pgm.createIndex("invoices", "created_at", { ifNotExists: true });
  pgm.createIndex("invoices", "token", { ifNotExists: true });
  pgm.createIndex("invoices", "funder", { ifNotExists: true });
  pgm.createIndex("events", "event_type", { ifNotExists: true });
  pgm.createIndex("events", "contract_event_type", { ifNotExists: true });
  pgm.createIndex("reputation_updates", ["address", "id"], { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropIndex("invoices", "created_at", { ifExists: true });
  pgm.dropIndex("invoices", "token", { ifExists: true });
  pgm.dropIndex("invoices", "funder", { ifExists: true });
  pgm.dropIndex("events", "event_type", { ifExists: true });
  pgm.dropIndex("events", "contract_event_type", { ifExists: true });
  pgm.dropIndex("reputation_updates", ["address", "id"], { ifExists: true });
};
