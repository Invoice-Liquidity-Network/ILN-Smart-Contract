import { describe, expect, it } from 'vitest';
import { DeliveryHistoryStore, type DeliveryRecord } from '../src/delivery/deliveryHistory';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeRecord(overrides: Partial<DeliveryRecord> = {}): Omit<DeliveryRecord, 'id'> {
  return {
    webhookId: 'w1',
    eventType: 'invoice.paid',
    deliveredAt: Date.now(),
    statusCode: 200,
    responseBody: '{"ok":true}',
    attemptCount: 1,
    nextRetryAt: null,
    ...overrides,
  };
}

describe('DeliveryHistoryStore retention policy', () => {
  it('retains recent records with their response bodies', () => {
    const store = new DeliveryHistoryStore();
    store.add(makeRecord());

    const { items } = store.listByWebhook('w1', 1, 20);
    expect(items).toHaveLength(1);
    expect(items[0]!.responseBody).toBe('{"ok":true}');
  });

  it('purges response bodies after bodyRetentionMs', () => {
    let t = 1000 * DAY_MS;
    const store = new DeliveryHistoryStore({ bodyRetentionMs: 7 * DAY_MS, now: () => t });
    store.add(makeRecord({ deliveredAt: t - 2 * DAY_MS, responseBody: 'contains-email@example.com' }));

    // Before the retention window the body is present.
    expect(store.listByWebhook('w1', 1, 20).items[0]!.responseBody).toBe(
      'contains-email@example.com',
    );

    // After 7 days the body is purged but metadata survives.
    t += 8 * DAY_MS;
    const purged = store.purgeExpired();
    expect(purged).toBe(1);

    const items = store.listByWebhook('w1', 1, 20).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.responseBody).toBe('');
    expect(items[0]!.statusCode).toBe(200);
    expect(items[0]!.eventType).toBe('invoice.paid');
  });

  it('removes whole records after recordRetentionMs', () => {
    const t = 2000 * DAY_MS;
    const store = new DeliveryHistoryStore({
      bodyRetentionMs: 7 * DAY_MS,
      recordRetentionMs: 90 * DAY_MS,
      now: () => t,
    });
    store.add(makeRecord({ deliveredAt: t - 100 * DAY_MS }));

    const purged = store.purgeExpired();
    expect(purged).toBe(1);
    expect(store.listByWebhook('w1', 1, 20).items).toHaveLength(0);
    expect(store.listByWebhook('w1', 1, 20).total).toBe(0);
  });

  it('runs the purge automatically on add and list', () => {
    let t = 3000 * DAY_MS;
    const store = new DeliveryHistoryStore({
      bodyRetentionMs: 7 * DAY_MS,
      recordRetentionMs: 90 * DAY_MS,
      now: () => t,
    });
    // Record becomes old only after it is stored.
    store.add(makeRecord({ webhookId: 'w-old', deliveredAt: t }));

    // Advance past the body window, then trigger a list — purge runs inline.
    t += 30 * DAY_MS;
    const { items } = store.listByWebhook('w-old', 1, 20);
    expect(items[0]!.responseBody).toBe('');

    // Advance past the record window, then add a new record — purge runs
    // inline and drops the old record entirely.
    t += 90 * DAY_MS;
    store.add(makeRecord({ webhookId: 'w-new', deliveredAt: t }));
    expect(store.listByWebhook('w-old', 1, 20).total).toBe(0);
  });

  it('only removes expired records, not recent ones', () => {
    let t = 4000 * DAY_MS;
    const store = new DeliveryHistoryStore({
      bodyRetentionMs: 7 * DAY_MS,
      recordRetentionMs: 90 * DAY_MS,
      now: () => t,
    });
    // Two fresh records...
    store.add(makeRecord({ webhookId: 'w1', deliveredAt: t }));
    store.add(makeRecord({ webhookId: 'w1', deliveredAt: t }));

    // ...age out of the record window, then a new delivery lands (the
    // purge triggered by add() drops the old two, keeps the fresh one).
    t += 100 * DAY_MS;
    store.add(makeRecord({ webhookId: 'w1', deliveredAt: t }));

    const { items, total } = store.listByWebhook('w1', 1, 20);
    expect(total).toBe(1);
    expect(items[0]!.responseBody).toBe('{"ok":true}');
  });

  it('reports the number of records removed by an explicit purge', () => {
    let t = 6000 * DAY_MS;
    const store = new DeliveryHistoryStore({
      bodyRetentionMs: 7 * DAY_MS,
      recordRetentionMs: 90 * DAY_MS,
      now: () => t,
    });
    store.add(makeRecord({ webhookId: 'w1', deliveredAt: t }));
    store.add(makeRecord({ webhookId: 'w1', deliveredAt: t }));

    t += 91 * DAY_MS;
    expect(store.purgeExpired()).toBe(2);
    expect(store.listByWebhook('w1', 1, 20).total).toBe(0);
  });

  it('keeps pagination consistent after full-record purges', () => {
    let t = 5000 * DAY_MS;
    const store = new DeliveryHistoryStore({
      bodyRetentionMs: 7 * DAY_MS,
      recordRetentionMs: 90 * DAY_MS,
      now: () => t,
    });
    for (let i = 0; i < 5; i++) {
      store.add(makeRecord({ webhookId: 'w1', deliveredAt: t }));
    }
    // One record falls out of the retention window.
    t += 100 * DAY_MS;
    store.purgeExpired();

    // Re-add a fresh record so the webhook still has history.
    store.add(makeRecord({ webhookId: 'w1', deliveredAt: t }));

    const page1 = store.listByWebhook('w1', 1, 2);
    expect(page1.total).toBe(1);
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]!.responseBody).toBe('{"ok":true}');
  });
});
