"use strict";
/**
 * retry — exponential back-off retry wrapper for transient RPC failures.
 *
 * Stellar RPC endpoints occasionally return transient errors (connection timeouts,
 * 503s). This utility automatically retries operations that should succeed on retry
 * while failing fast on permanent errors (user rejection, validation errors, contract errors).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.retry = retry;
exports.withRetry = withRetry;
const DEFAULT_RETRY_OPTIONS = {
    maxRetries: 3,
    initialDelayMs: 500,
    backoffMultiplier: 2,
    verbose: false,
};
// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------
/**
 * Determine if an error is transient and should be retried.
 *
 * Retry on:
 * - Network timeouts
 * - HTTP 429 (rate limit)
 * - HTTP 503 (service unavailable)
 * - Connection errors
 *
 * Do not retry on:
 * - User rejection
 * - Validation errors
 * - Contract errors (Error(Contract, N))
 * - Authentication errors
 */
function isTransientError(error) {
    if (error instanceof Error) {
        const errorMessage = error.message.toLowerCase();
        const errorString = String(error).toLowerCase();
        // Network timeouts and connection errors
        if (errorMessage.includes("timeout") ||
            errorMessage.includes("etimedout") ||
            errorMessage.includes("econnrefused") ||
            errorMessage.includes("enotfound") ||
            errorMessage.includes("connection") ||
            errorMessage.includes("network") ||
            errorString.includes("timeout") ||
            errorString.includes("econnrefused") ||
            errorString.includes("enotfound")) {
            return true;
        }
        // HTTP 429 (rate limit)
        if (errorMessage.includes("429") ||
            errorMessage.includes("too many requests") ||
            errorMessage.includes("rate limit")) {
            return true;
        }
        // HTTP 503 (service unavailable)
        if (errorMessage.includes("503") ||
            errorMessage.includes("service unavailable") ||
            errorMessage.includes("temporarily unavailable")) {
            return true;
        }
        // Do not retry on contract errors (Error(Contract, N))
        if (errorMessage.includes("error(contract,") || errorString.includes("error(contract,")) {
            return false;
        }
        // Do not retry on user rejection
        if (errorMessage.includes("user rejected") ||
            errorMessage.includes("rejected by user") ||
            errorMessage.includes("user cancelled") ||
            errorMessage.includes("user denied")) {
            return false;
        }
        // Do not retry on validation errors
        if (errorMessage.includes("invalid") ||
            errorMessage.includes("validation") ||
            errorMessage.includes("malformed")) {
            return false;
        }
        // Do not retry on authentication errors
        if (errorMessage.includes("unauthorized") ||
            errorMessage.includes("authentication") ||
            errorMessage.includes("forbidden")) {
            return false;
        }
    }
    // For unknown errors, be conservative and don't retry
    return false;
}
// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------
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
async function retry(fn, options = {}) {
    const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
    let lastError;
    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        try {
            return await fn();
        }
        catch (error) {
            lastError = error;
            // If this is not a transient error, fail immediately
            if (!isTransientError(error)) {
                throw error;
            }
            // If this was the last attempt, throw the error
            if (attempt === opts.maxRetries) {
                throw error;
            }
            // Calculate delay with exponential back-off
            const delay = opts.initialDelayMs * Math.pow(opts.backoffMultiplier, attempt);
            if (opts.verbose) {
                console.warn(`[retry] Attempt ${attempt + 1}/${opts.maxRetries + 1} failed, retrying in ${delay}ms:`, error instanceof Error ? error.message : error);
            }
            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    // This should never be reached, but TypeScript needs it
    throw lastError;
}
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
function withRetry(fn, options = {}) {
    return (async (...args) => {
        return retry(() => fn(...args), options);
    });
}
//# sourceMappingURL=retry.js.map