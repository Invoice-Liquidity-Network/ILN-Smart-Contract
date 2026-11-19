import { CircuitBreaker } from './circuitBreaker.js';
import { SlidingWindowRateLimiter } from './rateLimiter.js';
import { signPayload } from './signature.js';
export class WebhookDeliveryService {
    opts;
    endpoints = new Map();
    constructor(opts) {
        this.opts = opts;
    }
    getCircuitState(endpointId) {
        return this.stateFor(endpointId).breaker.getState();
    }
    async deliver(endpoint, payload, eventType) {
        const state = this.stateFor(endpoint.id);
        if (!state.limiter.tryConsume()) {
            this.opts.logger?.(`webhook_rate_limited endpoint=${endpoint.id}`);
            return { ok: false, status: 429, skippedReason: 'rate_limited' };
        }
        if (!state.breaker.canAttempt()) {
            this.opts.logger?.(`webhook_circuit_open endpoint=${endpoint.id}`);
            return { ok: false, status: 0, skippedReason: 'circuit_open' };
        }
        const body = JSON.stringify(payload);
        const signature = signPayload(endpoint.secret, body);
        let statusCode = 0;
        let responseBody = '';
        try {
            const res = await this.opts.http(endpoint.url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-iln-signature': signature,
                },
                body,
            });
            statusCode = res.status;
            if (res.status >= 200 && res.status < 300) {
                state.breaker.recordSuccess();
            }
            else {
                state.breaker.recordFailure(this.opts.logger);
            }
        }
        catch (err) {
            state.breaker.recordFailure(this.opts.logger);
            statusCode = 0;
            responseBody = err instanceof Error ? err.message : String(err);
        }
        if (this.opts.historyStore && eventType) {
            this.opts.historyStore.add({
                webhookId: endpoint.id,
                eventType,
                deliveredAt: Date.now(),
                statusCode,
                responseBody,
                attemptCount: 1,
                nextRetryAt: statusCode >= 500 ? Date.now() + 60000 : null,
            });
        }
        return {
            ok: statusCode >= 200 && statusCode < 300,
            status: statusCode,
        };
    }
    async deliverWithRetry(webhookId, endpoint, payload) {
        if (!this.opts.retryQueue) {
            this.opts.logger?.('retryQueue not configured');
            return;
        }
        const log = this.opts.retryQueue.enqueue(webhookId, payload.event, payload.invoiceId, payload);
        const result = await this.deliver(endpoint, payload, payload.event);
        if (result.ok) {
            this.opts.retryQueue.recordSuccess(log.id);
            this.opts.logger?.(`webhook_delivered webhook_id=${webhookId} event=${payload.event}`);
        }
        else if (result.skippedReason) {
            this.opts.retryQueue.recordSkipped(log.id, result.skippedReason);
            this.opts.logger?.(`webhook_skipped webhook_id=${webhookId} reason=${result.skippedReason}`);
        }
        else {
            this.opts.retryQueue.recordFailure(log.id, `HTTP ${result.status}`);
            this.opts.logger?.(`webhook_failed webhook_id=${webhookId} attempt=${log.attempts + 1}`);
        }
    }
    stateFor(endpointId) {
        let s = this.endpoints.get(endpointId);
        if (!s) {
            s = {
                breaker: new CircuitBreaker({ now: this.opts.now }),
                limiter: new SlidingWindowRateLimiter({ now: this.opts.now }),
            };
            this.endpoints.set(endpointId, s);
        }
        return s;
    }
}
