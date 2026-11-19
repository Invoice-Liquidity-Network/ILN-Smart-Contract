export class EmailDeliveryService {
    client;
    from;
    constructor(client, from) {
        this.client = client;
        this.from = from;
    }
    async send(msg) {
        try {
            const res = await this.client.send(msg);
            return { ok: true, id: res.id };
        }
        catch (err) {
            return {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }
    getFrom() {
        return this.from;
    }
}
