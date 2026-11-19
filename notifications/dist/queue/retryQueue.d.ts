import type Database from 'better-sqlite3';
export interface DeliveryLog {
    id: number;
    webhookId: string;
    event: string;
    invoiceId: number;
    payload: string;
    status: 'pending' | 'delivered' | 'failed' | 'skipped';
    attempts: number;
    maxAttempts: number;
    nextRetryAt: number;
    lastError?: string;
    createdAt: number;
    updatedAt: number;
}
export declare class RetryQueue {
    private readonly db;
    constructor(db: Database.Database);
    private initSchema;
    enqueue(webhookId: string, event: string, invoiceId: number, payload: unknown): DeliveryLog;
    get(id: number): DeliveryLog | undefined;
    getPending(limit?: number): DeliveryLog[];
    recordSuccess(id: number): void;
    recordFailure(id: number, error: string): void;
    recordSkipped(id: number, reason: string): void;
    private rowToLog;
}
