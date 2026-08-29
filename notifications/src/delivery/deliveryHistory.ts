export interface DeliveryRecord {
  id: string;
  webhookId: string;
  eventType: string;
  deliveredAt: number;
  statusCode: number;
  responseBody: string;
  attemptCount: number;
  nextRetryAt: number | null;
}

export interface DeliveryHistoryOptions {
  /**
   * How long a delivery's response body is retained before it is purged.
   * Bodies can embed recipient emails or message content, so they are
   * removed early while delivery metadata is kept for debugging (Issue #733).
   * Defaults to 7 days.
   */
  bodyRetentionMs?: number | undefined;
  /**
   * How long a full delivery record is retained before it is removed
   * entirely. Defaults to 90 days.
   */
  recordRetentionMs?: number | undefined;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: (() => number) | undefined;
}

const DEFAULT_BODY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_RECORD_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

let counter = 0;
function nextId(): string {
  counter += 1;
  return `del_${Date.now().toString(36)}_${counter}`;
}

/**
 * In-memory store of webhook delivery attempts.
 *
 * Retention policy (Issue #733): delivery records are the only place the
 * service retains data derived from notification messages. To keep
 * personally identifiable information (recipient emails, message content
 * echoed back by a destination) out of long-term memory:
 *   - response bodies are purged after `bodyRetentionMs` (default 7 days);
 *   - whole records are removed after `recordRetentionMs` (default 90 days).
 *
 * Purging runs opportunistically on every add/list and can also be invoked
 * directly via {@link purgeExpired} (e.g. from a scheduled job).
 */
export class DeliveryHistoryStore {
  private records = new Map<string, DeliveryRecord>();
  private byWebhook = new Map<string, string[]>();
  private readonly bodyRetentionMs: number;
  private readonly recordRetentionMs: number;
  private readonly now: () => number;

  constructor(opts: DeliveryHistoryOptions = {}) {
    this.bodyRetentionMs = opts.bodyRetentionMs ?? DEFAULT_BODY_RETENTION_MS;
    this.recordRetentionMs = opts.recordRetentionMs ?? DEFAULT_RECORD_RETENTION_MS;
    this.now = opts.now ?? Date.now;
  }

  add(record: Omit<DeliveryRecord, 'id'>): DeliveryRecord {
    this.purgeExpired();
    const full: DeliveryRecord = { id: nextId(), ...record };
    this.records.set(full.id, full);
    const ids = this.byWebhook.get(full.webhookId) ?? [];
    ids.push(full.id);
    this.byWebhook.set(full.webhookId, ids);
    return full;
  }

  listByWebhook(
    webhookId: string,
    page: number,
    pageSize: number,
  ): { items: DeliveryRecord[]; total: number; page: number; pageSize: number } {
    this.purgeExpired();
    const ids = this.byWebhook.get(webhookId) ?? [];
    const total = ids.length;
    const start = (page - 1) * pageSize;
    const pageIds = ids.slice(start, start + pageSize);
    const items = pageIds.map((id) => this.records.get(id)!).filter(Boolean);
    return { items, total, page, pageSize };
  }

  /**
   * Apply the retention policy:
   *  - records older than `recordRetentionMs` are deleted entirely;
   *  - records older than `bodyRetentionMs` (but not yet due for deletion)
   *    have their response body cleared.
   *
   * @param now - Optional override of the current time (tests).
   * @returns The number of records whose retained data was reduced (body
   * purged) or removed entirely.
   */
  purgeExpired(now?: number): number {
    const cutoff = now ?? this.now();
    const bodyCutoff = cutoff - this.bodyRetentionMs;
    const recordCutoff = cutoff - this.recordRetentionMs;
    let purged = 0;

    for (const [id, record] of this.records) {
      if (record.deliveredAt <= recordCutoff) {
        this.deleteRecord(id);
        purged += 1;
      } else if (record.deliveredAt <= bodyCutoff && record.responseBody !== '') {
        record.responseBody = '';
        purged += 1;
      }
    }

    return purged;
  }

  private deleteRecord(id: string): void {
    const record = this.records.get(id);
    if (!record) return;
    this.records.delete(id);
    const ids = this.byWebhook.get(record.webhookId);
    if (ids) {
      const idx = ids.indexOf(id);
      if (idx !== -1) ids.splice(idx, 1);
      if (ids.length === 0) this.byWebhook.delete(record.webhookId);
    }
  }
}
