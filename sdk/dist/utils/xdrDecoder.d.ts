/**
 * xdrDecoder — strongly-typed decoders for contract return values.
 *
 * Soroban contract responses return XDR-encoded data that must be decoded
 * into TypeScript types. This module provides centralized, strongly-typed
 * decoder functions for all contract return types.
 */
import type { Invoice } from "@invoice-liquidity/types";
import type { GovernanceProposal as Proposal } from "@invoice-liquidity/types";
/**
 * Decode an Invoice from native contract response (after scValToNative).
 *
 * @param raw - Native object from scValToNative(sim.result.retval)
 * @returns Decoded Invoice object
 *
 * @example
 * ```ts
 * const raw = scValToNative(sim.result.retval);
 * const invoice = decodeInvoice(raw);
 * console.log(invoice.status);
 * ```
 */
export declare function decodeInvoice(raw: Record<string, unknown>): Invoice;
/**
 * Reputation profile as returned by the contract.
 */
export interface ReputationProfile {
    /** Stellar G… address that was queried. */
    address: string;
    /** Current reputation score (0–100). */
    score: number;
    /** Total invoices submitted by this address. */
    invoicesSubmitted: number;
    /** Total invoices paid by this address (as payer). */
    invoicesPaid: number;
    /** Total invoices defaulted by this address. */
    invoicesDefaulted: number;
}
/**
 * Decode a ReputationProfile from native contract response (after scValToNative).
 *
 * @param raw - Native object from scValToNative(sim.result.retval)
 * @param address - The address that was queried (for context)
 * @returns Decoded ReputationProfile object
 *
 * @example
 * ```ts
 * const raw = scValToNative(sim.result.retval);
 * const reputation = decodeReputationScore(raw, "G...");
 * console.log(reputation.score);
 * ```
 */
export declare function decodeReputationScore(raw: Record<string, unknown>, address: string): ReputationProfile;
/**
 * Protocol-wide statistics returned by the contract.
 */
export interface ContractStats {
    /** Total number of invoices ever created. */
    totalInvoices: bigint;
    /** Cumulative number of fully-funded invoices. */
    totalFunded: bigint;
    /** Cumulative number of paid invoices. */
    totalPaid: bigint;
    /** Total USDC volume (in stroops, 6 decimals). */
    totalVolumeUsdc: bigint;
    /** Total EURC volume (in stroops, 6 decimals). */
    totalVolumeEurc: bigint;
    /** Total XLM volume (in stroops, 7 decimals). */
    totalVolumeXlm: bigint;
    /** Per-token volume map: token address → volume. */
    volumeByToken: Record<string, bigint>;
    /** Total volume normalized to USD (depends on oracle price feed). */
    totalVolumeUsdNormalized: bigint;
}
/**
 * Decode a ContractStats from native contract response (after scValToNative).
 *
 * @param raw - Native object from scValToNative(sim.result.retval)
 * @returns Decoded ContractStats object
 *
 * @example
 * ```ts
 * const raw = scValToNative(sim.result.retval);
 * const stats = decodeContractStats(raw);
 * console.log(stats.totalInvoices);
 * ```
 */
export declare function decodeContractStats(raw: Record<string, unknown>): ContractStats;
/**
 * Decode a GovernanceProposal from native contract response (after scValToNative).
 *
 * @param raw - Native object from scValToNative(sim.result.retval)
 * @returns Decoded Proposal object
 *
 * @example
 * ```ts
 * const raw = scValToNative(sim.result.retval);
 * const proposal = decodeGovernanceProposal(raw);
 * console.log(proposal.status);
 * ```
 */
export declare function decodeGovernanceProposal(raw: Record<string, unknown>): Proposal;
//# sourceMappingURL=xdrDecoder.d.ts.map