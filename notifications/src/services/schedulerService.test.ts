import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SchedulerService,
  type InvoiceRecord,
  type ReminderStore,
  type NotificationDispatcher,
  type SubscriberResolver,
  type SchedulerDeps,
} from './schedulerService';

const HOUR = 60 * 60 * 1000;

function makeInvoice(overrides: Partial<InvoiceRecord> = {}): InvoiceRecord {
  return {
    id: 'inv-1',
    state: 'Funded',
    dueDate: new Date(Date.now() + 48 * HOUR).toISOString(),
    payer: 'payer-1',
    lp: 'lp-1',
    submitter: 'submitter-1',
    ...overrides,
  };
}

function makeStore(): ReminderStore & { keys: Set<string> } {
  const keys = new Set<string>();
  return {
    keys,
    async hasDelivered(key: string) {
      return keys.has(key);
    },
    async markDelivered(key: string) {
      keys.add(key);
    },
  };
}

function makeDispatcher() {
  const calls: Array<{ subscriber: string; invoiceId: string; threshold: number }> = [];
  const dispatcher: NotificationDispatcher = {
    async deliver(subscriber, invoice, threshold) {
      calls.push({ subscriber, invoiceId: invoice.id, threshold });
    },
  };
  return { dispatcher, calls };
}

function makeResolver(map: Record<string, string[]>): SubscriberResolver {
  return {
    async resolve(invoice) {
      const parties = [invoice.payer, invoice.lp, invoice.submitter].filter(Boolean) as string[];
      const out = new Set<string>();
      for (const party of parties) {
        for (const sub of map[party] ?? []) out.add(sub);
      }
      return [...out];
    },
  };
}

function makeDeps(overrides: Partial<SchedulerDeps> = {}): SchedulerDeps {
  return {
    fetchInvoices: async () => [makeInvoice()],
    store: makeStore(),
    dispatcher: makeDispatcher().dispatcher,
    resolver: makeResolver({ 'payer-1': ['sub-a'], 'lp-1': ['sub-b'], 'submitter-1': ['sub-c'] }),
    now: () => new Date(),
    ...overrides,
  };
}

describe('SchedulerService', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('delivers 72h and 24h reminders to all subscribers of payer, LP and submitter', async () => {
    const { dispatcher, calls } = makeDispatcher();
    const service = new SchedulerService(
      makeDeps({
        fetchInvoices: async () => [makeInvoice({ dueDate: new Date(Date.now() + 48 * HOUR).toISOString() })],
        dispatcher,
      }),
    );

    await service.runOnce();

    const thresholds = calls.map((c) => c.threshold).sort();
    expect(thresholds).toEqual([24, 72]);
    const subscribers = new Set(calls.map((c) => c.subscriber));
    expect(subscribers).toEqual(new Set(['sub-a', 'sub-b', 'sub-c']));
  });

  it('only considers invoices in Funded state', async () => {
    const { dispatcher, calls } = makeDispatcher();
    const service = new SchedulerService(
      makeDeps({
        fetchInvoices: async () => [
          makeInvoice({ id: 'funded', state: 'Funded' }),
          makeInvoice({ id: 'repaid', state: 'Repaid' }),
        ],
        dispatcher,
      }),
    );

    await service.runOnce();

    expect(calls.every((c) => c.invoiceId === 'funded')).toBe(true);
  });

  it('does not deliver reminders for invoices outside the 72h window', async () => {
    const { dispatcher, calls } = makeDispatcher();
    const service = new SchedulerService(
      makeDeps({
        fetchInvoices: async () => [makeInvoice({ dueDate: new Date(Date.now() + 200 * HOUR).toISOString() })],
        dispatcher,
      }),
    );

    await service.runOnce();

    expect(calls).toHaveLength(0);
  });

  it('is idempotent: repeated runs do not re-deliver the same invoice + threshold', async () => {
    const { dispatcher, calls } = makeDispatcher();
    const store = makeStore();
    const service = new SchedulerService(
      makeDeps({
        fetchInvoices: async () => [makeInvoice({ dueDate: new Date(Date.now() + 48 * HOUR).toISOString() })],
        store,
        dispatcher,
      }),
    );

    await service.runOnce();
    const firstRun = calls.length;
    expect(firstRun).toBeGreaterThan(0);

    await service.runOnce();

    expect(calls.length).toBe(firstRun);
    expect(store.keys.has('inv-1:72')).toBe(true);
    expect(store.keys.has('inv-1:24')).toBe(true);
  });

  it('records the idempotency key per invoice and threshold', async () => {
    const store = makeStore();
    const service = new SchedulerService(
      makeDeps({
        fetchInvoices: async () => [makeInvoice({ id: 'inv-42', dueDate: new Date(Date.now() + 48 * HOUR).toISOString() })],
        store,
      }),
    );

    await service.runOnce();

    expect(store.keys.has('inv-42:72')).toBe(true);
    expect(store.keys.has('inv-42:24')).toBe(true);
  });

  it('schedules checks every 30 minutes via node-cron', () => {
    const service = new SchedulerService(makeDeps());
    const schedule = vi.fn(() => ({ stop: vi.fn() }));

    service.start(schedule as never);

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][0]).toBe('*/30 * * * *');
  });
});
