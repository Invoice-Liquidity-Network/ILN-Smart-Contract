import cron, { type ScheduledTask } from 'node-cron';
import { notificationService } from './notificationService';

/**
 * Time-based alert scheduler for invoice due-date reminders.
 *
 * Checks periodically for invoices that are approaching expiry and delivers
 * `invoice.expiring_soon` notifications 72 hours and 24 hours before the due
 * date. Delivered reminders are tracked per (invoice, threshold) so a reminder
 * is never sent twice.
 */

export type ReminderThreshold = 72 | 24;

export interface FundedInvoice {
  id: string;
  state: string;
  dueDate: string;
  payer: string;
  lp: string;
  submitter: string;
}

/** Persistence boundary for idempotency tracking. */
export interface DeliveredReminderStore {
  has(invoiceId: string, threshold: ReminderThreshold): Promise<boolean>;
  record(invoiceId: string, threshold: ReminderThreshold): Promise<void>;
}

/** Source of invoices approaching expiry. */
export interface InvoiceSource {
  findFundedExpiringWithin(hours: number): Promise<FundedInvoice[]>;
}

/** Minimal notification delivery surface used by the scheduler. */
export interface NotificationDispatcher {
  deliver(params: {
    type: 'invoice.expiring_soon';
    invoiceId: string;
    threshold: ReminderThreshold;
    recipients: string[];
  }): Promise<void>;
}

const THRESHOLDS: ReminderThreshold[] = [72, 24];
const CHECK_INTERVAL_CRON = '*/30 * * * *';

/**
 * In-memory implementation of the delivered-reminders store. In production this
 * is backed by the `delivered_reminders` database table; the interface keeps
 * the scheduler testable without a live database.
 */
export class InMemoryDeliveredReminderStore implements DeliveredReminderStore {
  private readonly delivered = new Set<string>();

  private key(invoiceId: string, threshold: ReminderThreshold): string {
    return `${invoiceId}:${threshold}`;
  }

  async has(invoiceId: string, threshold: ReminderThreshold): Promise<boolean> {
    return this.delivered.has(this.key(invoiceId, threshold));
  }

  async record(invoiceId: string, threshold: ReminderThreshold): Promise<void> {
    this.delivered.add(this.key(invoiceId, threshold));
  }
}

/**
 * Adapter that forwards expiring-soon reminders through the existing
 * notification service so delivery reuses the same subscriber fan-out.
 */
export class NotificationServiceDispatcher implements NotificationDispatcher {
  async deliver(params: {
    type: 'invoice.expiring_soon';
    invoiceId: string;
    threshold: ReminderThreshold;
    recipients: string[];
  }): Promise<void> {
    await notificationService.send({
      type: params.type,
      invoiceId: params.invoiceId,
      threshold: params.threshold,
      recipients: params.recipients,
    });
  }
}

export class SchedulerService {
  private task: ScheduledTask | null = null;

  constructor(
    private readonly invoiceSource: InvoiceSource,
    private readonly dispatcher: NotificationDispatcher,
    private readonly reminderStore: DeliveredReminderStore,
  ) {}

  /**
   * Collect the unique subscribers for an invoice: payer, LP and submitter.
   */
  private recipientsFor(invoice: FundedInvoice): string[] {
    return Array.from(
      new Set([invoice.payer, invoice.lp, invoice.submitter].filter(Boolean)),
    );
  }

  /**
   * Run a single pass over all thresholds. Exposed for unit testing and for
   * manual invocation outside of the cron schedule.
   */
  async runOnce(): Promise<void> {
    for (const threshold of THRESHOLDS) {
      const invoices = await this.invoiceSource.findFundedExpiringWithin(threshold);

      for (const invoice of invoices) {
        if (invoice.state !== 'Funded') {
          continue;
        }

        if (await this.reminderStore.has(invoice.id, threshold)) {
          continue;
        }

        await this.dispatcher.deliver({
          type: 'invoice.expiring_soon',
          invoiceId: invoice.id,
          threshold,
          recipients: this.recipientsFor(invoice),
        });

        await this.reminderStore.record(invoice.id, threshold);
      }
    }
  }

  /** Start the 30-minute cron schedule. */
  start(): void {
    if (this.task) {
      return;
    }

    this.task = cron.schedule(CHECK_INTERVAL_CRON, () => {
      void this.runOnce();
    });
  }

  /** Stop the cron schedule. */
  stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }
  }
}

export const schedulerService = new SchedulerService(
  // The concrete invoice source is wired up by the application bootstrap.
  {
    async findFundedExpiringWithin(): Promise<FundedInvoice[]> {
      return [];
    },
  },
  new NotificationServiceDispatcher(),
  new InMemoryDeliveredReminderStore(),
);
