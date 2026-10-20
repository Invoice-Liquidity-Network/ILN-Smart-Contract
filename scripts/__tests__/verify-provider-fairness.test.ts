import { describe, expect, it } from 'vitest';
import { simulateQueueResolution, type QueueEntry } from '../verify-provider-fairness';

describe('Provider Fairness Guarantees (#1038)', () => {
  const queue: QueueEntry[] = [
    { lp: 'LP_ALPHA', score: 95, joinedAtLedger: 100 },
    { lp: 'LP_BETA', score: 95, joinedAtLedger: 101 },
    { lp: 'LP_GAMMA', score: 80, joinedAtLedger: 102 },
  ];

  it('rejects resolution before maturity delay lapses', () => {
    // Delay = 5, opened at 100, current = 103 (< 105)
    const result = simulateQueueResolution(queue, 103, 100, 5);
    expect(result.status).toBe('NOT_MATURE');
  });

  it('fails closed when openedAtLedger record is missing', () => {
    const result = simulateQueueResolution(queue, 110, 0, 5);
    expect(result.status).toBe('ARCHIVED');
  });

  it('selects uniformly among tied top scores based on PRNG index', () => {
    // Current = 110 (mature)
    const win1 = simulateQueueResolution(queue, 110, 100, 5, 0);
    expect(win1.status).toBe('SUCCESS');
    expect(win1.winner).toBe('LP_ALPHA');

    const win2 = simulateQueueResolution(queue, 110, 100, 5, 1);
    expect(win2.status).toBe('SUCCESS');
    expect(win2.winner).toBe('LP_BETA');
  });
});
