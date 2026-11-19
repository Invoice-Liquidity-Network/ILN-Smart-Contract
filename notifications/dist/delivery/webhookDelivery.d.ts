import { type CircuitState } from './circuitBreaker.js';
import type { RetryQueue } from '../queue/retryQueue.js';
import type { DeliveryHistoryStore } from './deliveryHistory.js';
export interface WebhookEndpoint {
    id: string;
    url: string;
    secret: string;
}
export interface DeliveryResult {
    ok: boolean;
    status: number;
    skippedReason?: 'circuit_open' | 'rate_limited';
}
export type HttpClient = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body: string;
}) => Promise<{
    status: number;
}>;
export interface WebhookDeliveryOptions {
    http: HttpClient;
    logger?: (msg: string) => void;
    now?: () => number;
    retryQueue?: RetryQueue;
    historyStore?: DeliveryHistoryStore;
}
export interface WebhookPayload {
    event: string;
    invoiceId: number;
    data: unknown;
    timestamp: string;
}
export declare class WebhookDeliveryService {
    private readonly opts;
    private readonly endpoints;
    constructor(opts: WebhookDeliveryOptions);
    getCircuitState(endpointId: string): CircuitState;
    deliver(endpoint: WebhookEndpoint, payload: unknown, eventType?: string): Promise<DeliveryResult>;
    deliverWithRetry(webhookId: string, endpoint: WebhookEndpoint, payload: WebhookPayload): Promise<void>;
    private stateFor;
}
