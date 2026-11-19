let counter = 0;
function nextId() {
    counter += 1;
    return `del_${Date.now().toString(36)}_${counter}`;
}
export class DeliveryHistoryStore {
    records = new Map();
    byWebhook = new Map();
    add(record) {
        const full = { id: nextId(), ...record };
        this.records.set(full.id, full);
        const ids = this.byWebhook.get(full.webhookId) ?? [];
        ids.push(full.id);
        this.byWebhook.set(full.webhookId, ids);
        return full;
    }
    listByWebhook(webhookId, page, pageSize) {
        const ids = this.byWebhook.get(webhookId) ?? [];
        const total = ids.length;
        const start = (page - 1) * pageSize;
        const pageIds = ids.slice(start, start + pageSize);
        const items = pageIds.map((id) => this.records.get(id)).filter(Boolean);
        return { items, total, page, pageSize };
    }
}
