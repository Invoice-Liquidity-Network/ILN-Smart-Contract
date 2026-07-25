/**
 * Governance types for the ILN SDK.
 *
 * Mirrors the on-chain governance contract's proposal model so TypeScript
 * integrators can create proposals, vote and execute without hand-rolling
 * Soroban calls.
 */

/**
 * The set of parameter-changing actions a proposal can request.
 *
 * The numeric values match the contract's `ProposalAction` enum discriminants
 * and are used directly as the `u32` argument when encoding the call.
 */
import { ProposalAction, ProposalStatus } from "@invoice-liquidity/types";
import type { GovernanceProposal as Proposal } from "@invoice-liquidity/types";

export { ProposalAction, ProposalStatus };
export type { Proposal };

/** Optional filter for {@link listProposals}. */
export interface ProposalFilter {
  /** Only return proposals in this status. */
  status?: ProposalStatus;
  /** Only return proposals created by this address. */
  proposer?: string;
}

/** Result of creating a proposal. */
export interface CreateProposalResult {
  proposalId: bigint;
  txHash: string;
}

