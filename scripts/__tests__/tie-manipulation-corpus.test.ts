import { describe, expect, it } from 'vitest';
import { runTieManipulationVerification } from '../exercise-tie-manipulation-corpus';

describe('Tie Manipulation Regression Corpus (#1041)', () => {
  it('passes all tie manipulation adversarial constraints', () => {
    const result = runTieManipulationVerification();

    expect(result.maxEntriesEnforced).toBe(true);
    expect(result.prematureResolutionRejected).toBe(true);
    expect(result.matureResolutionSucceeded).toBe(true);
    expect(result.idempotentReplayVerified).toBe(true);
  });
});
