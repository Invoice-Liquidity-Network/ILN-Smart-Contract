import Database from 'better-sqlite3';
export interface Subscription {
    id: string;
    endpointId: string;
    url: string;
    secret: string;
    eventTypes: string[];
    createdAt: number;
}
export interface SubscriptionInput {
    endpointId: string;
    url: string;
    secret: string;
    eventTypes: string[];
}
export declare class SubscriptionStore {
    private readonly db;
    constructor(db?: Database.Database);
    private initSchema;
    create(input: SubscriptionInput): Subscription;
    get(id: string): Subscription | undefined;
    list(): Subscription[];
    update(id: string, patch: Partial<SubscriptionInput>): Subscription | undefined;
    delete(id: string): boolean;
    private rowToSub;
}
