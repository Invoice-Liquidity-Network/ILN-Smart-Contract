import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';

export interface IndexedEvent {
  /** Stable identity (e.g. `<tx-hash>:<event-index>`) used for replay dedupe. */
  id?: string;
  transactionHash?: string;
  eventIndex?: number;
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
  maxConnectionsPerIp?: number;
  /** Number of recent events retained for reconnect replay. Default 500. */
  replayBufferSize?: number;
  /** Per-client send buffer ceiling before events are dropped. Default 1 MiB. */
  maxBufferedBytes?: number;
  /** Maximum accepted client frame size. Default 4 KiB. */
  maxPayloadBytes?: number;
  /** Maximum number of event types accepted in one subscription. Default 100. */
  maxFilterTypes?: number;
  /** Number of recent event identities remembered for duplicate suppression. Default 1000. */
  dedupeWindow?: number;
}

export interface WebSocketStats {
  sequence: number;
  connections: number;
  bufferedEvents: number;
  publishedEvents: number;
  duplicateEvents: number;
  backpressureDrops: number;
  replayedEvents: number;
  rejectedConnections: number;
}

interface ClientState {
  ws: WebSocket;
  filter: SubscriptionFilter | null;
  alive: boolean;
  lastPongAt: number;
  ip: string;
  released: boolean;
  lastSeq: number;
}

interface BufferedEvent {
  seq: number;
  event: IndexedEvent;
}

const DEFAULT_HEARTBEAT_INTERVAL = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT = 30_000;
const DEFAULT_MAX_CONNECTIONS = 1000;
const DEFAULT_MAX_CONNECTIONS_PER_IP = 5;
const DEFAULT_REPLAY_BUFFER_SIZE = 500;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024;
const DEFAULT_MAX_FILTER_TYPES = 100;
const DEFAULT_DEDUPE_WINDOW = 1000;
const MAX_FILTER_TYPE_LENGTH = 128;
const MAX_ADDRESS_LENGTH = 128;

function getIpFromReq(req: IncomingMessage | undefined): string {
  if (!req) return 'unknown';
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor) {
    if (typeof xForwardedFor === 'string') return xForwardedFor.split(',')[0]?.trim() ?? 'unknown';
    if (Array.isArray(xForwardedFor)) {
      return xForwardedFor[0]?.split(',')[0]?.trim() ?? 'unknown';
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function stableStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value, (_key, inner) => {
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        return Object.keys(inner as Record<string, unknown>)
          .sort()
          .reduce<Record<string, unknown>>((sorted, key) => {
            sorted[key] = (inner as Record<string, unknown>)[key];
            return sorted;
          }, {});
      }
      return inner;
    });
  } catch {
    return null;
  }
}

/**
 * Derives a stable identity for duplicate suppression. Events without an
 * explicit id, transaction hash, or ledger are not deduplicated because there
 * is no safe way to distinguish a replay from a legitimately identical event.
 */
export function eventIdentity(event: IndexedEvent): string | null {
  if (typeof event.id === 'string' && event.id.length > 0) return `id:${event.id}`;
  if (typeof event.transactionHash === 'string' && event.transactionHash.length > 0) {
    return `tx:${event.transactionHash}:${event.eventIndex ?? ''}`;
  }
  if (typeof event.ledger === 'number') {
    const data = stableStringify(event.data ?? null);
    if (data === null) return null;
    return `ledger:${event.ledger}:${event.type}:${event.address ?? ''}:${event.invoiceId ?? ''}:${data}`;
  }
  return null;
}

interface FilterValidation {
  filter?: SubscriptionFilter;
  error?: string;
}

export function validateFilter(input: unknown, maxTypes = DEFAULT_MAX_FILTER_TYPES): FilterValidation {
  if (input === undefined || input === null) return { filter: {} };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'filter must be an object' };
  }
  const raw = input as Record<string, unknown>;
  if (raw.types !== undefined) {
    if (!Array.isArray(raw.types)) return { error: 'types must be an array of strings' };
    if (raw.types.length > maxTypes) return { error: `types must contain at most ${maxTypes} entries` };
    for (const type of raw.types) {
      if (typeof type !== 'string') return { error: 'types must be an array of strings' };
      if (type.length === 0 || type.length > MAX_FILTER_TYPE_LENGTH) {
        return { error: `each type must be 1-${MAX_FILTER_TYPE_LENGTH} characters` };
      }
    }
  }
  if (raw.address !== undefined) {
    if (typeof raw.address !== 'string') return { error: 'address must be a string' };
    if (raw.address.length > MAX_ADDRESS_LENGTH) {
      return { error: `address must be at most ${MAX_ADDRESS_LENGTH} characters` };
    }
  }
  return { filter: normalizeFilter(raw, maxTypes) };
}

export class EventWebSocketEndpoint {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<ClientState>();
  private readonly ipCounts = new Map<string, number>();
  private readonly heartbeatInterval: number;
  private readonly heartbeatTimeout: number;
  private readonly maxConnections: number;
  private readonly maxConnectionsPerIp: number;
  private readonly replayBufferSize: number;
  private readonly maxBufferedBytes: number;
  private readonly maxFilterTypes: number;
  private readonly dedupeWindow: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private sequence = 0;
  private replayBuffer: BufferedEvent[] = [];
  private readonly seenEventIdentities = new Map<string, number>();
  private readonly stats = {
    publishedEvents: 0,
    duplicateEvents: 0,
    backpressureDrops: 0,
    replayedEvents: 0,
    rejectedConnections: 0,
  };

  constructor(opts: WsEndpointOptions & { server?: Server; noServer?: boolean } = {}) {
    this.heartbeatInterval = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL;
    this.heartbeatTimeout = opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT;
    this.maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.maxConnectionsPerIp = opts.maxConnectionsPerIp ?? DEFAULT_MAX_CONNECTIONS_PER_IP;
    this.replayBufferSize = Math.max(0, opts.replayBufferSize ?? DEFAULT_REPLAY_BUFFER_SIZE);
    this.maxBufferedBytes = Math.max(0, opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES);
    this.maxFilterTypes = Math.max(1, opts.maxFilterTypes ?? DEFAULT_MAX_FILTER_TYPES);
    this.dedupeWindow = Math.max(0, opts.dedupeWindow ?? DEFAULT_DEDUPE_WINDOW);
    this.wss = new WebSocketServer({
      server: opts.server,
      path: opts.path ?? '/events',
      noServer: opts.noServer,
      maxPayload: opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
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
    this.ipCounts.clear();
    this.replayBuffer = [];
    this.seenEventIdentities.clear();
    this.wss.close();
  }

  connectionCount(): number {
    return this.clients.size;
  }

  getStats(): WebSocketStats {
    return {
      sequence: this.sequence,
      connections: this.clients.size,
      bufferedEvents: this.replayBuffer.length,
      ...this.stats,
    };
  }

  publish(event: IndexedEvent): number {
    const identity = eventIdentity(event);
    if (identity !== null && this.seenEventIdentities.has(identity)) {
      this.stats.duplicateEvents += 1;
      return 0;
    }

    const seq = ++this.sequence;
    if (identity !== null) {
      this.seenEventIdentities.set(identity, seq);
      this.trimDedupeWindow();
    }

    if (this.replayBufferSize > 0) {
      this.replayBuffer.push({ seq, event });
      if (this.replayBuffer.length > this.replayBufferSize) this.replayBuffer.shift();
    }

    const payload = JSON.stringify({ seq, event });
    let sent = 0;
    for (const client of this.clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      if (!matchesFilter(event, client.filter)) continue;
      if (this.sendToClient(client, payload)) sent += 1;
    }
    this.stats.publishedEvents += 1;
    return sent;
  }

  handleUpgrade(req: Parameters<WebSocketServer['handleUpgrade']>[0], socket: Parameters<WebSocketServer['handleUpgrade']>[1], head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }

  private trimDedupeWindow(): void {
    while (this.seenEventIdentities.size > this.dedupeWindow) {
      const oldest = this.seenEventIdentities.keys().next();
      if (oldest.done) return;
      this.seenEventIdentities.delete(oldest.value);
    }
  }

  private sendToClient(client: ClientState, payload: string): boolean {
    if (client.ws.readyState !== WebSocket.OPEN) return false;
    if (client.ws.bufferedAmount > this.maxBufferedBytes) {
      this.stats.backpressureDrops += 1;
      if (client.ws.bufferedAmount > this.maxBufferedBytes * 4) {
        client.ws.close(1013, 'backpressure');
        this.releaseClient(client);
      }
      return false;
    }
    try {
      client.ws.send(payload);
      return true;
    } catch {
      this.releaseClient(client);
      return false;
    }
  }

  private releaseClient(state: ClientState): void {
    if (state.released) return;
    state.released = true;
    this.clients.delete(state);
    const currentCount = this.ipCounts.get(state.ip) ?? 0;
    if (currentCount <= 1) {
      this.ipCounts.delete(state.ip);
    } else {
      this.ipCounts.set(state.ip, currentCount - 1);
    }
  }

  private onConnection(ws: WebSocket, req?: IncomingMessage): void {
    if (this.clients.size >= this.maxConnections) {
      this.stats.rejectedConnections += 1;
      ws.close(1013, 'max_connections');
      return;
    }

    const ip = getIpFromReq(req);
    const count = this.ipCounts.get(ip) || 0;
    if (count >= this.maxConnectionsPerIp) {
      this.stats.rejectedConnections += 1;
      ws.close(1013, 'max_connections_per_ip');
      return;
    }
    this.ipCounts.set(ip, count + 1);

    const state: ClientState = {
      ws,
      filter: null,
      alive: true,
      lastPongAt: Date.now(),
      ip,
      released: false,
      lastSeq: 0,
    };
    this.clients.add(state);

    ws.on('message', (raw) => this.onMessage(state, raw.toString()));
    ws.on('pong', () => {
      state.alive = true;
      state.lastPongAt = Date.now();
    });
    ws.on('close', () => this.releaseClient(state));
    ws.on('error', () => this.releaseClient(state));
  }

  private onMessage(state: ClientState, raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.sendError(state, 'invalid_json');
      return;
    }
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
      this.sendError(state, 'invalid_message');
      return;
    }

    const obj = msg as Record<string, unknown>;
    if (obj.action === 'unsubscribe') {
      state.filter = null;
      state.ws.send(JSON.stringify({ ack: 'unsubscribed' }));
      return;
    }

    if (obj.action === 'subscribe' || (obj.action === undefined && (obj.types !== undefined || obj.address !== undefined))) {
      const rawFilter = obj.action === 'subscribe' ? (obj.filter ?? {}) : obj;
      const validation = validateFilter(rawFilter, this.maxFilterTypes);
      if (validation.error || !validation.filter) {
        this.sendError(state, 'invalid_filter', validation.error);
        return;
      }

      const lastSeq = parseLastSeq(obj.lastSeq);
      state.filter = validation.filter;

      const replay = this.replaySince(lastSeq, validation.filter);
      const ack: Record<string, unknown> = {
        ack: 'subscribed',
        filter: state.filter,
        seq: this.sequence,
      };
      if (replay.unavailable) {
        ack.replayUnavailable = true;
        ack.oldestSeq = replay.oldestSeq;
      } else if (replay.events.length > 0) {
        ack.replayed = replay.events.length;
      }
      state.ws.send(JSON.stringify(ack));

      for (const buffered of replay.events) {
        const payload = JSON.stringify({ seq: buffered.seq, event: buffered.event, replay: true });
        if (this.sendToClient(state, payload)) this.stats.replayedEvents += 1;
      }
      // A re-subscribe without lastSeq continues from the connection's current
      // position rather than replaying events the client already received.
      state.lastSeq = lastSeq ?? state.lastSeq;
      return;
    }

    if (obj.action !== undefined) {
      this.sendError(state, 'unknown_action');
      return;
    }
    this.sendError(state, 'invalid_message');
  }

  private sendError(state: ClientState, code: string, message?: string): void {
    try {
      state.ws.send(JSON.stringify(message ? { error: code, message } : { error: code }));
    } catch {
      this.releaseClient(state);
    }
  }

  private replaySince(
    lastSeq: number | undefined,
    filter: SubscriptionFilter
  ): { events: BufferedEvent[]; unavailable: false; oldestSeq?: never } | { events: []; unavailable: true; oldestSeq: number } {
    if (lastSeq === undefined) return { events: [], unavailable: false };
    const oldestSeq = this.replayBuffer[0]?.seq;
    if (oldestSeq === undefined) {
      return lastSeq < this.sequence
        ? { events: [], unavailable: true, oldestSeq: this.sequence + 1 }
        : { events: [], unavailable: false };
    }
    if (lastSeq < oldestSeq - 1) {
      return { events: [], unavailable: true, oldestSeq };
    }
    return {
      events: this.replayBuffer.filter(
        (buffered) => buffered.seq > lastSeq && matchesFilter(buffered.event, filter)
      ),
      unavailable: false,
    };
  }

  private runHeartbeat(): void {
    const now = Date.now();
    for (const client of [...this.clients]) {
      if (!client.alive && now - client.lastPongAt >= this.heartbeatTimeout) {
        client.ws.terminate();
        this.releaseClient(client);
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        this.releaseClient(client);
      }
    }
  }
}

function parseLastSeq(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

export function normalizeFilter(input: any, maxTypes = DEFAULT_MAX_FILTER_TYPES): SubscriptionFilter {
  const out: SubscriptionFilter = {};
  if (Array.isArray(input?.types)) {
    const seen = new Set<string>();
    for (const value of input.types) {
      if (typeof value !== 'string') continue;
      seen.add(value);
    }
    out.types = [...seen].slice(0, maxTypes);
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
  // An address filter must never match events that carry no address; doing so
  // leaks unrelated events to scoped subscribers.
  if (filter.address && filter.address !== event.address) {
    return false;
  }
  return true;
}
