import { Router } from 'express';
import { resolveRecipientAddresses, sendNotificationEmails, } from '../delivery/email.js';
const VALID_EMAIL_EVENTS = new Set([
    'invoice.funded',
    'invoice.paid',
    'invoice.expiring_soon',
    'invoice.disputed',
]);
export function createEmailNotificationsRouter(store, delivery, options) {
    const router = Router();
    router.post('/notify/email', async (req, res) => {
        const event = req.body;
        if (!isValidEmailEvent(event)) {
            res.status(400).json({ error: 'invalid_event_body' });
            return;
        }
        const recipients = new Set(resolveRecipientAddresses(event));
        if (recipients.size === 0) {
            res.status(400).json({ error: 'missing_recipient_address' });
            return;
        }
        const subscriptions = store
            .list()
            .filter((subscription) => subscription.status === 'active' &&
            subscription.eventTypes.includes(event.type) &&
            recipients.has(subscription.address));
        if (subscriptions.length === 0) {
            res.json({ delivered: 0, failed: 0, total: 0 });
            return;
        }
        const result = await sendNotificationEmails(delivery, subscriptions, event, {
            publicUrl: options.publicUrl,
            tokenSecret: options.tokenSecret,
            now: options.now,
            unsubscribeTtlMs: options.unsubscribeTtlMs,
        });
        res.json(result);
    });
    return router;
}
function isValidEmailEvent(value) {
    if (!value) {
        return false;
    }
    return (isValidEventType(value.type) &&
        isPositiveNumber(value.invoiceId) &&
        isNonEmptyString(value.token) &&
        isNonEmptyString(value.amount) &&
        isPositiveNumber(value.dueDate) &&
        (value.address === undefined || isNonEmptyString(value.address)) &&
        (value.freelancer === undefined || isNonEmptyString(value.freelancer)) &&
        (value.payer === undefined || isNonEmptyString(value.payer)) &&
        (value.funder === undefined || isNonEmptyString(value.funder)) &&
        (value.invoiceUrl === undefined || isNonEmptyString(value.invoiceUrl)));
}
function hasRecipientAddress(value) {
    return [value.address, value.freelancer, value.payer, value.funder].some(isNonEmptyString);
}
function isValidEventType(value) {
    return typeof value === 'string' && VALID_EMAIL_EVENTS.has(value);
}
function isPositiveNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
