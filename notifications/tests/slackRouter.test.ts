import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createSlackRouter } from '../src/api/slack';

function makeApp() {
  const store = new Map<string, any>();
  const httpClient = vi.fn(async () => ({ ok: false, status: 500 }));
  const app = express();
  app.use(express.json());
  app.use(createSlackRouter(store, { httpClient }));
  return { app, store, httpClient };
}

async function request(app: express.Express, method: string, path: string, body?: any) {
  const { default: http } = await import('node:http');
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const server = http.createServer(app).listen(0, () => {
      const { port } = server.address() as any;
      const req = http.request(
        { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json' } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString();
            let parsed: any = null;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              parsed = text;
            }
            server.close();
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

describe('Slack router', () => {
  it('creates a slack subscription', async () => {
    const { app } = makeApp();
    const res = await request(app, 'POST', '/subscriptions/slack', {
      url: 'https://hooks.slack.com/services/T00/B00/xxx',
      eventTypes: ['invoice.submitted', 'invoice.paid'],
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^slk_/);
    expect(res.body.url).toBe('https://hooks.slack.com/services/T00/B00/xxx');
  });

  it('rejects invalid body', async () => {
    const { app } = makeApp();
    const res = await request(app, 'POST', '/subscriptions/slack', { url: 'x' });
    expect(res.status).toBe(400);
  });

  it('rejects unsupported event types', async () => {
    const { app } = makeApp();
    const res = await request(app, 'POST', '/subscriptions/slack', {
      url: 'https://hooks.slack.com/xxx',
      eventTypes: ['invalid_type'],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('unsupported_event_types');
  });

  it('lists subscriptions', async () => {
    const { app, store } = makeApp();
    store.set('slk_1', { id: 'slk_1', url: 'https://hooks.slack.com/a', eventTypes: ['invoice.submitted'] });
    store.set('slk_2', { id: 'slk_2', url: 'https://hooks.slack.com/b', eventTypes: ['invoice.paid'] });

    const res = await request(app, 'GET', '/subscriptions/slack');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('deletes a subscription', async () => {
    const { app, store } = makeApp();
    store.set('slk_1', { id: 'slk_1', url: 'https://hooks.slack.com/x', eventTypes: ['invoice.submitted'] });

    const res = await request(app, 'DELETE', '/subscriptions/slack/slk_1');
    expect(res.status).toBe(204);
  });

  it('returns 404 for deleting unknown subscription', async () => {
    const { app } = makeApp();
    const res = await request(app, 'DELETE', '/subscriptions/slack/nope');
    expect(res.status).toBe(404);
  });

  it('notifies matching subscriptions', async () => {
    const { app, store, httpClient } = makeApp();
    store.set('slk_1', { id: 'slk_1', url: 'https://hooks.slack.com/a', eventTypes: ['invoice.submitted'] });
    store.set('slk_2', { id: 'slk_2', url: 'https://hooks.slack.com/b', eventTypes: ['invoice.paid'] });

    const res = await request(app, 'POST', '/notify/slack', {
      type: 'invoice.submitted',
      invoiceId: 42,
      token: 'USDC',
      amount: '10000000',
      dueDate: Math.floor(Date.now() / 1000) + 86400,
    });
    expect(res.status).toBe(200);
    expect(res.body.delivered).toBe(0);
    expect(res.body.total).toBe(1);
    expect(httpClient).toHaveBeenCalledTimes(1);
  });
});
