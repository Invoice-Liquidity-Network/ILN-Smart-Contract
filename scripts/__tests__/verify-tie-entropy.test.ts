import { describe, expect, it } from 'vitest';
import {
  validateTieBreakEntropyBounds,
  InvalidEntropyError,
  MAX_FUND_QUEUE_LEN,
} from '../verify-tie-entropy';

describe('Reject Malformed Tie-Break Entropy (#1037)', () => {
  it('accepts valid bounds within 2..MAX_FUND_QUEUE_LEN', () => {
    expect(validateTieBreakEntropyBounds(2)).toBe(true);
    expect(validateTieBreakEntropyBounds(5)).toBe(true);
    expect(validateTieBreakEntropyBounds(MAX_FUND_QUEUE_LEN)).toBe(true);
  });

  it('rejects malformed non-positive or singular bounds', () => {
    expect(() => validateTieBreakEntropyBounds(0)).toThrow(InvalidEntropyError);
    expect(() => validateTieBreakEntropyBounds(1)).toThrow(InvalidEntropyError);
  });

  it('rejects bounds exceeding queue maximum capacity', () => {
    expect(() => validateTieBreakEntropyBounds(MAX_FUND_QUEUE_LEN + 1)).toThrow(
      InvalidEntropyError
    );
  });
});
