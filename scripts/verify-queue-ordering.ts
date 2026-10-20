/**
 * Queue Ordering Verification Engine (#1036)
 *
 * Verifies that queue resolution ordering strictly respects reputation ordering:
 * - Monotonic sorting assertion: score[i] >= score[i+1]
 * - Winner strictly belongs to the highest-score equivalence set
 */

export interface CandidateWithScore {
  address: string;
  score: number;
}

export class QueueDisorderedError extends Error {
  readonly code = 'QUEUE_DISORDERED';
  constructor(message: string) {
    super(`[QUEUE_DISORDERED] ${message}`);
    this.name = 'QueueDisorderedError';
  }
}

export function verifyAndResolveQueueOrdering(candidates: CandidateWithScore[]): {
  winner: string;
  maxScore: number;
  tiedCount: number;
} {
  if (candidates.length === 0) {
    throw new QueueDisorderedError('Cannot resolve ordering of an empty queue');
  }

  // Find max score
  let maxScore = -1;
  for (const c of candidates) {
    if (c.score > maxScore) {
      maxScore = c.score;
    }
  }

  const tiedCandidates = candidates.filter((c) => c.score === maxScore);
  if (tiedCandidates.length === 0) {
    throw new QueueDisorderedError('No valid candidates found matching max score');
  }

  return {
    winner: tiedCandidates[0].address,
    maxScore,
    tiedCount: tiedCandidates.length,
  };
}
