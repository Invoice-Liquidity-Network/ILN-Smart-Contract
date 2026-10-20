import { describe, expect, it } from 'vitest';
import {
  verifyAndResolveQueueOrdering,
  QueueDisorderedError,
} from '../verify-queue-ordering';

describe('Verify Ordering During Resolution (#1036)', () => {
  it('correctly resolves the candidate with the strictly highest reputation score', () => {
    const candidates = [
      { address: 'LP_LOW', score: 40 },
      { address: 'LP_HIGH', score: 98 },
      { address: 'LP_MID', score: 60 },
    ];

    const result = verifyAndResolveQueueOrdering(candidates);
    expect(result.winner).toBe('LP_HIGH');
    expect(result.maxScore).toBe(98);
    expect(result.tiedCount).toBe(1);
  });

  it('identifies all tied candidates at max score in order', () => {
    const candidates = [
      { address: 'LP_TIED_1', score: 85 },
      { address: 'LP_TIED_2', score: 85 },
      { address: 'LP_LOWER', score: 70 },
    ];

    const result = verifyAndResolveQueueOrdering(candidates);
    expect(result.maxScore).toBe(85);
    expect(result.tiedCount).toBe(2);
    expect(['LP_TIED_1', 'LP_TIED_2']).toContain(result.winner);
  });

  it('rejects empty candidate list with QueueDisorderedError', () => {
    expect(() => verifyAndResolveQueueOrdering([])).toThrow(QueueDisorderedError);
  });
});
