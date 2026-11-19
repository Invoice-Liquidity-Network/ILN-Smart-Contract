import Database from 'better-sqlite3';
import { createApp, type CreateAppOptions } from '../src/app.js';
import { initializeSchema } from '../src/db/schema.js';

export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initializeSchema(db);
  return db;
}

export function seedInvoice(
  db: Database.Database,
  overrides: Partial<{
    id: number;
    freelancer: string;
    payer: string;
    token: string;
    amount: string;
    due_date: number;
    discount_rate: number;
    status: string;
    funder: string;
    funded_at: number;
    amount_funded: string;
    amount_paid: string;
    referral_code: string;
    submitter_reputation: number;
    created_at: number;
  }> = {}
) {
  const defaults = {
    id: 1,
    freelancer: 'GAAAAAAA...FREELANCER',
    payer: 'GAAAAAAAA...PAYER',
    token: 'USDC_CONTRACT',
    amount: '1000000',
    due_date: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    discount_rate: 500,
    status: 'Pending',
    funder: null as string | null,
    funded_at: null as number | null,
    amount_funded: '0',
    amount_paid: '0',
    referral_code: null as string | null,
    submitter_reputation: 50,
    created_at: Math.floor(Date.now() / 1000),
    ...overrides,
  };

  db.prepare(
    `INSERT INTO invoices (id, freelancer, payer, token, amount, due_date, discount_rate, status, funder, funded_at, amount_funded, amount_paid, referral_code, submitter_reputation, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    defaults.id,
    defaults.freelancer,
    defaults.payer,
    defaults.token,
    defaults.amount,
    defaults.due_date,
    defaults.discount_rate,
    defaults.status,
    defaults.funder,
    defaults.funded_at,
    defaults.amount_funded,
    defaults.amount_paid,
    defaults.referral_code,
    defaults.submitter_reputation,
    defaults.created_at
  );

  return defaults;
}

export function seedEvent(
  db: Database.Database,
  overrides: Partial<{
    invoice_id: number;
    event_type: string;
    ledger: number;
    timestamp: number;
    data: string;
  }> = {}
) {
  const defaults = {
    invoice_id: 1,
    event_type: 'submitted',
    ledger: 100,
    timestamp: Math.floor(Date.now() / 1000),
    data: '{}',
    ...overrides,
  };

  db.prepare(
    `INSERT INTO events (invoice_id, event_type, ledger, timestamp, data)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    defaults.invoice_id,
    defaults.event_type,
    defaults.ledger,
    defaults.timestamp,
    defaults.data
  );

  return defaults;
}

export function seedReputation(
  db: Database.Database,
  overrides: Partial<{
    address: string;
    event_type: string;
    old_score: number;
    new_score: number;
    invoices_submitted: number;
    invoices_paid: number;
    invoices_defaulted: number;
    ledger: number;
    timestamp: number;
  }> = {}
) {
  const defaults = {
    address: 'GAAAAAAAA...ADDRESS',
    event_type: 'reputation_updated',
    old_score: 0,
    new_score: 50,
    invoices_submitted: 0,
    invoices_paid: 0,
    invoices_defaulted: 0,
    ledger: 100,
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };

  db.prepare(
    `INSERT INTO reputation_updates (address, event_type, old_score, new_score, invoices_submitted, invoices_paid, invoices_defaulted, ledger, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    defaults.address,
    defaults.event_type,
    defaults.old_score,
    defaults.new_score,
    defaults.invoices_submitted,
    defaults.invoices_paid,
    defaults.invoices_defaulted,
    defaults.ledger,
    defaults.timestamp
  );

  return defaults;
}

export function seedStatsHistory(
  db: Database.Database,
  overrides: Partial<{
    date: string;
    total_invoices: number;
    total_funded: number;
    total_paid: number;
    total_volume: string;
    avg_discount_rate_bps: number;
  }> = {}
) {
  const defaults = {
    date: '2024-01-15',
    total_invoices: 10,
    total_funded: 8,
    total_paid: 5,
    total_volume: '5000000',
    avg_discount_rate_bps: 450,
    ...overrides,
  };

  db.prepare(
    `INSERT INTO stats_history (date, total_invoices, total_funded, total_paid, total_volume, avg_discount_rate_bps)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    defaults.date,
    defaults.total_invoices,
    defaults.total_funded,
    defaults.total_paid,
    defaults.total_volume,
    defaults.avg_discount_rate_bps
  );

  return defaults;
}

export function createTestApp(db: Database.Database, options?: CreateAppOptions) {
  return createApp(db, options);
}
