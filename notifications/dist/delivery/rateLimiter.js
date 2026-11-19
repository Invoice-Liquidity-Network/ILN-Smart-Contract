const DEFAULT_MAX = 1000;
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
export class SlidingWindowRateLimiter {
    timestamps = [];
    maxRequests;
    windowMs;
    now;
    constructor(opts = {}) {
        this.maxRequests = opts.maxRequests ?? DEFAULT_MAX;
        this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
        this.now = opts.now ?? Date.now;
    }
    tryConsume() {
        this.prune();
        if (this.timestamps.length >= this.maxRequests)
            return false;
        this.timestamps.push(this.now());
        return true;
    }
    remaining() {
        this.prune();
        return Math.max(0, this.maxRequests - this.timestamps.length);
    }
    prune() {
        const cutoff = this.now() - this.windowMs;
        while (this.timestamps.length && this.timestamps[0] <= cutoff) {
            this.timestamps.shift();
        }
    }
}
