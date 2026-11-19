import Database from 'better-sqlite3';

export interface Subscription {
  id: string;
  endpointId: string;
  url: string;
  secret: string;
  eventTypes: string[];
  createdAt: number;
}

export interface SubscriptionInput {
  endpointId: string;
  url: string;
  secret: string;
  eventTypes: string[];
}

export class SubscriptionStore {
  constructor(private readonly db: Database.Database = new Database(':memory:')) {
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        endpoint_id TEXT NOT NULL,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        event_types TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_subscriptions_endpoint
        ON subscriptions(endpoint_id);
    `);
  }

  create(input: SubscriptionInput): Subscription {
    const id = `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO subscriptions (id, endpoint_id, url, secret, event_types, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, input.endpointId, input.url, input.secret, JSON.stringify(input.eventTypes), now);

    return {
      id,
      endpointId: input.endpointId,
      url: input.url,
      secret: input.secret,
      eventTypes: input.eventTypes,
      createdAt: now,
    };
  }

  get(id: string): Subscription | undefined {
    const stmt = this.db.prepare(`
      SELECT id, endpoint_id, url, secret, event_types, created_at
      FROM subscriptions
      WHERE id = ?
    `);

    const row = stmt.get(id) as any;
    return row ? this.rowToSub(row) : undefined;
  }

  list(): Subscription[] {
    const stmt = this.db.prepare(`
      SELECT id, endpoint_id, url, secret, event_types, created_at
      FROM subscriptions
      ORDER BY created_at DESC
    `);

    const rows = stmt.all() as any[];
    return rows.map((r) => this.rowToSub(r));
  }

  update(id: string, patch: Partial<SubscriptionInput>): Subscription | undefined {
    const sub = this.get(id);
    if (!sub) return undefined;

    const updated = {
      ...sub,
      ...patch,
    };

    const stmt = this.db.prepare(`
      UPDATE subscriptions
      SET endpoint_id = ?, url = ?, secret = ?, event_types = ?
      WHERE id = ?
    `);

    stmt.run(updated.endpointId, updated.url, updated.secret, JSON.stringify(updated.eventTypes), id);

    return updated;
  }

  delete(id: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM subscriptions WHERE id = ?`);
    const result = stmt.run(id);
    return (result.changes ?? 0) > 0;
  }

  private rowToSub(row: any): Subscription {
    return {
      id: row.id,
      endpointId: row.endpoint_id,
      url: row.url,
      secret: row.secret,
      eventTypes: JSON.parse(row.event_types),
      createdAt: row.created_at,
    };
  }
}
