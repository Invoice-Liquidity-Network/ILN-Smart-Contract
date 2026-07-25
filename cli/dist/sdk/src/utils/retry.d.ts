/**
 * retry — exponential back-off retry wrapper for transient RPC failures.
 *
 * Stellar RPC endpoints occasionally return transient errors (connection timeouts,
 * 503s). This utility automatically retries operations that should succeed on retry
 * while failing fast on permanent errors (user rejection, validation errors, contract errors).
 */
export interface RetryOptions {
    /** Maximum number of retry attempts (default: 3). */
    maxRetries?: number;
    /** Initial delay in milliseconds (default: 500). */
    initialDelayMs?: number;
    /** Multiplier for exponential back-off (default: 2). */
    backoffMultiplier?: number;
    /** Whether to log retry attempts (default: false). */
    verbose?: boolean;
}
/**
 * Retry an async operation with exponential back-off on transient errors.
 *
 * @param fn - The async function to retry
 * @param options - Retry configuration
 * @returns The result of the function
 * @throws The last error if all retries are exhausted
 *
 * @example
 * ```ts
 * const result = await retry(
 *   () => server.simulateTransaction(tx),
 *   { maxRetries: 3, initialDelayMs: 500, verbose: true }
 * );
 * ```
 */
export declare function retry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T>;
/**
 * Create a retryable version of a function with fixed options.
 *
 * @param fn - The async function to make retryable
 * @param options - Retry configuration
 * @returns A wrapped function that will retry on transient errors
 *
 * @example
 * ```ts
 * const retryableSimulate = withRetry(
 *   (tx: Transaction) => server.simulateTransaction(tx),
 *   { maxRetries: 3 }
 * );
 * const result = await retryableSimulate(tx);
 * ```
 */
export declare function withRetry<T extends (...args: any[]) => Promise<any>>(fn: T, options?: RetryOptions): T;
//# sourceMappingURL=retry.d.ts.map