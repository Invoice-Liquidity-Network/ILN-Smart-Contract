import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createApp } from '../../indexer/src/app.js';
import { initializeSchema } from '../../indexer/src/database/schema.js';
import { clearStatsCache } from '../../indexer/src/services/statsService.js';

type DB = Database.Database;

function createTestDb(): DB {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initializeSchema(db);
  return db;
}

function seedInvoice(
  db: DB,
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
  }> = {},
) {
  const defaults = {
    id: 1,
    freelancer: 'GAAAAAAA...FREELANCER',
    payer: 'GAAAAAAAA...PAYER',
    token: 'USDC',
    amount: '1000000',
    due_date: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    discount_rate: 500,
    status: 'Pending',
    funder: null,
    funded_at: null,
    amount_funded: '0',
    amount_paid: '0',
    referral_code: null,
    submitter_reputation: 50,
    created_at: Math.floor(Date.now() / 1000),
    ...overrides,
  };

  db.prepare(
    `INSERT INTO invoices (id, freelancer, payer, token, amount, due_date, discount_rate, status, funder, funded_at, amount_funded, amount_paid, referral_code, submitter_reputation, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    defaults.created_at,
  );

  return defaults;
}

function seedEvent(
  db: DB,
  overrides: Partial<{
    invoice_id: number;
    event_type: string;
    ledger: number;
    timestamp: number;
    data: string;
  }> = {},
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
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    defaults.invoice_id,
    defaults.event_type,
    defaults.ledger,
    defaults.timestamp,
    defaults.data,
  );

  return defaults;
}

async function startApp(db: DB) {
  clearStatsCache();
  const app = createApp(db);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, port, close: () => new Promise<void>((cb) => server.close(() => cb())) };
}

function api(port: number) {
  return request(`http://127.0.0.1:${port}`);
}

async function pollInvoice(
  port: number,
  invoiceId: number,
  predicate: (body: any) => boolean,
  timeoutMs = 15000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await api(port).get(`/invoices/${invoiceId}`);
    if (res.status === 200 && predicate(res.body)) return res.body;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Invoice ${invoiceId} did not satisfy predicate within ${timeoutMs}ms`);
}

async function pollStats(
  port: number,
  predicate: (body: any) => boolean,
  timeoutMs = 15000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await api(port).get('/stats');
    if (res.status === 200 && predicate(res.body)) return res.body;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Stats did not satisfy predicate within ${timeoutMs}ms`);
}

describe('Indexer Event Consistency E2E', () => {
  let db: DB;
  let serverCtx: Awaited<ReturnType<typeof startApp>>;
  const now = Math.floor(Date.now() / 1000);

  beforeEach(async () => {
    db = createTestDb();
    serverCtx = await startApp(db);
  });

  afterEach(async () => {
    await serverCtx.close();
    db.close();
  });

  it('should reflect full invoice lifecycle with events', async () => {
    const { port } = serverCtx;
    let ledger = 100;

    // 1. Submit invoice
    seedInvoice(db, {
      id: 1,
      status: 'Pending',
      created_at: now,
    });
    seedEvent(db, {
      invoice_id: 1,
      event_type: 'submitted',
      ledger: ledger++,
      timestamp: now,
      data: JSON.stringify({ token: 'USDC', amount: '1000000' }),
    });

    const submitted = await pollInvoice(port, 1, (b) => b.status === 'Pending');
    expect(submitted.status).toBe('Pending');
    expect(submitted.events).toHaveLength(1);
    expect(submitted.events[0].type).toBe('submitted');

    // 2. Fund invoice
    const fundedAt = now + 60;
    db.prepare(`UPDATE invoices SET status = 'Funded', funder = 'GLP_FUNDER', funded_at = ?, amount_funded = '1000000' WHERE id = 1`).run(fundedAt);
    seedEvent(db, {
      invoice_id: 1,
      event_type: 'funded',
      ledger: ledger++,
      timestamp: fundedAt,
      data: JSON.stringify({ funder: 'GLP_FUNDER' }),
    });

    const funded = await pollInvoice(port, 1, (b) => b.status === 'Funded');
    expect(funded.funder).toBe('GLP_FUNDER');
    expect(funded.fundedAt).toBe(fundedAt);
    expect(funded.amountFunded).toBe('1000000');

    // 3. Mark paid
    const paidAt = now + 300;
    db.prepare(`UPDATE invoices SET status = 'Paid', amount_paid = '1000000' WHERE id = 1`).run();
    seedEvent(db, {
      invoice_id: 1,
      event_type: 'paid',
      ledger: ledger++,
      timestamp: paidAt,
      data: JSON.stringify({ amount: '1000000' }),
    });

    const paid = await pollInvoice(port, 1, (b) => b.status === 'Paid');
    expect(paid.amountPaid).toBe('1000000');
    expect(paid.events).toHaveLength(3);
    expect(paid.events.map((e: any) => e.type)).toEqual(['submitted', 'funded', 'paid']);

    // 4. Stats reflect paid invoice
    const stats = await pollStats(port, (s) => s.totalInvoices === 1 && s.totalPaid === 1);
    expect(stats.totalInvoices).toBe(1);
    expect(stats.totalFunded).toBe(1);
    expect(stats.totalPaid).toBe(1);
  });

  it('should handle cancel and dispute lifecycle', async () => {
    const { port } = serverCtx;
    let ledger = 200;

    // Submit + fund
    seedInvoice(db, { id: 2, status: 'Funded', funder: 'GLP_FUNDER', funded_at: now, amount_funded: '500000', created_at: now });
    seedEvent(db, { invoice_id: 2, event_type: 'submitted', ledger: ledger++, timestamp: now });
    seedEvent(db, { invoice_id: 2, event_type: 'funded', ledger: ledger++, timestamp: now + 30 });

    // Cancel
    db.prepare(`UPDATE invoices SET status = 'Cancelled' WHERE id = 2`).run();
    seedEvent(db, { invoice_id: 2, event_type: 'cancelled', ledger: ledger++, timestamp: now + 60 });

    const cancelled = await pollInvoice(port, 2, (b) => b.status === 'Cancelled');
    expect(cancelled.status).toBe('Cancelled');

    // Stats reflect cancel
    const stats = await pollStats(port, (s) => s.totalCancelled === 1);
    expect(stats.totalInvoices).toBe(1);
    expect(stats.totalCancelled).toBe(1);

    // Dispute lifecycle on another invoice
    seedInvoice(db, { id: 3, status: 'Funded', funder: 'GLP_FUNDER', funded_at: now, amount_funded: '750000', created_at: now });
    seedEvent(db, { invoice_id: 3, event_type: 'submitted', ledger: ledger++, timestamp: now });
    seedEvent(db, { invoice_id: 3, event_type: 'funded', ledger: ledger++, timestamp: now + 30 });

    db.prepare(`UPDATE invoices SET status = 'Disputed' WHERE id = 3`).run();
    seedEvent(db, { invoice_id: 3, event_type: 'disputed', ledger: ledger++, timestamp: now + 120 });

    const disputed = await pollInvoice(port, 3, (b) => b.status === 'Disputed');
    expect(disputed.status).toBe('Disputed');

    const stats2 = await pollStats(port, (s) => s.totalDisputed === 1);
    expect(stats2.totalDisputed).toBe(1);

    // Expire an invoice
    seedInvoice(db, { id: 4, status: 'Expired', due_date: now - 1, created_at: now - 86400 });
    seedEvent(db, { invoice_id: 4, event_type: 'expired', ledger: ledger++, timestamp: now - 1 });

    const expired = await pollInvoice(port, 4, (b) => b.status === 'Expired');
    expect(expired.status).toBe('Expired');
    expect(expired.daysUntilExpiry).toBe(0);
  });

  it('should catch up missed events after restart', async () => {
    const { port } = serverCtx;

    // Seed events while indexer was "down"
    seedInvoice(db, { id: 10, status: 'Paid', amount_paid: '2000000', funder: 'GLP_FUNDER', funded_at: now, amount_funded: '2000000', created_at: now });
    seedEvent(db, { invoice_id: 10, event_type: 'submitted', ledger: 500, timestamp: now });
    seedEvent(db, { invoice_id: 10, event_type: 'funded', ledger: 501, timestamp: now + 30 });
    seedEvent(db, { invoice_id: 10, event_type: 'paid', ledger: 502, timestamp: now + 300 });

    seedInvoice(db, { id: 11, status: 'Cancelled', created_at: now });
    seedEvent(db, { invoice_id: 11, event_type: 'submitted', ledger: 600, timestamp: now });
    seedEvent(db, { invoice_id: 11, event_type: 'cancelled', ledger: 601, timestamp: now + 60 });

    // Query after "restart" - indexer should return correct state
    const inv10 = await pollInvoice(port, 10, (b) => b.status === 'Paid');
    expect(inv10.amountPaid).toBe('2000000');
    expect(inv10.events).toHaveLength(3);

    const inv11 = await pollInvoice(port, 11, (b) => b.status === 'Cancelled');
    expect(inv11.events).toHaveLength(2);

    const stats = await pollStats(port, (s) => s.totalInvoices >= 2);
    expect(stats.totalInvoices).toBe(2);
    expect(stats.totalPaid).toBe(1);
    expect(stats.totalCancelled).toBe(1);
  });
});
