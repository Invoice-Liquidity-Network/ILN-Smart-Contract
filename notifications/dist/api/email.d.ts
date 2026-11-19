import { Router } from 'express';
import type { EmailDeliveryService } from '../delivery/emailDelivery.js';
import type { EmailSubscriptionStore } from '../subscriptions/emailSubscriptionStore.js';
export interface EmailSubscriptionRouterOptions {
    tokenSecret: string;
    publicUrl: string;
    now?: () => number;
    verificationTtlMs?: number;
    unsubscribeTtlMs?: number;
}
export declare function createEmailSubscriptionsRouter(store: EmailSubscriptionStore, delivery: EmailDeliveryService, options: EmailSubscriptionRouterOptions): Router;
