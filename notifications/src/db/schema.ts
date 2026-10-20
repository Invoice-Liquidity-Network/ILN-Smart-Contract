import { pgTable, uuid, varchar, timestamp, integer, boolean, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Subscribers who receive notifications for a given wallet address.
 */
export const subscribers = pgTable(
  'subscribers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    address: varchar('address', { length: 56 }).notNull(),
    channel: varchar('channel', { length: 32 }).notNull(),
    endpoint: varchar('endpoint', { length: 512 }).notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    subscribersAddressIdx: index('subscribers_address_idx').on(table.address),
    subscribersAddressChannelIdx: uniqueIndex('subscribers_address_channel_idx').on(
      table.address,
      table.channel,
    ),
  }),
);

/**
 * Notifications that have been queued or delivered to a subscriber.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriberId: uuid('subscriber_id')
      .notNull()
      .references(() => subscribers.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 64 }).notNull(),
    payload: jsonb('payload').notNull(),
    status: varchar('status', { length: 32 }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    notificationsSubscriberIdx: index('notifications_subscriber_idx').on(table.subscriberId),
    notificationsTypeIdx: index('notifications_type_idx').on(table.type),
  }),
);

/**
 * Idempotency ledger for time-based reminders (e.g. invoice.expiring_soon).
 *
 * A row is inserted the first time a reminder is delivered for a given
 * invoice + threshold combination. The unique index on
 * (invoice_id, threshold_hours) guarantees the scheduler never sends the
 * same reminder twice, even across restarts or overlapping cron ticks.
 */
export const deliveredReminders = pgTable(
  'delivered_reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: varchar('invoice_id', { length: 128 }).notNull(),
    thresholdHours: integer('threshold_hours').notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deliveredRemindersInvoiceThresholdIdx: uniqueIndex(
      'delivered_reminders_invoice_threshold_idx',
    ).on(table.invoiceId, table.thresholdHours),
    deliveredRemindersInvoiceIdx: index('delivered_reminders_invoice_idx').on(table.invoiceId),
  }),
);

export type Subscriber = typeof subscribers.$inferSelect;
export type NewSubscriber = typeof subscribers.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type DeliveredReminder = typeof deliveredReminders.$inferSelect;
export type NewDeliveredReminder = typeof deliveredReminders.$inferInsert;
