export interface DeliveryRecord {
    id: string;
    webhookId: string;
    eventType: string;
    deliveredAt: number;
    statusCode: number;
    responseBody: string;
    attemptCount: number;
    nextRetryAt: number | null;
}
export declare class DeliveryHistoryStore {
    private records;
    private byWebhook;
    add(record: Omit<DeliveryRecord, 'id'>): DeliveryRecord;
    listByWebhook(webhookId: string, page: number, pageSize: number): {
        items: DeliveryRecord[];
        total: number;
        page: number;
        pageSize: number;
    };
}
