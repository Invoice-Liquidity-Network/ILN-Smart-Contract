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
import { createEmailSubscriptionsRouter } from './api/email.js';
import { createEmailNotificationsRouter } from './api/emailNotifications.js';
const db = createNotificationsDatabase(config.dbPath);
const port = config.port;
const store = new SubscriptionStore(db);
const emailStore = new EmailSubscriptionStore(db);
const historyStore = new DeliveryHistoryStore();
const delivery = new WebhookDeliveryService({
    http: async (url, init) => {
        const res = await fetch(url, init);
        return { status: res.status };
    },
    logger: (msg) => console.log(msg),
    historyStore,
});
const emailDelivery = new EmailDeliveryService(createEmailClient({
    apiKey: config.resendApiKey,
    from: config.emailFrom,
    logger: console,
}), config.emailFrom);
const slackStore = new Map();
const app = express();
app.use(express.json());
app.use(createWebhooksRouter(store, delivery, historyStore));
app.use(createSlackRouter(slackStore));
app.use(createEmailSubscriptionsRouter(emailStore, emailDelivery, {
    tokenSecret: config.emailTokenSecret,
    publicUrl: config.publicUrl,
}));
app.use(createEmailNotificationsRouter(emailStore, emailDelivery, {
    tokenSecret: config.emailTokenSecret,
    publicUrl: config.publicUrl,
}));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.listen(port, () => {
    console.log(`ILN notifications service listening on ${port}`);
});
