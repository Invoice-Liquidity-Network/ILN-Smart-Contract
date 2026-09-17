import type Database from 'better-sqlite3';

export interface InvoiceRecord {
  id: number;
  freelancer: string;
  payer: string;
  token: string;
  amount: string;
  due_date: number;
  discount_rate: number;
  status: string;
  funder: string | null;
  funded_at: number | null;
  amount_funded: string;
  amount_paid: string;
  referral_code: string | null;
  submitter_reputation: number;
  created_at: number;
}

export interface ReputationUpdateRecord {
  address: string;
  event_type: string;
  old_score: number;
  new_score: number;
  invoices_submitted: number;
  invoices_paid: number;
  invoices_defaulted: number;
  ledger: number;
  timestamp: number;
  contract_id: string | null;
  transaction_hash: string | null;
  transaction_paging_token: string | null;
  event_index: number | null;
  topics_json: string;
}

export interface IngestedEventRecord {
  invoice_id: number | null;
  event_type: string;
  ledger: number;
  timestamp: number;
  data: string;
  contract_id: string | null;
  contract_event_type: string | null;
  transaction_hash: string | null;
  transaction_paging_token: string | null;
  event_index: number | null;
  topics_json: string;
}

export interface EventRepository {
  getState(key: string): string | undefined;
  setState(key: string, value: string): void;
  getInvoice(id: number): InvoiceRecord | undefined;
  upsertInvoice(invoice: InvoiceRecord): void;
  insertEvent(event: IngestedEventRecord): void;
  insertReputationUpdate(update: ReputationUpdateRecord): void;
}

export function createSqlEventRepository(db: Database.Database): EventRepository {
  return {
    getState(key) {
      const row = db
        .prepare('SELECT state_value FROM indexer_state WHERE state_key = ?')
        .get(key) as { state_value: string } | undefined;
      return row?.state_value;
    },
    setState(key, value) {
      db.prepare(
        `
        INSERT INTO indexer_state (state_key, state_value)
        VALUES (?, ?)
        ON CONFLICT(state_key) DO UPDATE SET state_value = excluded.state_value
      `
      ).run(key, value);
    },
    getInvoice(id) {
      return db
        .prepare('SELECT * FROM invoices WHERE id = ?')
        .get(id) as InvoiceRecord | undefined;
    },
    upsertInvoice(invoice) {
      db.prepare(
        `
        INSERT INTO invoices (
          id, freelancer, payer, token, amount, due_date, discount_rate, status,
          funder, funded_at, amount_funded, amount_paid, referral_code,
          submitter_reputation, created_at
        ) VALUES (
          @id, @freelancer, @payer, @token, @amount, @due_date, @discount_rate, @status,
          @funder, @funded_at, @amount_funded, @amount_paid, @referral_code,
          @submitter_reputation, @created_at
        )
        ON CONFLICT(id) DO UPDATE SET
          freelancer = excluded.freelancer,
          payer = excluded.payer,
          token = excluded.token,
          amount = excluded.amount,
          due_date = excluded.due_date,
          discount_rate = excluded.discount_rate,
          status = excluded.status,
          funder = excluded.funder,
          funded_at = excluded.funded_at,
          amount_funded = excluded.amount_funded,
          amount_paid = excluded.amount_paid,
          referral_code = excluded.referral_code,
          submitter_reputation = excluded.submitter_reputation,
          created_at = excluded.created_at
      `
      ).run(invoice);
    },
    insertEvent(event) {
      db.prepare(
        `
        INSERT INTO events (
          invoice_id, event_type, ledger, timestamp, data, contract_id,
          contract_event_type, transaction_hash, transaction_paging_token,
          event_index, topics_json
        ) VALUES (
          @invoice_id, @event_type, @ledger, @timestamp, @data, @contract_id,
          @contract_event_type, @transaction_hash, @transaction_paging_token,
          @event_index, @topics_json
        )
        ON CONFLICT(transaction_hash, event_index) DO NOTHING
      `
      ).run(event);
    },
    insertReputationUpdate(update) {
      db.prepare(
        `
        INSERT INTO reputation_updates (
          address, event_type, old_score, new_score, invoices_submitted,
          invoices_paid, invoices_defaulted, ledger, timestamp, contract_id,
          transaction_hash, transaction_paging_token, event_index, topics_json
        ) VALUES (
          @address, @event_type, @old_score, @new_score, @invoices_submitted,
          @invoices_paid, @invoices_defaulted, @ledger, @timestamp, @contract_id,
          @transaction_hash, @transaction_paging_token, @event_index, @topics_json
        )
        ON CONFLICT(transaction_hash, event_index) DO NOTHING
      `
      ).run(update);
    },
  };
}
