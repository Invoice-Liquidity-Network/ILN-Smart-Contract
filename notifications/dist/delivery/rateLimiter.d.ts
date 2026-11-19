export interface RateLimiterOptions {
    maxRequests?: number;
    windowMs?: number;
    now?: () => number;
}
export declare class SlidingWindowRateLimiter {
    private readonly timestamps;
    private readonly maxRequests;
    private readonly windowMs;
    private readonly now;
    constructor(opts?: RateLimiterOptions);
    tryConsume(): boolean;
    remaining(): number;
    private prune;
}
