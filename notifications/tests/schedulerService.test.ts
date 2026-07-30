import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  SchedulerService,
  initDeliveredRemindersSchema,
  type InvoiceRow,
} from '../src/services/schedulerService';
import { EmailSubscriptionStore } from '../src/subscriptions/emailSubscriptionStore';
import { EmailDeliveryService } from '../src/delivery/emailDelivery';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Initialise a minimal in-memory invoice DB (mirrors the indexer schema). */
function makeInvoiceDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE invoices (
      id INTEGER PRIMARY KEY,
      freelancer TEXT NOT NULL,
      payer TEXT NOT NULL,
      token TEXT NOT NULL,
      amount TEXT NOT NULL,
      due_date INTEGER NOT NULL,
      discount_rate INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Pending',
      funder TEXT,
      funded_at INTEGER,
      amount_funded TEXT NOT NULL DEFAULT '0',
      amount_paid TEXT NOT NULL DEFAULT '0',
      referral_code TEXT,
      submitter_reputation INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

/** Insert a minimal invoice row; returns the inserted ID. */
function insertInvoice(
  db: Database.Database,
  overrides: Partial<InvoiceRow & { discount_rate?: number; created_at?: number }> = {},
): number {
  const defaults = {
    id: 1,
    freelancer: 'GFREELANCER1',
    payer: 'GPAYER1',
    token: 'USDC',
    amount: '1000000000',
    due_date: 9999999999,
    discount_rate: 0,
    status: 'Funded',
    funder: 'GFUNDER1',
    created_at: 1000000,
  };
  const row = { ...defaults, ...overrides };
  db.prepare(
    `INSERT INTO invoices
      (id, freelancer, payer, token, amount, due_date, discount_rate,
       status, funder, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.freelancer,
    row.payer,
    row.token,
    row.amount,
    row.due_date,
    row.discount_rate,
    row.status,
    row.funder ?? null,
    row.created_at,
  );
  return row.id;
}

/** Build a fake EmailDeliveryService whose send() is a spy. */
function makeEmailDelivery(sendResult = { ok: true, id: 'msg_1' }) {
  const client = { send: vi.fn(async () => ({ id: 'msg_1' })) };
  const svc = new EmailDeliveryService(client as any, 'noreply@iln.dev');
  vi.spyOn(svc, 'send').mockResolvedValue(sendResult);
  return svc;
}

/** Convenience: create a SchedulerService wired to in-memory DBs. */
function makeScheduler(opts: {
  invoiceDb: Database.Database;
  notificationsDb: Database.Database;
  emailStore: EmailSubscriptionStore;
  emailDelivery: EmailDeliveryService;
  now?: () => number;
  logger?: (msg: string) => void;
}): SchedulerService {
  return new SchedulerService({
    ...opts,
    publicUrl: 'http://localhost:3001',
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('initDeliveredRemindersSchema', () => {
  it('creates the delivered_reminders table when it does not exist', () => {
    const db = new Database(':memory:');
    initDeliveredRemindersSchema(db);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('delivered_reminders');
  });

  it('is idempotent – calling it twice does not throw', () => {
    const db = new Database(':memory:');
    expect(() => {
      initDeliveredRemindersSchema(db);
      initDeliveredRemindersSchema(db);
    }).not.toThrow();
  });
});

describe('SchedulerService – schema init', () => {
  it('creates delivered_reminders table on construction', () => {
    const invoiceDb = makeInvoiceDb();
    const notificationsDb = new Database(':memory:');
    const emailStore = new EmailSubscriptionStore(notificationsDb);
    const emailDelivery = makeEmailDelivery();

    makeScheduler({ invoiceDb, notificationsDb, emailStore, emailDelivery });

    const tables = notificationsDb
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('delivered_reminders');
  });
});

describe('SchedulerService – runChecks() delivery', () => {
  let invoiceDb: Database.Database;
  let notificationsDb: Database.Database;
  let emailStore: EmailSubscriptionStore;
  let emailDelivery: ReturnType<typeof makeEmailDelivery>;
  let logs: string[];

  const BASE_NOW_SEC = 1_000_000; // arbitrary epoch in seconds
  const BASE_NOW_MS = BASE_NOW_SEC * 1000;

  beforeEach(() => {
    invoiceDb = makeInvoiceDb();
    notificationsDb = new Database(':memory:');
    emailStore = new EmailSubscriptionStore(notificationsDb);
    emailDelivery = makeEmailDelivery();
    logs = [];
  });

  afterEach(() => {
    invoiceDb.close();
    notificationsDb.close();
  });

  it('sends a 72-hour reminder for a funded invoice due within 72 h', async () => {
    // Invoice due exactly at the edge of the 72-hour window.
    const dueDate = BASE_NOW_SEC + 72 * 3600;
    insertInvoice(invoiceDb, { id: 1, status: 'Funded', due_date: dueDate });

    // Create and activate a subscription for the freelancer address.
    const sub = emailStore.create({
      address: 'GFREELANCER1',
      email: 'freelancer@example.com',
      eventTypes: ['invoice.expiring_soon'],
    });
    emailStore.activate(sub.id);

    const scheduler = makeScheduler({
      invoiceDb,
      notificationsDb,
      emailStore,
      emailDelivery,
      now: () => BASE_NOW_MS,
      logger: (m) => logs.push(m),
    });

    await scheduler.runChecks();

    expect(emailDelivery.send).toHaveBeenCalledTimes(1);
    const call = (emailDelivery.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.to).toBe('freelancer@example.com');
    expect(call.subject).toContain('72');
  });

  it('sends a 24-hour reminder for a funded invoice due within 24 h', async () => {
    const dueDate = BASE_NOW_SEC + 24 * 3600;
    insertInvoice(invoiceDb, { id: 2, status: 'Funded', due_date: dueDate });

    const sub = emailStore.create({
      address: 'GFREELANCER1',
      email: 'fl@example.com',
      eventTypes: ['invoice.expiring_soon'],
    });
    emailStore.activate(sub.id);

    const scheduler = makeScheduler({
      invoiceDb,
      notificationsDb,
      emailStore,
      emailDelivery,
      now: () => BASE_NOW_MS,
    });

    await scheduler.runChecks();

    // Invoice is within BOTH 72 h and 24 h windows.
    // Should receive exactly 2 emails (one per threshold).
    expect(emailDelivery.send).toHaveBeenCalledTimes(2);
  });

  it('does not send reminders for non-Funded invoices', async () => {
    const dueDate = BASE_NOW_SEC + 24 * 3600;
    insertInvoice(invoiceDb, { id: 3, status: 'Pending', due_date: dueDate });

    const sub = emailStore.create({
      address: 'GFREELANCER1',
      email: 'fl@example.com',
      eventTypes: ['invoice.expiring_soon'],
    });
    emailStore.activate(sub.id);

    const scheduler = makeScheduler({
      invoiceDb,
      notificationsDb,
      emailStore,
      emailDelivery,
      now: () => BASE_NOW_MS,
    });

    await scheduler.runChecks();

    expect(emailDelivery.send).not.toHaveBeenCalled();
  });

  it('does not send reminders for invoices outside both windows', async () => {
    // Due in 100 hours – beyond the 72-hour window.
    const dueDate = BASE_NOW_SEC + 100 * 3600;
    insertInvoice(invoiceDb, { id: 4, status: 'Funded', due_date: dueDate });

    const sub = emailStore.create({
      address: 'GFREELANCER1',
      email: 'fl@example.com',
      eventTypes: ['invoice.expiring_soon'],
    });
    emailStore.activate(sub.id);

    const scheduler = makeScheduler({
      invoiceDb,
      notificationsDb,
      emailStore,
      emailDelivery,
      now: () => BASE_NOW_MS,
    });

    await scheduler.runChecks();

    expect(emailDelivery.send).not.toHaveBeenCalled();
  });

  it('does not send to inactive (pending) subscribers', async () => {
    const dueDate = BASE_NOW_SEC + 24 * 3600;
    insertInvoice(invoiceDb, { id: 5, status: 'Funded', due_date: dueDate });

    // Subscription left in 'pending' state (never activated).
    emailStore.create({
      address: 'GFREELANCER1',
      email: 'pending@example.com',
      eventTypes: ['invoice.expiring_soon'],
    });

    const scheduler = makeScheduler({
      invoiceDb,
      notificationsDb,
      emailStore,
      emailDelivery,
      now: () => BASE_NOW_MS,
    });

    await scheduler.runChecks();

    expect(emailDelivery.send).not.toHaveBeenCalled();
  });

  it('does not send to unsubscribed subscribers', async () => {
    const dueDate = BASE_NOW_SEC + 24 * 3600;
    insertInvoice(invoiceDb, { id: 6, status: 'Funded', due_date: dueDate });

    const sub = emailStore.create({
      address: 'GFREELANCER1',
      email: 'unsub@example.com',
      eventTypes: ['invoice.expiring_soon'],
    });
    emailStore.activate(sub.id);
    emailStore.unsubscribe(sub.id);

    const scheduler = makeScheduler({
      invoiceDb,
      notificationsDb,
      emailStore,
      emailDelivery,
      now: () => BASE_NOW_MS,
    });

    await scheduler.runChecks();

    expect(emailDelivery.send).not.toHaveBeenCalled();
  });

  it('does not send to subscribers with non-matching eventTypes', async () => {
    const dueDate = BASE_NOW_SEC + 24 * 3600;
    insertInvoice(invoiceDb, { id: 7, status: 'Funded', due_date: dueDate });

    const sub = emailStore.create({
      address: 'GFREELANCER1',
      email: 'other@example.com',
      eventTypes: ['invoice.paid'], // not invoice.expiring_soon
    });
    emailStore.activate(sub.id);

    const scheduler = makeScheduler({
      invoiceDb,
      notificationsDb,
      emailStore,
      emailDelivery,
      now: () => BASE_NOW_MS,
    });

    await scheduler.runChecks();

    expect(emailDelivery.send).not.toHaveBeenCalled();
  });

  it('sends to subscribers with wildcard eventType "*"', async () => {
    const dueDate = BASE_NOW_SEC + 24 * 3600;
    insertInvoice(invoiceDb, { id: 8, status: 'Funded', due_date: dueDate });

    const sub = emailStore.create({
      address: 'GFREELANCER1',
      email: 'wildcard@example.com',
      eventTypes: ['*'],
    });
    emailStore.activate(sub.id);

    const scheduler = makeScheduler({
      invoiceDb,
      notificationsDb,
      emailStore,
      emailDelivery,
      now: () => BASE_NOW_MS,
    });

    await scheduler.runChecks();

    // Wildcard matches both 72 h and 24 h thresholds.
    expect(emailDelivery.send).toHaveBeenCalled();
  });

  it('notifies payer and funder as well as freelancer', async () => {
    const dueDate = BASE_NOW_SEC + 24 * 3600;
    insertInvoice(invoiceDb, {
      id: 9,
      status: 'Funded',
      due_date: dueDate,
      freelancer: 'GFREELANCER1',
      payer: 'GPAYER1',
      funder: 'GFUNDER1',
    });

    for (const [address, email] of [
      ['GFREELANCER1', 'fl@example.com'],
      ['GPAYER1', 'payer@example.com'],
      ['GFUNDER1', 'funder@example.com'],
    ]) {
      const sub = emailStore.create({
        address,
        email,
        eventTypes: ['invoice.expiring_soon'],
      });
      emailStore.activate(sub.id);
    }

    const scheduler = makeScheduler({
      invoiceDb,
      notificationsDb,
      emailStore,
      emailDelivery,
      now: () => BASE_NOW_MS,
    });

    await scheduler.runChecks();

    // Each of the 3 subscribers gets 2 emails (72 h + 24 h both match).
    expect(emailDelivery.send).toHaveBeenCalledTimes(6);
    const recipients = (emailDelivery.send as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0].to,
    );
    expect(recipients).toContain('fl@example.com');
    expect(recipients).toContain('payer@example.com');
    expect(recipients).toContain('funder@example.com');
  });
});

describe('SchedulerService – idempotency', () => {
  let invoiceDb: Database.Database;
  let notificationsDb: Database.Database;
  let emailStore: EmailSubscriptionStore;
  let emailDelivery: ReturnType<typeof makeEmailDelivery>;

  const BASE_NOW_SEC = 1_000_000;
  const BASE_NOW_MS = BASE_NOW_SEC * 1000;

  beforeEach(() => {
    invoiceDb = makeInvoiceDb();
    notificationsDb = new Database(':memory:');
    emailStore = new EmailSubscriptionStore(notificationsDb);
    emailDelivery = makeEmailDelivery();
  });

  afterEach(() => {
    invoiceDb.close();
    notificationsDb.close();
  });

  it('does not send duplicate reminders when runChecks() is called twice', async () => {
    const dueDate = BASE_NOW_SEC + 48 * 3600; // only in 72 h window
    insertInvoice(invoiceDb, { id: 10, status: 'Funded', due_date: dueDate });

    const sub = emailStore.create({
      address: 'GFREELANCER1',
      email: 'fl@example.com',
      eventTypes: ['invoice.expiring_soon'],
    });
    emailStore.activate(sub.id);

    const scheduler = makeScheduler({
      invoiceDb,
      notificationsDb,
      emailStore,
      emailDelivery,
      now: () => BASE_NOW_MS,
    });

    await scheduler.runChecks(); // first run → sends 1 email
    await scheduler.runChecks(); // second run → idempotent, sends nothing

    expect(emailDelivery.send).toHaveBeenCalledTimes(1);
  });

  it('persists idempotency across separate SchedulerService instances', async () => {
    const dueDate = BASE_NOW_SEC + 48 * 3600;
    insertInvoice(invoiceDb, { id: 11, status: 'Funded', due_date: dueDate });

    const sub = emailStore.create({
      address: 'GFREELANCER1',
      email: 'fl@example.com',
      eventTypes: ['invoice.expiring_soon'],
    });
    emailStore.activate(sub.id);

    const sharedArgs = {
      invoiceDb,
      notificationsDb,
      emailStore,
      emailDelivery,
      now: () => BASE_NOW_MS,
    };

    const scheduler1 = makeScheduler(sharedArgs);
    await scheduler1.runChecks(); // delivers the 72 h reminder

    // Create a brand-new instance backed by the same notificationsDb.
    const scheduler2 = makeScheduler(sharedArgs);
    await scheduler2.runChecks(); // should be a no-op

    expect(emailDelivery.send).toHaveBeenCalledTimes(1);
  });

  it('stores a delivered_reminders row after successful run', async () => {
    const dueDate = BASE_NOW_SEC + 48 * 3600;
    insertInvoice(invoiceDb, { id: 12, status: 'Funded', due_date: dueDate });

    const sub = emailStore.create({
      address: 'GFREELANCER1',
      email: 'fl@example.com',
      eventTypes: ['invoice.expiring_soon'],
    });
    emailStore.activate(sub.id);

    const scheduler = makeScheduler({
      invoiceDb,
      notificationsDb,
      emailStore,
      emailDelivery,
      now: () => BASE_NOW_MS,
    });

    await scheduler.runChecks();

    const rows = notificationsDb
      .prepare(`SELECT invoice_id, threshold_h FROM delivered_reminders`)
      .all() as { invoice_id: number; threshold_h: number }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ invoice_id: 12, threshold_h: 72 });
  });

  it('records separate rows for the 72 h and 24 h thresholds', async () => {
    // Invoice is within both the 72-h and 24-h windows.
    const dueDate = BASE_NOW_SEC + 12 * 3600;
    insertInvoice(invoiceDb, { id: 13, status: 'Funded', due_date: dueDate });

    const sub = emailStore.create({
      address: 'GFREELANCER1',
      email: 'fl@example.com',
      eventTypes: ['invoice.expiring_soon'],
    });
    emailStore.activate(sub.id);

    const scheduler = makeScheduler({
      invoiceDb,
      notificationsDb,
      emailStore,
      emailDelivery,
      now: () => BASE_NOW_MS,
    });

    await scheduler.runChecks();

    const rows = notificationsDb
      .prepare(
        `SELECT threshold_h FROM delivered_reminders
         WHERE invoice_id = 13
         ORDER BY threshold_h`,
      )
      .all() as { threshold_h: number }[];

    expect(rows.map((r) => r.threshold_h)).toEqual([24, 72]);
  });

  it('still records idempotency even when email delivery fails', async () => {
    const failDelivery = makeEmailDelivery({ ok: false, error: 'SMTP error' });

    const dueDate = BASE_NOW_SEC + 48 * 3600;
    insertInvoice(invoiceDb, { id: 14, status: 'Funded', due_date: dueDate });

    const sub = emailStore.create({
      address: 'GFREELANCER1',
      email: 'fl@example.com',
      eventTypes: ['invoice.expiring_soon'],
    });
    emailStore.activate(sub.id);

    const scheduler = makeScheduler({
      invoiceDb,
      notificationsDb,
      emailStore,
      emailDelivery: failDelivery,
      now: () => BASE_NOW_MS,
    });

    await scheduler.runChecks();
    await scheduler.runChecks(); // should still skip on second run

    // send() was called once (first run) and not again (second run).
    expect(failDelivery.send).toHaveBeenCalledTimes(1);

    const rows = notificationsDb
      .prepare(`SELECT invoice_id FROM delivered_reminders WHERE invoice_id = 14`)
      .all();
    expect(rows).toHaveLength(1);
  });
});

describe('SchedulerService – start() / stop()', () => {
  it('starts and stops without errors', () => {
    const invoiceDb = makeInvoiceDb();
    const notificationsDb = new Database(':memory:');
    const emailStore = new EmailSubscriptionStore(notificationsDb);
    const emailDelivery = makeEmailDelivery();
    const logs: string[] = [];

    const scheduler = makeScheduler({
      invoiceDb,
      notificationsDb,
      emailStore,
      emailDelivery,
      logger: (m) => logs.push(m),
    });

    scheduler.start();
    expect(logs).toContain('scheduler_started cron="*/30 * * * *"');

    scheduler.stop();
    expect(logs).toContain('scheduler_stopped');

    invoiceDb.close();
    notificationsDb.close();
  });

  it('start() is idempotent – calling twice does not create duplicate tasks', () => {
    const invoiceDb = makeInvoiceDb();
    const notificationsDb = new Database(':memory:');
    const emailStore = new EmailSubscriptionStore(notificationsDb);
    const emailDelivery = makeEmailDelivery();
    const logs: string[] = [];

    const scheduler = makeScheduler({
      invoiceDb,
      notificationsDb,
      emailStore,
      emailDelivery,
      logger: (m) => logs.push(m),
    });

    scheduler.start();
    scheduler.start(); // should be a no-op

    const startLogs = logs.filter((l) => l.startsWith('scheduler_started'));
    expect(startLogs).toHaveLength(1);

    scheduler.stop();
    invoiceDb.close();
    notificationsDb.close();
  });

  it('accepts a custom cron expression', () => {
    const invoiceDb = makeInvoiceDb();
    const notificationsDb = new Database(':memory:');
    const emailStore = new EmailSubscriptionStore(notificationsDb);
    const emailDelivery = makeEmailDelivery();
    const logs: string[] = [];

    const scheduler = new SchedulerService({
      invoiceDb,
      notificationsDb,
      emailStore,
      emailDelivery,
      publicUrl: 'http://localhost:3001',
      cronExpression: '0 * * * *', // hourly
      logger: (m) => logs.push(m),
    });

    scheduler.start();
    expect(logs).toContain('scheduler_started cron="0 * * * *"');
    scheduler.stop();

    invoiceDb.close();
    notificationsDb.close();
  });
});

describe('SchedulerService – logging', () => {
  it('logs run metadata including found invoice count', async () => {
    const invoiceDb = makeInvoiceDb();
    const notificationsDb = new Database(':memory:');
    const emailStore = new EmailSubscriptionStore(notificationsDb);
    const emailDelivery = makeEmailDelivery();
    const logs: string[] = [];

    const BASE_NOW_SEC = 1_000_000;
    const dueDate = BASE_NOW_SEC + 48 * 3600;
    insertInvoice(invoiceDb, { id: 20, status: 'Funded', due_date: dueDate });

    const scheduler = makeScheduler({
      invoiceDb,
      notificationsDb,
      emailStore,
      emailDelivery,
      now: () => BASE_NOW_SEC * 1000,
      logger: (m) => logs.push(m),
    });

    await scheduler.runChecks();

    expect(logs.some((l) => l.startsWith('scheduler_run'))).toBe(true);
    expect(logs.some((l) => l.includes('threshold=72h') && l.includes('count=1'))).toBe(true);
    expect(logs.some((l) => l.includes('threshold=24h') && l.includes('count=0'))).toBe(true);

    invoiceDb.close();
    notificationsDb.close();
  });

  it('logs skip when reminder already delivered', async () => {
    const invoiceDb = makeInvoiceDb();
    const notificationsDb = new Database(':memory:');
    const emailStore = new EmailSubscriptionStore(notificationsDb);
    const emailDelivery = makeEmailDelivery();
    const logs: string[] = [];

    const BASE_NOW_SEC = 1_000_000;
    const dueDate = BASE_NOW_SEC + 48 * 3600;
    insertInvoice(invoiceDb, { id: 21, status: 'Funded', due_date: dueDate });

    const scheduler = makeScheduler({
      invoiceDb,
      notificationsDb,
      emailStore,
      emailDelivery,
      now: () => BASE_NOW_SEC * 1000,
      logger: (m) => logs.push(m),
    });

    await scheduler.runChecks(); // first run
    logs.length = 0; // clear
    await scheduler.runChecks(); // second run – should log skip

    expect(logs.some((l) => l.includes('already_delivered'))).toBe(true);

    invoiceDb.close();
    notificationsDb.close();
  });
});
