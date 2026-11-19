import { Router } from 'express';
async function validateWebhookUrl(url, opts) {
    const httpClient = opts?.http;
    if (!httpClient) {
        try {
            const urlObj = new URL(url);
            if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
                return false;
            }
            return true;
        }
        catch {
            return false;
        }
    }
    try {
        const response = await httpClient(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ test: true }),
        });
        return response.status >= 200 && response.status < 500;
    }
    catch {
        return false;
    }
}
export function createWebhooksRouter(store, delivery, optsOrHistoryStore, historyStore) {
    const router = Router();
    const resolvedHistoryStore = isDeliveryHistoryStore(optsOrHistoryStore)
        ? optsOrHistoryStore
        : historyStore;
    const opts = isDeliveryHistoryStore(optsOrHistoryStore) ? undefined : optsOrHistoryStore;
    function requireAuth(req, res, subId) {
        const sub = store.get(subId);
        if (!sub) {
            res.status(404).json({ error: 'not_found' });
            return false;
        }
        const apiKey = req.headers['x-api-key'];
        if (!apiKey || apiKey !== sub.secret) {
            res.status(401).json({ error: 'unauthorized' });
            return false;
        }
        return true;
    }
    router.get('/webhooks', (_req, res) => {
        const subs = store.list();
        res.json(subs.map((sub) => ({
            id: sub.id,
            url: sub.url,
            eventTypes: sub.eventTypes,
            circuitState: delivery.getCircuitState(sub.endpointId),
            createdAt: sub.createdAt,
        })));
    });
    router.get('/webhooks/:id', (req, res) => {
        const sub = store.get(req.params.id);
        if (!sub) {
            res.status(404).json({ error: 'not_found' });
            return;
        }
        res.json({
            id: sub.id,
            url: sub.url,
            eventTypes: sub.eventTypes,
            circuitState: delivery.getCircuitState(sub.endpointId),
            createdAt: sub.createdAt,
        });
    });
    router.post('/webhooks', async (req, res) => {
        const { url, secret, eventTypes, endpointId } = req.body ?? {};
        if (!url || !secret || !Array.isArray(eventTypes) || eventTypes.length === 0) {
            res.status(400).json({ error: 'invalid_body' });
            return;
        }
        const isValid = await validateWebhookUrl(url, opts);
        if (!isValid) {
            res.status(400).json({ error: 'invalid_url' });
            return;
        }
        const sub = store.create({
            endpointId: endpointId ?? url,
            url,
            secret,
            eventTypes,
        });
        res.status(201).json({
            id: sub.id,
            url: sub.url,
            eventTypes: sub.eventTypes,
            createdAt: sub.createdAt,
        });
    });
    router.put('/webhooks/:id', async (req, res) => {
        const sub = store.get(req.params.id);
        if (!sub) {
            res.status(404).json({ error: 'not_found' });
            return;
        }
        const { url, secret, eventTypes } = req.body ?? {};
        const patch = {};
        if (url !== undefined) {
            const isValid = await validateWebhookUrl(url, opts);
            if (!isValid) {
                res.status(400).json({ error: 'invalid_url' });
                return;
            }
            patch.url = url;
        }
        if (secret !== undefined) {
            patch.secret = secret;
        }
        if (eventTypes !== undefined) {
            if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
                res.status(400).json({ error: 'invalid_body' });
                return;
            }
            patch.eventTypes = eventTypes;
        }
        if (Object.keys(patch).length === 0) {
            res.status(400).json({ error: 'no_changes' });
            return;
        }
        const updated = store.update(req.params.id, patch);
        if (!updated) {
            res.status(404).json({ error: 'not_found' });
            return;
        }
        res.json({
            id: updated.id,
            url: updated.url,
            eventTypes: updated.eventTypes,
            createdAt: updated.createdAt,
        });
    });
    router.delete('/webhooks/:id', (req, res) => {
        const ok = store.delete(req.params.id);
        res.status(ok ? 204 : 404).end();
    });
    if (resolvedHistoryStore) {
        router.get('/webhooks/:id/deliveries', (req, res) => {
            const sub = store.get(req.params.id);
            if (!sub) {
                res.status(404).json({ error: 'not_found' });
                return;
            }
            if (!requireAuth(req, res, req.params.id))
                return;
            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
            const result = resolvedHistoryStore.listByWebhook(sub.endpointId, page, pageSize);
            res.json(result);
        });
    }
    return router;
}
function isDeliveryHistoryStore(value) {
    return typeof value === 'object' && value !== null && 'listByWebhook' in value;
}
