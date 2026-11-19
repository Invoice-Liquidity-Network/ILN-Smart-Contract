import Database from 'better-sqlite3';
let counter = 0;
function nextId() {
    counter += 1;
    return `eml_${Date.now().toString(36)}_${counter}`;
}
export class EmailSubscriptionStore {
    db;
    constructor(db = new Database(':memory:')) {
        this.db = db;
        this.initSchema();
    }
    initSchema() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS email_subscriptions (
        id TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        email TEXT NOT NULL,
        event_types TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        consent_at INTEGER,
        verification_sent_at INTEGER NOT NULL,
        unsubscribed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_email_subscriptions_email
        ON email_subscriptions(email);

      CREATE INDEX IF NOT EXISTS idx_email_subscriptions_address
        ON email_subscriptions(address);

      CREATE INDEX IF NOT EXISTS idx_email_subscriptions_status
        ON email_subscriptions(status);
    `);
    }
    create(input) {
        const id = nextId();
        const now = Date.now();
        this.db.prepare(`
      INSERT INTO email_subscriptions (
        id, address, email, event_types, status,
        consent_at, verification_sent_at, unsubscribed_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.address, input.email, JSON.stringify(input.eventTypes), 'pending', null, now, null, now, now);
        return this.get(id);
    }
    get(id) {
        const row = this.db.prepare(`
      SELECT
        id, address, email, event_types, status, consent_at,
        verification_sent_at, unsubscribed_at, created_at, updated_at
      FROM email_subscriptions
      WHERE id = ?
    `).get(id);
        return row ? this.rowToSubscription(row) : undefined;
    }
    list() {
        const rows = this.db.prepare(`
      SELECT
        id, address, email, event_types, status, consent_at,
        verification_sent_at, unsubscribed_at, created_at, updated_at
      FROM email_subscriptions
      ORDER BY created_at DESC
    `).all();
        return rows.map((row) => this.rowToSubscription(row));
    }
    activate(id, consentAt = Date.now()) {
        const current = this.get(id);
        if (!current) {
            return undefined;
        }
        if (current.status === 'unsubscribed') {
            return current;
        }
        const nextConsentAt = current.consentAt ?? consentAt;
        this.db.prepare(`
      UPDATE email_subscriptions
      SET status = 'active',
          consent_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(nextConsentAt, Date.now(), id);
        return this.get(id);
    }
    unsubscribe(id, unsubscribedAt = Date.now()) {
        const current = this.get(id);
        if (!current) {
            return undefined;
        }
        this.db.prepare(`
      UPDATE email_subscriptions
      SET status = 'unsubscribed',
          unsubscribed_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(unsubscribedAt, Date.now(), id);
        return this.get(id);
    }
    rowToSubscription(row) {
        return {
            id: row.id,
            address: row.address,
            email: row.email,
            eventTypes: JSON.parse(row.event_types),
            status: row.status,
            consentAt: row.consent_at ?? null,
            verificationSentAt: row.verification_sent_at,
            unsubscribedAt: row.unsubscribed_at ?? null,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }
}
