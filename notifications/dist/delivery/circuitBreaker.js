const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
export class CircuitBreaker {
    state = 'closed';
    consecutiveFailures = 0;
    openedAt = null;
    probeInFlight = false;
    failureThreshold;
    cooldownMs;
    now;
    constructor(opts = {}) {
        this.failureThreshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
        this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
        this.now = opts.now ?? Date.now;
    }
    getState() {
        this.maybeTransitionToHalfOpen();
        return this.state;
    }
    snapshot() {
        this.maybeTransitionToHalfOpen();
        return {
            state: this.state,
            consecutiveFailures: this.consecutiveFailures,
            openedAt: this.openedAt,
        };
    }
    canAttempt() {
        this.maybeTransitionToHalfOpen();
        if (this.state === 'closed')
            return true;
        if (this.state === 'half-open') {
            if (this.probeInFlight)
                return false;
            this.probeInFlight = true;
            return true;
        }
        return false;
    }
    recordSuccess() {
        this.consecutiveFailures = 0;
        this.openedAt = null;
        this.probeInFlight = false;
        this.state = 'closed';
    }
    recordFailure(logger) {
        this.consecutiveFailures += 1;
        if (this.state === 'half-open') {
            this.openCircuit(logger);
            this.probeInFlight = false;
            return;
        }
        if (this.consecutiveFailures >= this.failureThreshold) {
            this.openCircuit(logger);
        }
    }
    openCircuit(logger) {
        if (this.state !== 'open') {
            this.state = 'open';
            this.openedAt = this.now();
            logger?.(`circuit_breaker_open consecutive_failures=${this.consecutiveFailures}`);
        }
    }
    maybeTransitionToHalfOpen() {
        if (this.state !== 'open' || this.openedAt === null)
            return;
        if (this.now() - this.openedAt >= this.cooldownMs) {
            this.state = 'half-open';
            this.probeInFlight = false;
        }
    }
}
