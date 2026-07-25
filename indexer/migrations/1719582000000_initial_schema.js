exports.up = (pgm) => {
  pgm.createTable("invoices", {
    id: "id",
    contract_id: { type: "varchar(56)", notNull: true },
    amount: { type: "numeric", notNull: true },
    status: { type: "varchar(20)", notNull: true },
    created_at: { type: "timestamp", notNull: true, default: pgm.func("current_timestamp") }
  });
  pgm.createTable("events", {
    id: "id",
    ledger: { type: "integer", notNull: true },
    contract_id: { type: "varchar(56)", notNull: true },
    topics: { type: "text[]", notNull: true },
    data: { type: "jsonb", notNull: true }
  });
  pgm.createTable("reputation", {
    id: "id",
    account_id: { type: "varchar(56)", notNull: true, unique: true },
    score: { type: "integer", notNull: true, default: 0 }
  });
};
exports.down = (pgm) => {
  pgm.dropTable("reputation");
  pgm.dropTable("events");
  pgm.dropTable("invoices");
};
