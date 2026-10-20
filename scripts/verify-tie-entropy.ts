/**
 * Tie Break Entropy Verification Engine (#1037)
 *
 * Validates entropy bounds:
 * - Rejects malformed ranges (bound <= 1 or bound > MAX_FUND_QUEUE_LEN)
 * - Asserts fail-closed behavior on invalid entropy input
 */

export const MAX_FUND_QUEUE_LEN = 10;

export class InvalidEntropyError extends Error {
  readonly code = 'INVALID_ENTROPY';
  constructor(message: string) {
    super(`[INVALID_ENTROPY] ${message}`);
    this.name = 'InvalidEntropyError';
  }
}

export function validateTieBreakEntropyBounds(tiedCandidateCount: number): boolean {
  if (tiedCandidateCount <= 1) {
    throw new InvalidEntropyError(
      `Tied candidate count must be strictly greater than 1, got ${tiedCandidateCount}`
    );
  }

  if (tiedCandidateCount > MAX_FUND_QUEUE_LEN) {
    throw new InvalidEntropyError(
      `Tied candidate count exceeds MAX_FUND_QUEUE_LEN of ${MAX_FUND_QUEUE_LEN}, got ${tiedCandidateCount}`
    );
  }

  return true;
}
