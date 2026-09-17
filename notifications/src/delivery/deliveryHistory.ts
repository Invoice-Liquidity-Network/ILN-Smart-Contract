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

let counter = 0;
function nextId(): string {
  counter += 1;
  return `del_${Date.now().toString(36)}_${counter}`;
}

export class DeliveryHistoryStore {
  private records = new Map<string, DeliveryRecord>();
  private byWebhook = new Map<string, string[]>();

  add(record: Omit<DeliveryRecord, 'id'>): DeliveryRecord {
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
    const ids = this.byWebhook.get(webhookId) ?? [];
    const total = ids.length;
    const start = (page - 1) * pageSize;
    const pageIds = ids.slice(start, start + pageSize);
    const items = pageIds.map((id) => this.records.get(id)!).filter(Boolean);
    return { items, total, page, pageSize };
  }
}
