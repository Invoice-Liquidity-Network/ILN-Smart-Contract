import { Router } from 'express';
import type { WebhookDeliveryService } from '../delivery/webhookDelivery.js';
import type { SubscriptionStore } from '../subscriptions/subscriptionStore.js';
import type { DeliveryHistoryStore } from '../delivery/deliveryHistory.js';
interface WebhookDeliveryOptions {
    http?: (url: string, init: any) => Promise<{
        status: number;
    }>;
}
export declare function createWebhooksRouter(store: SubscriptionStore, delivery: WebhookDeliveryService, optsOrHistoryStore?: WebhookDeliveryOptions | DeliveryHistoryStore, historyStore?: DeliveryHistoryStore): Router;
export {};
