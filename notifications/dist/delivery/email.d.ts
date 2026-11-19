import type { EmailDeliveryResult, EmailDeliveryService, EmailMessage } from './emailDelivery.js';
import type { EmailSubscription } from '../subscriptions/emailSubscriptionStore.js';
export type InvoiceEmailEventType = 'invoice.funded' | 'invoice.paid' | 'invoice.expiring_soon' | 'invoice.disputed';
export interface InvoiceEmailEvent {
    type: InvoiceEmailEventType;
    invoiceId: number;
    token: 'USDC' | 'EURC' | 'XLM';
    amount: string;
    dueDate: number;
    address?: string;
    freelancer?: string;
    payer?: string;
    funder?: string;
    invoiceUrl?: string;
}
export interface EmailNotificationOptions {
    publicUrl: string;
    tokenSecret: string;
    unsubscribeTtlMs?: number;
    now?: () => number;
}
export interface DeliveredEmailResult {
    delivered: number;
    failed: number;
    total: number;
}
export declare function resolveRecipientAddresses(event: InvoiceEmailEvent): string[];
export declare function buildNotificationEmailMessage(subscription: EmailSubscription, event: InvoiceEmailEvent, options: EmailNotificationOptions): EmailMessage;
export declare function sendNotificationEmail(delivery: EmailDeliveryService, subscription: EmailSubscription, event: InvoiceEmailEvent, options: EmailNotificationOptions): Promise<EmailDeliveryResult>;
export declare function sendNotificationEmails(delivery: EmailDeliveryService, subscriptions: EmailSubscription[], event: InvoiceEmailEvent, options: EmailNotificationOptions): Promise<DeliveredEmailResult>;
export declare function buildUnsubscribeUrl(subscription: EmailSubscription, options: EmailNotificationOptions): string;
