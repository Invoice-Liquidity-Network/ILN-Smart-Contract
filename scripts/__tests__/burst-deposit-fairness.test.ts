import { describe, expect, it } from 'vitest';
import { measureBurstFairness } from '../measure-burst-deposit-fairness';

describe('Burst Deposit Fairness Measurement (#1040)', () => {
  it('measures statistical uniformity across 5 tied burst LPs', () => {
    const result = measureBurstFairness(2000, 5, 25);

    expect(result.starvedLpCount).toBe(0);
    expect(result.expectedP).toBe(0.2);
    expect(result.isFair).toBe(true);
  });

  it('measures fairness at MAX_FUND_QUEUE_LEN (10 tied LPs)', () => {
    const result = measureBurstFairness(3000, 10, 30);

    expect(result.starvedLpCount).toBe(0);
    expect(result.expectedP).toBe(0.1);
    expect(result.isFair).toBe(true);
  });
});
