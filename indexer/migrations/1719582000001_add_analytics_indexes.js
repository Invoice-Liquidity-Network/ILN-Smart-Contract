exports.up = (pgm) => {
  pgm.createIndex("invoices", "created_at");
  pgm.createIndex("invoices", "token");
  pgm.createIndex("invoices", "funder");
  pgm.createIndex("events", "event_type");
  pgm.createIndex("events", "contract_event_type");
  pgm.createIndex("reputation_updates", ["address", "id"]);
};

exports.down = (pgm) => {
  pgm.dropIndex("invoices", "created_at");
  pgm.dropIndex("invoices", "token");
  pgm.dropIndex("invoices", "funder");
  pgm.dropIndex("events", "event_type");
  pgm.dropIndex("events", "contract_event_type");
  pgm.dropIndex("reputation_updates", ["address", "id"]);
};
