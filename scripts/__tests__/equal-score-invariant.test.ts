import { describe, expect, it } from 'vitest';
import { evaluateEqualScoreInvariants } from '../verify-equal-score-invariant';

describe('Equal-Score Priority Invariants (#1039)', () => {
  const candidates = [
    { address: 'LP_TOP_1', score: 90 },
    { address: 'LP_TOP_2', score: 90 },
    { address: 'LP_LOW_1', score: 75 },
    { address: 'LP_LOW_2', score: 60 },
  ];

  it('partitions candidates into top-tied set C and strictly excluded set', () => {
    const res = evaluateEqualScoreInvariants(candidates, 0);

    expect(res.candidateSetC).toEqual(['LP_TOP_1', 'LP_TOP_2']);
    expect(res.strictlyExcluded).toEqual(['LP_LOW_1', 'LP_LOW_2']);
    expect(res.selectedWinner).toBe('LP_TOP_1');
    expect(res.invariantsSatisfied).toBe(true);
  });

  it('selects alternative tied candidate when PRNG seed points to index 1', () => {
    const res = evaluateEqualScoreInvariants(candidates, 1);

    expect(res.selectedWinner).toBe('LP_TOP_2');
    expect(res.invariantsSatisfied).toBe(true);
  });

  it('guarantees strictly zero probability for lower-scoring LPs', () => {
    // Over all possible seed permutations, winner is never in strictlyExcluded
    for (let seed = 0; seed < 100; seed++) {
      const res = evaluateEqualScoreInvariants(candidates, seed);
      expect(res.strictlyExcluded.includes(res.selectedWinner)).toBe(false);
    }
  });
});
