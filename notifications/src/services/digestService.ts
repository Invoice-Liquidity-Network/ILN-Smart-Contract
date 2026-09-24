/**
 * DigestService — batches notification events into time-windowed digests
 * before dispatching to the delivery layer.
 *
 * Instead of delivering every event individually, events for the same
 * subscriber are accumulated over a configurable window and dispatched
 * as a single combined payload, reducing downstream load for high-volume
 * subscribers (#874).
 */

export interface DigestConfig {
  /** Window in milliseconds to accumulate events before flushing. */
  windowMs: number;
  /** Maximum events per digest before forced flush. */
  maxBatchSize: number;
}

export interface DigestEvent {
  subscriberId: string;
  eventType: string;
  invoiceId: number;
  payload: unknown;
  timestamp: number;
}

export interface DigestBatch {
  subscriberId: string;
  events: DigestEvent[];
  flushedAt: number;
}

export type DigestFlushHandler = (batch: DigestBatch) => Promise<void>;

const DEFAULT_CONFIG: DigestConfig = {
  windowMs: 30_000,
  maxBatchSize: 50,
};

export class DigestService {
  private readonly buffers = new Map<string, DigestEvent[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly config: DigestConfig;

  constructor(
    private readonly flushHandler: DigestFlushHandler,
    config?: Partial<DigestConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Enqueue an event for batching. If the batch reaches `maxBatchSize`,
   * it is flushed immediately regardless of the window timer.
   */
  async enqueue(event: DigestEvent): Promise<void> {
    const buffer = this.buffers.get(event.subscriberId) ?? [];
    buffer.push(event);
    this.buffers.set(event.subscriberId, buffer);

    if (buffer.length >= this.config.maxBatchSize) {
      await this.flush(event.subscriberId);
      return;
    }

    if (!this.timers.has(event.subscriberId)) {
      const timer = setTimeout(() => {
        this.flush(event.subscriberId);
      }, this.config.windowMs);
      this.timers.set(event.subscriberId, timer);
    }
  }

  /**
   * Flush all buffered events for a subscriber immediately.
   * Safe to call even if the buffer is empty (no-op).
   */
  async flush(subscriberId: string): Promise<void> {
    const timer = this.timers.get(subscriberId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(subscriberId);
    }

    const events = this.buffers.get(subscriberId);
    if (!events || events.length === 0) {
      this.buffers.delete(subscriberId);
      return;
    }

    this.buffers.delete(subscriberId);

    const batch: DigestBatch = {
      subscriberId,
      events: [...events],
      flushedAt: Date.now(),
    };

    await this.flushHandler(batch);
  }

  /** Flush all pending batches across all subscribers. */
  async flushAll(): Promise<void> {
    const subscriberIds = [...this.buffers.keys()];
    for (const id of subscriberIds) {
      await this.flush(id);
    }
  }

  /** Number of subscribers with pending (unflushed) events. */
  get pendingCount(): number {
    return this.buffers.size;
  }

  /** Number of buffered events for a specific subscriber. */
  bufferedCount(subscriberId: string): number {
    return this.buffers.get(subscriberId)?.length ?? 0;
  }

  /** Cancel all pending timers and flush remaining events. */
  async shutdown(): Promise<void> {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    await this.flushAll();
  }
}
