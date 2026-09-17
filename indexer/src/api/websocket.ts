import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';

export interface IndexedEvent {
  type: string;
  address?: string;
  invoiceId?: number;
  data?: unknown;
  ledger?: number;
  timestamp?: number;
}

export interface SubscriptionFilter {
  types?: string[];
  address?: string;
}

export interface WsEndpointOptions {
  path?: string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  maxConnections?: number;
}

interface ClientState {
  ws: WebSocket;
  filter: SubscriptionFilter | null;
  alive: boolean;
  lastPongAt: number;
}

const DEFAULT_HEARTBEAT_INTERVAL = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT = 30_000;
const DEFAULT_MAX_CONNECTIONS = 1000;

export class EventWebSocketEndpoint {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<ClientState>();
  private readonly heartbeatInterval: number;
  private readonly heartbeatTimeout: number;
  private readonly maxConnections: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(opts: WsEndpointOptions & { server?: Server; noServer?: boolean } = {}) {
    this.heartbeatInterval = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL;
    this.heartbeatTimeout = opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT;
    this.maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.wss = new WebSocketServer({
      server: opts.server,
      path: opts.path ?? '/events',
      noServer: opts.noServer,
    });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  start(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.runHeartbeat(), this.heartbeatInterval);
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
    this.wss.close();
  }

  connectionCount(): number {
    return this.clients.size;
  }

  publish(event: IndexedEvent): number {
    let sent = 0;
    const payload = JSON.stringify({ event });
    for (const client of this.clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      if (!matchesFilter(event, client.filter)) continue;
      client.ws.send(payload);
      sent += 1;
    }
    return sent;
  }

  handleUpgrade(req: Parameters<WebSocketServer['handleUpgrade']>[0], socket: Parameters<WebSocketServer['handleUpgrade']>[1], head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }

  private onConnection(ws: WebSocket): void {
    if (this.clients.size >= this.maxConnections) {
      ws.close(1013, 'max_connections');
      return;
    }
    const state: ClientState = {
      ws,
      filter: null,
      alive: true,
      lastPongAt: Date.now(),
    };
    this.clients.add(state);

    ws.on('message', (raw) => this.onMessage(state, raw.toString()));
    ws.on('pong', () => {
      state.alive = true;
      state.lastPongAt = Date.now();
    });
    ws.on('close', () => this.clients.delete(state));
    ws.on('error', () => this.clients.delete(state));
  }

  private onMessage(state: ClientState, raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      state.ws.send(JSON.stringify({ error: 'invalid_json' }));
      return;
    }
    if (msg && msg.action === 'subscribe') {
      state.filter = normalizeFilter(msg.filter ?? msg);
      state.ws.send(JSON.stringify({ ack: 'subscribed', filter: state.filter }));
      return;
    }
    if (msg && msg.action === 'unsubscribe') {
      state.filter = null;
      state.ws.send(JSON.stringify({ ack: 'unsubscribed' }));
      return;
    }
    if (msg && (msg.types || msg.address)) {
      state.filter = normalizeFilter(msg);
      state.ws.send(JSON.stringify({ ack: 'subscribed', filter: state.filter }));
    }
  }

  private runHeartbeat(): void {
    const now = Date.now();
    for (const client of [...this.clients]) {
      if (!client.alive && now - client.lastPongAt >= this.heartbeatTimeout) {
        client.ws.terminate();
        this.clients.delete(client);
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        this.clients.delete(client);
      }
    }
  }
}

export function normalizeFilter(input: any): SubscriptionFilter {
  const out: SubscriptionFilter = {};
  if (Array.isArray(input?.types)) {
    out.types = input.types.filter((t: unknown) => typeof t === 'string');
  }
  if (typeof input?.address === 'string') {
    out.address = input.address;
  }
  return out;
}

export function matchesFilter(
  event: IndexedEvent,
  filter: SubscriptionFilter | null,
): boolean {
  if (!filter) return true;
  if (filter.types && filter.types.length > 0 && !filter.types.includes(event.type)) {
    return false;
  }
  if (filter.address && event.address && filter.address !== event.address) {
    return false;
  }
  return true;
}
