import { Router } from 'express';
export interface SlackSubscription {
    id: string;
    url: string;
    eventTypes: string[];
}
declare const httpClient: (url: string, body: unknown) => Promise<{
    ok: boolean;
    status: number;
}>;
export interface SlackRouterOptions {
    httpClient?: typeof httpClient;
}
export declare function createSlackRouter(store: Map<string, SlackSubscription>, options?: SlackRouterOptions): Router;
export {};
