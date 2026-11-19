import Database from 'better-sqlite3';
export type EmailSubscriptionStatus = 'pending' | 'active' | 'unsubscribed';
export interface EmailSubscription {
    id: string;
    address: string;
    email: string;
    eventTypes: string[];
    status: EmailSubscriptionStatus;
    consentAt: number | null;
    verificationSentAt: number;
    unsubscribedAt: number | null;
    createdAt: number;
    updatedAt: number;
}
export interface EmailSubscriptionInput {
    address: string;
    email: string;
    eventTypes: string[];
}
export declare class EmailSubscriptionStore {
    private readonly db;
    constructor(db?: Database.Database);
    private initSchema;
    create(input: EmailSubscriptionInput): EmailSubscription;
    get(id: string): EmailSubscription | undefined;
    list(): EmailSubscription[];
    activate(id: string, consentAt?: number): EmailSubscription | undefined;
    unsubscribe(id: string, unsubscribedAt?: number): EmailSubscription | undefined;
    private rowToSubscription;
}
