import { Router } from 'express';
import type { EmailDeliveryService } from '../delivery/emailDelivery.js';
import type { EmailSubscriptionStore } from '../subscriptions/emailSubscriptionStore.js';
export interface EmailNotificationsRouterOptions {
    tokenSecret: string;
    publicUrl: string;
    now?: () => number;
    unsubscribeTtlMs?: number;
}
export declare function createEmailNotificationsRouter(store: EmailSubscriptionStore, delivery: EmailDeliveryService, options: EmailNotificationsRouterOptions): Router;
