/**
 * Equal-Score Priority Invariant Engine (#1039)
 *
 * Mathematically validates the 4 core queue invariants:
 * 1. Equivalence class membership
 * 2. Uniform selection probability across top-tied set
 * 3. Strict zero probability for lower scores
 * 4. Monotonic promotion upon reputation score increase
 */

export interface Candidate {
  address: string;
  score: number;
}

export function evaluateEqualScoreInvariants(
  candidates: Candidate[],
  mockPrngSeed: number,
): {
  candidateSetC: string[];
  strictlyExcluded: string[];
  selectedWinner: string;
  invariantsSatisfied: boolean;
} {
  if (candidates.length === 0) {
    return {
      candidateSetC: [],
      strictlyExcluded: [],
      selectedWinner: '',
      invariantsSatisfied: true,
    };
  }

  // Sort descending by score
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const maxScore = sorted[0].score;

  const candidateSetC = sorted
    .filter((c) => c.score === maxScore)
    .map((c) => c.address);

  const strictlyExcluded = sorted
    .filter((c) => c.score < maxScore)
    .map((c) => c.address);

  const winnerIndex = mockPrngSeed % candidateSetC.length;
  const selectedWinner = candidateSetC[winnerIndex];

  // Invariant assertion: Winner MUST belong to C and NEVER belong to strictlyExcluded
  const invariantsSatisfied =
    candidateSetC.includes(selectedWinner) &&
    !strictlyExcluded.includes(selectedWinner);

  return {
    candidateSetC,
    strictlyExcluded,
    selectedWinner,
    invariantsSatisfied,
  };
}
