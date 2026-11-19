import { createSubscriptionTokenService } from '../subscriptions/emailToken.js';
import { buildInvoiceDisputedEmail, buildInvoiceExpiringSoonEmail, buildInvoiceFundedEmail, buildInvoicePaidEmail, } from '../templates/index.js';
const DEFAULT_UNSUBSCRIBE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
export function resolveRecipientAddresses(event) {
    return [
        ...new Set([event.address, event.freelancer, event.payer, event.funder]
            .filter(isNonEmptyString)
            .map((value) => value.trim())),
    ];
}
export function buildNotificationEmailMessage(subscription, event, options) {
    const unsubscribeUrl = buildUnsubscribeUrl(subscription, options);
    const baseInput = {
        invoiceId: event.invoiceId,
        token: event.token,
        amount: event.amount,
        dueDate: event.dueDate,
        recipientAddress: subscription.address,
        freelancer: event.freelancer,
        payer: event.payer,
        funder: event.funder,
        invoiceUrl: event.invoiceUrl,
        unsubscribeUrl,
    };
    const content = buildContent(event, baseInput, options);
    return {
        to: subscription.email,
        subject: content.subject,
        html: content.html,
        text: content.text,
    };
}
export async function sendNotificationEmail(delivery, subscription, event, options) {
    return delivery.send(buildNotificationEmailMessage(subscription, event, options));
}
export async function sendNotificationEmails(delivery, subscriptions, event, options) {
    let delivered = 0;
    let failed = 0;
    for (const subscription of subscriptions) {
        const result = await sendNotificationEmail(delivery, subscription, event, options);
        if (result.ok) {
            delivered += 1;
        }
        else {
            failed += 1;
        }
    }
    return {
        delivered,
        failed,
        total: subscriptions.length,
    };
}
export function buildUnsubscribeUrl(subscription, options) {
    const tokenService = createSubscriptionTokenService({
        secret: options.tokenSecret,
        now: options.now,
    });
    const token = tokenService.sign({
        purpose: 'unsubscribe',
        subscriptionId: subscription.id,
        address: subscription.address,
        email: subscription.email,
        ttlMs: options.unsubscribeTtlMs ?? DEFAULT_UNSUBSCRIBE_TTL_MS,
    });
    const url = new URL('/subscriptions/email', normalizePublicUrl(options.publicUrl));
    url.searchParams.set('token', token);
    return url.toString();
}
function buildContent(event, baseInput, options) {
    if (event.type === 'invoice.expiring_soon') {
        const reminderInput = {
            ...baseInput,
            reminderHours: resolveReminderHours(event, options),
            now: options.now?.() ?? Date.now(),
        };
        return buildInvoiceExpiringSoonEmail(reminderInput);
    }
    switch (event.type) {
        case 'invoice.funded':
            return buildInvoiceFundedEmail(baseInput);
        case 'invoice.paid':
            return buildInvoicePaidEmail(baseInput);
        case 'invoice.disputed':
            return buildInvoiceDisputedEmail(baseInput);
        default: {
            const exhaustive = event.type;
            throw new Error(`Unsupported email event type: ${exhaustive}`);
        }
    }
}
function resolveReminderHours(event, options) {
    const now = options.now?.() ?? Date.now();
    const remainingHours = Math.round((event.dueDate * 1000 - now) / (60 * 60 * 1000));
    return remainingHours > 48 ? 72 : 24;
}
function normalizePublicUrl(publicUrl) {
    const trimmed = publicUrl.trim();
    if (!trimmed) {
        return 'http://localhost:3001';
    }
    try {
        return new URL(trimmed).toString().replace(/\/$/, '');
    }
    catch {
        return 'http://localhost:3001';
    }
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
