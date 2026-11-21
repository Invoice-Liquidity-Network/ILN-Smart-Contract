import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import {
  EventWebSocketEndpoint,
  eventIdentity,
  matchesFilter,
  normalizeFilter,
  validateFilter,
} from '../src/api/websocket';

function waitFor<T>(emitter: any, event: string): Promise<T> {
  return new Promise((resolve) => emitter.once(event, resolve));
}

describe('websocket endpoint', () => {
  let httpServer: Server;
  let endpoint: EventWebSocketEndpoint;
  let port: number;

  beforeEach(async () => {
    httpServer = createServer();
    endpoint = new EventWebSocketEndpoint({
      server: httpServer,
      path: '/events',
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 150,
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as AddressInfo).port;
    endpoint.start();
  });

  afterEach(async () => {
    endpoint.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('delivers events matching subscription filter', async () => {
    const client = new WebSocket(`ws://localhost:${port}/events`);
    await waitFor(client, 'open');
    client.send(JSON.stringify({ action: 'subscribe', filter: { types: ['InvoiceFunded'] } }));
    await new Promise((r) => setTimeout(r, 20));

    const received: any[] = [];
    client.on('message', (raw) => received.push(JSON.parse(raw.toString())));

    endpoint.publish({ type: 'InvoiceFunded', invoiceId: 1 });
    endpoint.publish({ type: 'InvoicePaid', invoiceId: 2 });
    await new Promise((r) => setTimeout(r, 30));

    const events = received.filter((m) => m.event);
    expect(events).toHaveLength(1);
    expect(events[0].event.type).toBe('InvoiceFunded');
    client.close();
  });

  it('filters by address when subscribed with one', async () => {
    const client = new WebSocket(`ws://localhost:${port}/events`);
    await waitFor(client, 'open');
    client.send(
      JSON.stringify({ action: 'subscribe', filter: { types: ['InvoicePaid'], address: 'GABC' } }),
    );
    await new Promise((r) => setTimeout(r, 20));

    const received: any[] = [];
    client.on('message', (raw) => received.push(JSON.parse(raw.toString())));

    endpoint.publish({ type: 'InvoicePaid', address: 'GXYZ' });
    endpoint.publish({ type: 'InvoicePaid', address: 'GABC' });
    await new Promise((r) => setTimeout(r, 30));

    const events = received.filter((m) => m.event);
    expect(events).toHaveLength(1);
    expect(events[0].event.address).toBe('GABC');
    client.close();
  });

  it('terminates clients that do not respond to heartbeat', async () => {
    const client = new WebSocket(`ws://localhost:${port}/events`);
    await waitFor(client, 'open');
    (client as any)._receiver.removeAllListeners('ping');
    client.on('ping', () => {
      /* swallow */
    });
    expect(endpoint.connectionCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 400));
    expect(endpoint.connectionCount()).toBe(0);
  });

  it('refuses to deliver address-scoped events that have no address', async () => {
    const client = new WebSocket(`ws://localhost:${port}/events`);
    await waitFor(client, 'open');
    client.send(JSON.stringify({ action: 'subscribe', filter: { address: 'GABC' } }));
    await new Promise((r) => setTimeout(r, 20));

    const received: any[] = [];
    client.on('message', (raw) => received.push(JSON.parse(raw.toString())));

    endpoint.publish({ type: 'InvoicePaid', invoiceId: 1 });
    endpoint.publish({ type: 'InvoicePaid', address: 'GABC', invoiceId: 2 });
    await new Promise((r) => setTimeout(r, 30));

    const events = received.filter((m) => m.event);
    expect(events).toHaveLength(1);
    expect(events[0].event.invoiceId).toBe(2);
    client.close();
  });

  it('reports malformed client messages without dropping the connection', async () => {
    const client = new WebSocket(`ws://localhost:${port}/events`);
    await waitFor(client, 'open');
    const received: any[] = [];
    client.on('message', (raw) => received.push(JSON.parse(raw.toString())));

    client.send('{not json');
    client.send(JSON.stringify([1, 2, 3]));
    client.send(JSON.stringify({ action: 'subscribe', filter: { types: ['A', 7] } }));
    client.send(
      JSON.stringify({
        action: 'subscribe',
        filter: { types: Array.from({ length: 101 }, (_, i) => `T${i}`) },
      }),
    );
    await new Promise((r) => setTimeout(r, 40));

    expect(received.map((m) => m.error)).toEqual([
      'invalid_json',
      'invalid_message',
      'invalid_filter',
      'invalid_filter',
    ]);

    client.send(JSON.stringify({ action: 'subscribe', filter: { types: ['InvoicePaid'] } }));
    await new Promise((r) => setTimeout(r, 10));
    endpoint.publish({ type: 'InvoicePaid', invoiceId: 9 });
    await new Promise((r) => setTimeout(r, 20));

    expect(received.filter((m) => m.event)).toHaveLength(1);
    expect(endpoint.connectionCount()).toBe(1);
    client.close();
  });

  it('suppresses duplicate replayed events by stable identity', async () => {
    const client = new WebSocket(`ws://localhost:${port}/events`);
    await waitFor(client, 'open');
    const received: any[] = [];
    client.on('message', (raw) => received.push(JSON.parse(raw.toString())));
    client.send(JSON.stringify({ action: 'subscribe' }));

    const event = {
      id: 'tx-1:0',
      transactionHash: 'tx-1',
      eventIndex: 0,
      type: 'InvoicePaid',
      invoiceId: 1,
    };
    expect(endpoint.publish(event)).toBe(1);
    expect(endpoint.publish(event)).toBe(0);
    await new Promise((r) => setTimeout(r, 20));

    expect(received.filter((m) => m.event)).toHaveLength(1);
    expect(endpoint.getStats().duplicateEvents).toBe(1);
    client.close();
  });

  it('replays only events after lastSeq and never duplicates live ones', async () => {
    endpoint.publish({ id: 'tx-1:0', type: 'InvoicePaid', invoiceId: 1 });
    endpoint.publish({ id: 'tx-2:0', type: 'InvoiceSubmitted', invoiceId: 2 });
    const lastSeq = endpoint.getStats().sequence - 1;

    const client = new WebSocket(`ws://localhost:${port}/events`);
    await waitFor(client, 'open');
    const received: any[] = [];
    client.on('message', (raw) => received.push(JSON.parse(raw.toString())));
    client.send(JSON.stringify({ action: 'subscribe', lastSeq }));
    await new Promise((r) => setTimeout(r, 30));

    const replayed = received.filter((m) => m.replay);
    expect(replayed).toHaveLength(1);
    expect(replayed[0].event.invoiceId).toBe(2);

    expect(endpoint.publish({ id: 'tx-1:0', type: 'InvoicePaid', invoiceId: 1 })).toBe(0);
    endpoint.publish({ id: 'tx-3:0', type: 'InvoicePaid', invoiceId: 3 });
    await new Promise((r) => setTimeout(r, 20));

    const live = received.filter((m) => m.event && !m.replay);
    expect(live).toHaveLength(1);
    expect(live[0].event.invoiceId).toBe(3);
    client.close();
  });

  it('drops events and terminates clients that exceed the send buffer', async () => {
    const client = new WebSocket(`ws://localhost:${port}/events`);
    await waitFor(client, 'open');
    client.send(JSON.stringify({ action: 'subscribe' }));
    await new Promise((r) => setTimeout(r, 20));

    const state = [...(endpoint as any).clients][0];
    Object.defineProperty(state.ws, 'bufferedAmount', {
      configurable: true,
      value: 10 * 1024 * 1024,
    });

    expect(endpoint.publish({ type: 'InvoicePaid', invoiceId: 1 })).toBe(0);
    expect(endpoint.getStats().backpressureDrops).toBe(1);
    expect(endpoint.connectionCount()).toBe(0);
    client.close();
  });

  it('allows a new connection after a previous one disconnects', async () => {
    const limitedServer = createServer();
    const limited = new EventWebSocketEndpoint({
      server: limitedServer,
      path: '/limited',
      maxConnectionsPerIp: 1,
    });
    await new Promise<void>((resolve) => limitedServer.listen(0, resolve));
    const limitedPort = (limitedServer.address() as AddressInfo).port;

    const first = new WebSocket(`ws://localhost:${limitedPort}/limited`);
    await waitFor(first, 'open');
    const closed = waitFor(first, 'close');
    first.close();
    await closed;
    await new Promise((r) => setTimeout(r, 20));

    const second = new WebSocket(`ws://localhost:${limitedPort}/limited`);
    const code = await new Promise<number>((resolve) => {
      second.on('open', () => resolve(1000));
      second.on('close', (c) => resolve(c));
    });
    expect(code).toBe(1000);
    second.close();
    limited.stop();
    await new Promise<void>((resolve) => limitedServer.close(() => resolve()));
  });

  it('rejects connections over maxConnectionsPerIp', async () => {
    const clients: WebSocket[] = [];
    let rejected = false;

    for (let i = 0; i < 6; i++) {
      const client = new WebSocket(`ws://localhost:${port}/events`);
      clients.push(client);

      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        client.on('open', done);
        client.on('close', (code, reason) => {
          if (code === 1013 && reason.toString() === 'max_connections_per_ip') {
            rejected = true;
          }
          done();
        });
        client.on('error', done);
      });
    }

    // Give the server a tick to finish closing the over-limit socket.
    await new Promise((r) => setTimeout(r, 50));
    expect(rejected).toBe(true);
    for (const c of clients) c.close();
  });
});
describe('filter helpers', () => {
  it('normalizeFilter strips invalid types', () => {
    const f = normalizeFilter({ types: ['A', 1, 'B'], address: 'G1' });
    expect(f.types).toEqual(['A', 'B']);
    expect(f.address).toBe('G1');
  });

  it('matchesFilter returns true when filter null', () => {
    expect(matchesFilter({ type: 'X' }, null)).toBe(true);
  });

  it('matchesFilter rejects mismatched type', () => {
    expect(matchesFilter({ type: 'X' }, { types: ['Y'] })).toBe(false);
  });

  it('matchesFilter rejects events without an address when one is required', () => {
    expect(matchesFilter({ type: 'X' }, { address: 'GABC' })).toBe(false);
  });

  it('validateFilter rejects oversized and non-string filters', () => {
    expect(validateFilter({ types: ['A', 1] }).error).toBeDefined();
    expect(validateFilter({ types: Array.from({ length: 101 }, () => 'T') }).error).toBeDefined();
    expect(validateFilter({ address: 123 }).error).toBeDefined();
    expect(validateFilter({ types: ['A', 'A'] }).filter?.types).toEqual(['A']);
  });

  it('eventIdentity prefers ids and never deduplicates events without a position', () => {
    expect(eventIdentity({ id: 'a', type: 'X' })).toBe('id:a');
    expect(eventIdentity({ transactionHash: 'tx', eventIndex: 2, type: 'X' })).toBe('tx:tx:2');
    expect(eventIdentity({ type: 'Heartbeat' })).toBeNull();
    expect(eventIdentity({ ledger: 5, type: 'X', data: { b: 2, a: 1 } })).toBe(
      eventIdentity({ ledger: 5, type: 'X', data: { a: 1, b: 2 } }),
    );
  });
});
