export type CircuitState = 'closed' | 'open' | 'half-open';
export interface CircuitBreakerOptions {
    failureThreshold?: number;
    cooldownMs?: number;
    now?: () => number;
}
export interface CircuitSnapshot {
    state: CircuitState;
    consecutiveFailures: number;
    openedAt: number | null;
}
export declare class CircuitBreaker {
    private state;
    private consecutiveFailures;
    private openedAt;
    private probeInFlight;
    private readonly failureThreshold;
    private readonly cooldownMs;
    private readonly now;
    constructor(opts?: CircuitBreakerOptions);
    getState(): CircuitState;
    snapshot(): CircuitSnapshot;
    canAttempt(): boolean;
    recordSuccess(): void;
    recordFailure(logger?: (msg: string) => void): void;
    private openCircuit;
    private maybeTransitionToHalfOpen;
}
