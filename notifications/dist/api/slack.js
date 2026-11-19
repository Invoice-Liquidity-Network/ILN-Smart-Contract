import { Router } from 'express';
import { deliverSlackNotification } from '../delivery/slack.js';
let counter = 0;
function nextId() {
    counter += 1;
    return `slk_${Date.now().toString(36)}_${counter}`;
}
const httpClient = async (url, body) => {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status };
};
export function createSlackRouter(store, options = {}) {
    const router = Router();
    const deliveryClient = options.httpClient ?? httpClient;
    router.post('/subscriptions/slack', (req, res) => {
        const { url, eventTypes } = req.body ?? {};
        if (!url || !Array.isArray(eventTypes) || eventTypes.length === 0) {
            res.status(400).json({ error: 'invalid_body' });
            return;
        }
        const validEvents = ['invoice.submitted', 'invoice.funded', 'invoice.paid', 'invoice.expiring_soon'];
        const invalid = eventTypes.filter((t) => !validEvents.includes(t));
        if (invalid.length > 0) {
            res.status(400).json({ error: `unsupported_event_types: ${invalid.join(',')}` });
            return;
        }
        const sub = {
            id: nextId(),
            url,
            eventTypes,
        };
        store.set(sub.id, sub);
        res.status(201).json(sub);
    });
    router.delete('/subscriptions/slack/:id', (req, res) => {
        const ok = store.delete(req.params.id);
        res.status(ok ? 204 : 404).end();
    });
    router.get('/subscriptions/slack', (_req, res) => {
        res.json([...store.values()]);
    });
    router.post('/notify/slack', async (req, res) => {
        const event = req.body;
        if (!event.type || !event.invoiceId || !event.token || !event.amount) {
            res.status(400).json({ error: 'invalid_event_body' });
            return;
        }
        const subscriptions = [...store.values()].filter((s) => s.eventTypes.includes(event.type));
        if (subscriptions.length === 0) {
            res.json({ delivered: 0 });
            return;
        }
        const results = await Promise.allSettled(subscriptions.map((s) => deliverSlackNotification(s.url, event, deliveryClient)));
        const delivered = results.filter((r) => r.status === 'fulfilled' && r.value.ok).length;
        res.json({ delivered, total: subscriptions.length });
    });
    return router;
}
