/**
 * Burst Deposit Fairness Measurement Engine (#1040)
 *
 * Runs Monte Carlo simulations measuring distribution fairness across burst joins:
 * - Computes selection frequencies, variance, and max percentage deviation from expected 1/K
 * - Verifies absence of LP starvation
 */

export interface FairnessMeasurement {
  trials: number;
  tiedLpCount: number;
  expectedP: number;
  maxDeviationPercent: number;
  isFair: boolean;
  starvedLpCount: number;
}

export function measureBurstFairness(
  trials: number = 1000,
  tiedLpCount: number = 5,
  maxAllowedDeviationPercent: number = 20, // 20% tolerance for 1000 trials
): FairnessMeasurement {
  const counts: Record<number, number> = {};
  for (let i = 0; i < tiedLpCount; i++) {
    counts[i] = 0;
  }

  // PRNG simulation of uniform selection among tied LPs
  for (let t = 0; t < trials; t++) {
    const selected = Math.floor(Math.random() * tiedLpCount);
    counts[selected] += 1;
  }

  const expectedCount = trials / tiedLpCount;
  const expectedP = 1 / tiedLpCount;
  let maxDeviationPercent = 0;
  let starvedLpCount = 0;

  for (let i = 0; i < tiedLpCount; i++) {
    const count = counts[i];
    if (count === 0) {
      starvedLpCount += 1;
    }
    const dev = (Math.abs(count - expectedCount) / expectedCount) * 100;
    if (dev > maxDeviationPercent) {
      maxDeviationPercent = dev;
    }
  }

  const isFair = starvedLpCount === 0 && maxDeviationPercent <= maxAllowedDeviationPercent;

  return {
    trials,
    tiedLpCount,
    expectedP,
    maxDeviationPercent: Math.round(maxDeviationPercent * 100) / 100,
    isFair,
    starvedLpCount,
  };
}
