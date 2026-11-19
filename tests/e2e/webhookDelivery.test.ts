import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { SubscriptionStore } from '../../notifications/src/subscriptions/subscriptionStore.js';
import { WebhookDeliveryService } from '../../notifications/src/delivery/webhookDelivery.js';
import { DeliveryHistoryStore } from '../../notifications/src/delivery/deliveryHistory.js';
import { createWebhooksRouter } from '../../notifications/src/api/webhooks.js';
import { createHmac } from 'node:crypto';
import Database from 'better-sqlite3';

type DB = Database.Database;

function createTestDb(): DB {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function startMockWebhookReceiver(): Promise<{
  server: ReturnType<typeof createServer>;
  port: number;
  received: { body: any; signature: string; headers: Record<string, string> }[];
  setRespondWith: (fn: (body: any) => { status: number }) => void;
  close: () => Promise<void>;
}> {
  const received: { body: any; signature: string; headers: Record<string, string> }[] = [];
  let respondWith = (_body: any) => ({ status: 200 });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString()));
    req.on('end', () => {
      const parsed = JSON.parse(data);
      received.push({
        body: parsed,
        signature: req.headers['x-iln-signature'] as string || '',
        headers: req.headers as Record<string, string>,
      });
      const { status } = respondWith(parsed);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: status >= 200 && status < 300 ? 'ok' : 'error' }));
    });
  });

  return new Promise((resolvePromise) => {
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolvePromise({
        server,
        port,
        received,
        setRespondWith: (fn) => { respondWith = fn; },
        close: () => new Promise((cb) => server.close(() => cb())),
      });
    });
  });
}

function signPayload(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

async function startNotificationsApp(db: DB, httpClient: any) {
  const store = new SubscriptionStore(db);
  const historyStore = new DeliveryHistoryStore();
  const delivery = new WebhookDeliveryService({
    http: httpClient,
    logger: () => {},
    historyStore,
  });

  const app = express();
  app.use(express.json());
  app.use(createWebhooksRouter(store, delivery, undefined, historyStore));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    store,
    delivery,
    historyStore,
    close: () => new Promise<void>((cb) => server.close(() => cb())),
  };
}

describe('E2E: Notifications webhook delivery', () => {
  let db: DB;
  let mockReceiver: Awaited<ReturnType<typeof startMockWebhookReceiver>>;
  let notificationsSvc: Awaited<ReturnType<typeof startNotificationsApp>>;

  beforeEach(async () => {
    db = createTestDb();
    mockReceiver = await startMockWebhookReceiver();
    notificationsSvc = await startNotificationsApp(db, async (url: string, init: any) => {
      const res = await fetch(url, init);
      return { status: res.status };
    });
  });

  afterEach(async () => {
    await notificationsSvc.close();
    await mockReceiver.close();
    db.close();
  });

  it('should deliver webhook to mock receiver with correct payload and HMAC signature', async () => {
    const webhookUrl = `http://127.0.0.1:${mockReceiver.port}/hooks/test`;
    const secret = 'test-secret-key';

    const sub = notificationsSvc.store.create({
      endpointId: 'test-endpoint',
      url: webhookUrl,
      secret,
      eventTypes: ['invoice.funded'],
    });

    const payload = {
      event: 'invoice.funded',
      invoiceId: 42,
      data: { token: 'USDC', amount: '1000000', funder: 'GLP_FUNDER' },
      timestamp: new Date().toISOString(),
    };

    await notificationsSvc.delivery.deliver(
      { id: sub.endpointId, url: webhookUrl, secret },
      payload,
      'invoice.funded',
    );

    expect(mockReceiver.received.length).toBe(1);

    const received = mockReceiver.received[0];
    expect(received.body).toEqual(payload);

    const expectedSig = signPayload(secret, JSON.stringify(payload));
    expect(received.signature).toBe(expectedSig);
  });

  it('should retry delivery when receiver fails on first attempt', async () => {
    let attemptCount = 0;
    mockReceiver.setRespondWith(() => {
      attemptCount++;
      if (attemptCount <= 1) return { status: 500 };
      return { status: 200 };
    });

    const webhookUrl = `http://127.0.0.1:${mockReceiver.port}/hooks/retry-test`;
    const secret = 'retry-secret';

    const sub = notificationsSvc.store.create({
      endpointId: 'retry-endpoint',
      url: webhookUrl,
      secret,
      eventTypes: ['invoice.paid'],
    });

    const payload = {
      event: 'invoice.paid',
      invoiceId: 99,
      data: { amount: '500000' },
      timestamp: new Date().toISOString(),
    };

    const deliveryResult = await notificationsSvc.delivery.deliver(
      { id: sub.endpointId, url: webhookUrl, secret },
      payload,
      'invoice.paid',
    );

    expect(deliveryResult.ok).toBe(false);
    expect(deliveryResult.status).toBe(500);

    const deliveryResultRetry = await notificationsSvc.delivery.deliver(
      { id: sub.endpointId, url: webhookUrl, secret },
      payload,
      'invoice.paid',
    );

    expect(deliveryResultRetry.ok).toBe(true);
    expect(deliveryResultRetry.status).toBe(200);
    expect(mockReceiver.received.length).toBe(2);
  });

  it('should register webhook via API and deliver event', async () => {
    const webhookUrl = `http://127.0.0.1:${mockReceiver.port}/hooks/api-test`;
    const secret = 'api-secret-key';

    const apiPort = notificationsSvc.port;
    const createRes = await fetch(`http://127.0.0.1:${apiPort}/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret,
        eventTypes: ['invoice.submitted'],
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.url).toBe(webhookUrl);
    expect(created.eventTypes).toEqual(['invoice.submitted']);

    const listRes = await fetch(`http://127.0.0.1:${apiPort}/webhooks`);
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.length).toBeGreaterThanOrEqual(1);

    const payload = {
      event: 'invoice.submitted',
      invoiceId: 1,
      data: { token: 'EURC', amount: '2500000' },
      timestamp: new Date().toISOString(),
    };

    await notificationsSvc.delivery.deliver(
      { id: created.id, url: webhookUrl, secret },
      payload,
      'invoice.submitted',
    );

    expect(mockReceiver.received.length).toBe(1);
    expect(mockReceiver.received[0].body.event).toBe('invoice.submitted');
  });

  it('should verify HMAC signature on received payload', async () => {
    const webhookUrl = `http://127.0.0.1:${mockReceiver.port}/hooks/sig-test`;
    const secret = 'hmac-test-secret';

    const sub = notificationsSvc.store.create({
      endpointId: 'sig-endpoint',
      url: webhookUrl,
      secret,
      eventTypes: ['*'],
    });

    const payload = {
      event: 'invoice.expired',
      invoiceId: 7,
      data: {},
      timestamp: new Date().toISOString(),
    };

    await notificationsSvc.delivery.deliver(
      { id: sub.endpointId, url: webhookUrl, secret },
      payload,
      'invoice.expired',
    );

    expect(mockReceiver.received.length).toBe(1);

    const bodyStr = JSON.stringify(payload);
    const expectedSig = signPayload(secret, bodyStr);
    expect(mockReceiver.received[0].signature).toBe(expectedSig);

    const wrongSig = signPayload('wrong-secret', bodyStr);
    expect(mockReceiver.received[0].signature).not.toBe(wrongSig);
  });
});
