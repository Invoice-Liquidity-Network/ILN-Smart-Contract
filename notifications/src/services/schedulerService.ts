import cron from 'node-cron';
import Database from 'better-sqlite3';
import type { EmailSubscriptionStore } from '../subscriptions/emailSubscriptionStore.js';
import type { EmailDeliveryService } from '../delivery/emailDelivery.js';
import { buildInvoiceExpiringSoonEmail } from '../templates/invoiceExpiringSoon.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReminderThreshold = 72 | 24;

export interface InvoiceRow {
  id: number;
  freelancer: string;
  payer: string;
  token: string;
  amount: string;
  due_date: number;
  status: string;
  funder: string | null;
}

export interface SchedulerOptions {
  /**
   * SQLite database containing the `invoices` table (typically the indexer DB).
   * The scheduler queries this for Funded invoices approaching their due date.
   */
  invoiceDb: Database.Database;

  /**
   * SQLite database used by the notifications service for idempotency tracking.
   * The `delivered_reminders` table is created here on first use.
   */
  notificationsDb: Database.Database;

  /** Store for e-mail subscriptions keyed by Stellar address. */
  emailStore: EmailSubscriptionStore;

  /** Service used to send e-mail notifications. */
  emailDelivery: EmailDeliveryService;

  /** Base URL for unsubscribe links embedded in e-mails. */
  publicUrl: string;

  /** Override the cron expression (default: every 30 minutes). */
  cronExpression?: string;

  /** Inject a custom clock for deterministic testing (returns Unix ms). */
  now?: () => number;

  /** Optional logger callback. */
  logger?: (msg: string) => void;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

/**
 * Idempotency table stored in the notifications DB.
 *
 * Each row represents one delivered reminder so the scheduler never sends the
 * same (invoice_id, threshold_hours) pair twice.
 */
export function initDeliveredRemindersSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivered_reminders (
      invoice_id   INTEGER  NOT NULL,
      threshold_h  INTEGER  NOT NULL,
      delivered_at INTEGER  NOT NULL,
      PRIMARY KEY (invoice_id, threshold_h)
    );

    CREATE INDEX IF NOT EXISTS idx_delivered_reminders_delivered_at
      ON delivered_reminders(delivered_at);
  `);
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * SchedulerService
 *
 * Runs a recurring cron job (default: every 30 minutes) that:
 *  1. Queries the invoice DB for Funded invoices whose due date is within 72 h
 *     or 24 h of the current time.
 *  2. For each matching invoice × threshold pair that has NOT already been
 *     delivered, sends an `invoice.expiring_soon` e-mail to every active
 *     subscriber whose Stellar address matches the invoice's freelancer, payer,
 *     or funder.
 *  3. Records the delivery in `delivered_reminders` so subsequent runs are
 *     no-ops (idempotency).
 */
export class SchedulerService {
  private readonly cronExpression: string;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private task: ReturnType<typeof cron.schedule> | null = null;

  constructor(private readonly opts: SchedulerOptions) {
    this.cronExpression = opts.cronExpression ?? '*/30 * * * *';
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.logger ?? (() => {});

    initDeliveredRemindersSchema(opts.notificationsDb);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Start the cron scheduler. Idempotent – calling start() twice is harmless. */
  start(): void {
    if (this.task) return;
    this.task = cron.schedule(this.cronExpression, () => {
      this.runChecks().catch((err) => {
        this.log(`scheduler_error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    this.log(`scheduler_started cron="${this.cronExpression}"`);
  }

  /** Stop the cron scheduler. */
  stop(): void {
    if (!this.task) return;
    this.task.stop();
    this.task = null;
    this.log('scheduler_stopped');
  }

  /**
   * Execute one check cycle immediately.
   * Useful for testing and for an initial check on service start-up.
   */
  async runChecks(): Promise<void> {
    const nowSec = Math.floor(this.now() / 1000);
    this.log(`scheduler_run nowSec=${nowSec}`);

    const thresholds: ReminderThreshold[] = [72, 24];

    for (const hours of thresholds) {
      const windowStart = nowSec;
      const windowEnd = nowSec + hours * 60 * 60;

      const invoices = this.queryFundedInvoicesDueBetween(windowStart, windowEnd);
      this.log(`scheduler_found threshold=${hours}h count=${invoices.length}`);

      for (const invoice of invoices) {
        await this.processInvoice(invoice, hours);
      }
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Return all Funded invoices whose due_date falls in (windowStart, windowEnd].
   */
  private queryFundedInvoicesDueBetween(
    windowStart: number,
    windowEnd: number,
  ): InvoiceRow[] {
    return this.opts.invoiceDb
      .prepare(
        `SELECT id, freelancer, payer, token, amount, due_date, status, funder
         FROM invoices
         WHERE status = 'Funded'
           AND due_date >  ?
           AND due_date <= ?`,
      )
      .all(windowStart, windowEnd) as InvoiceRow[];
  }

  /**
   * Check idempotency, then send e-mails for one invoice × threshold pair.
   */
  private async processInvoice(
    invoice: InvoiceRow,
    threshold: ReminderThreshold,
  ): Promise<void> {
    if (this.wasAlreadyDelivered(invoice.id, threshold)) {
      this.log(
        `scheduler_skip invoice_id=${invoice.id} threshold=${threshold}h already_delivered`,
      );
      return;
    }

    // Collect the unique Stellar addresses linked to this invoice.
    const addresses = this.invoiceAddresses(invoice);

    // For each address find active e-mail subscribers interested in
    // `invoice.expiring_soon`.
    let sentCount = 0;
    for (const address of addresses) {
      const subs = this.opts.emailStore
        .list()
        .filter(
          (s) =>
            s.address === address &&
            s.status === 'active' &&
            (s.eventTypes.includes('invoice.expiring_soon') ||
              s.eventTypes.includes('*')),
        );

      for (const sub of subs) {
        const unsubscribeUrl = `${this.opts.publicUrl}/email/unsubscribe/${sub.id}`;
        const email = buildInvoiceExpiringSoonEmail({
          invoiceId: invoice.id,
          token: invoice.token,
          amount: invoice.amount,
          dueDate: invoice.due_date,
          recipientAddress: address,
          freelancer: invoice.freelancer,
          payer: invoice.payer,
          funder: invoice.funder ?? undefined,
          reminderHours: threshold,
          unsubscribeUrl,
        });

        const result = await this.opts.emailDelivery.send({
          to: sub.email,
          subject: email.subject,
          html: email.html,
          text: email.text,
        });

        if (result.ok) {
          sentCount += 1;
          this.log(
            `scheduler_email_sent invoice_id=${invoice.id} threshold=${threshold}h to=${sub.email}`,
          );
        } else {
          this.log(
            `scheduler_email_failed invoice_id=${invoice.id} threshold=${threshold}h to=${sub.email} error=${result.error}`,
          );
        }
      }
    }

    // Mark as delivered regardless of individual send results to avoid
    // re-flooding subscribers if partial delivery occurred.
    this.markDelivered(invoice.id, threshold);
    this.log(
      `scheduler_reminder_recorded invoice_id=${invoice.id} threshold=${threshold}h sent=${sentCount}`,
    );
  }

  /** Returns true when a reminder for this (invoice_id, threshold) was already sent. */
  private wasAlreadyDelivered(invoiceId: number, threshold: ReminderThreshold): boolean {
    const row = this.opts.notificationsDb
      .prepare(
        `SELECT 1 FROM delivered_reminders
         WHERE invoice_id = ? AND threshold_h = ?`,
      )
      .get(invoiceId, threshold);
    return row !== undefined;
  }

  /** Persist the idempotency record. */
  private markDelivered(invoiceId: number, threshold: ReminderThreshold): void {
    this.opts.notificationsDb
      .prepare(
        `INSERT OR IGNORE INTO delivered_reminders (invoice_id, threshold_h, delivered_at)
         VALUES (?, ?, ?)`,
      )
      .run(invoiceId, threshold, Math.floor(this.now() / 1000));
  }

  /** Extract the set of unique Stellar addresses relevant to an invoice. */
  private invoiceAddresses(invoice: InvoiceRow): string[] {
    const addresses = new Set<string>();
    if (invoice.freelancer) addresses.add(invoice.freelancer);
    if (invoice.payer) addresses.add(invoice.payer);
    if (invoice.funder) addresses.add(invoice.funder);
    return Array.from(addresses);
  }
}
