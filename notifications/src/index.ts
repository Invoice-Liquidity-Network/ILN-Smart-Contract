import express from 'express';
import { config } from './config.js';
import { createNotificationsDatabase } from './database.js';
import { SubscriptionStore } from './subscriptions/subscriptionStore.js';
import { EmailSubscriptionStore } from './subscriptions/emailSubscriptionStore.js';
import { WebhookDeliveryService } from './delivery/webhookDelivery.js';
import { EmailDeliveryService } from './delivery/emailDelivery.js';
import { createEmailClient } from './delivery/emailClient.js';
import { DeliveryHistoryStore } from './delivery/deliveryHistory.js';
import { createWebhooksRouter } from './api/webhooks.js';
import { createSlackRouter } from './api/slack.js';
import { createTelegramRouter } from './api/telegram.js';
import { createEmailSubscriptionsRouter } from './api/email.js';
import { createEmailNotificationsRouter } from './api/emailNotifications.js';
import type { SlackSubscription } from './api/slack.js';
import type { TelegramSubscription } from './api/telegram.js';
import { logger } from './lib/logger.js';
import { createRequestIdMiddleware } from './lib/requestId.js';

const db = createNotificationsDatabase(config.dbPath);
const port = config.port;
const store = new SubscriptionStore(db);
const emailStore = new EmailSubscriptionStore(db);
// Retention policy (Issue #733): bodies are purged before full records so
// recipient PII is not retained indefinitely.
const historyStore = new DeliveryHistoryStore({
  bodyRetentionMs: config.deliveryBodyRetentionMs,
  recordRetentionMs: config.deliveryRecordRetentionMs,
});
const delivery = new WebhookDeliveryService({
  http: async (url, init) => {
    const res = await fetch(url, init);
    return { status: res.status };
  },
  // Structured logging (Issue #776) — carries the request/event correlation id.
  logger: (msg) => logger.info(msg, { component: 'webhook-delivery' }),
  historyStore,
});
const emailDelivery = new EmailDeliveryService(
  createEmailClient({
    apiKey: config.resendApiKey,
    from: config.emailFrom,
    logger: console,
  }),
  config.emailFrom,
);

const slackStore = new Map<string, SlackSubscription>();
const telegramStore = new Map<string, TelegramSubscription>();

const app = express();
// Correlation-ID first so every downstream log line for the request is tagged
// (Issue #776).
app.use(createRequestIdMiddleware());
app.use(express.json());
app.use(createWebhooksRouter(store, delivery, historyStore));
app.use(createSlackRouter(slackStore));
app.use(createTelegramRouter(telegramStore));
app.use(
  createEmailSubscriptionsRouter(emailStore, emailDelivery, {
    tokenSecret: config.emailTokenSecret,
    publicUrl: config.publicUrl,
  })
);
app.use(
  createEmailNotificationsRouter(emailStore, emailDelivery, {
    tokenSecret: config.emailTokenSecret,
    publicUrl: config.publicUrl,
  })
);
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(port, () => {
  logger.info('ILN notifications service listening', { port });
});
