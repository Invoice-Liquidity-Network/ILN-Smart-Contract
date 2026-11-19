/**
 * xdrDecoder — strongly-typed decoders for contract return values.
 *
 * Soroban contract responses return XDR-encoded data that must be decoded
 * into TypeScript types. This module provides centralized, strongly-typed
 * decoder functions for all contract return types.
 */

import type { Invoice, InvoiceState as InvoiceStatus } from "@invoice-liquidity/types";
import type { GovernanceProposal as Proposal, ProposalAction, ProposalStatus } from "@invoice-liquidity/types";

// ---------------------------------------------------------------------------
// Invoice decoder
// ---------------------------------------------------------------------------

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
export function decodeInvoice(raw: Record<string, unknown>): Invoice {
  const dueDate = Number(raw["due_date"]);
  const discountRate = Number(raw["discount_rate"]);

  return {
    id: BigInt(String(raw["id"])),
    freelancer: String(raw["freelancer"]),
    payer: String(raw["payer"]),
    token: String(raw["token"]),
    amount: BigInt(String(raw["amount"])),
    dueDate,
    discountRate,
    status: parseInvoiceStatus(raw["status"]),
    funder: raw["funder"] ? String(raw["funder"]) : undefined,
    fundedAt: raw["funded_at"] ? Number(raw["funded_at"]) : undefined,
    amountFunded: BigInt(String(raw["amount_funded"])),
    amountPaid: BigInt(String(raw["amount_paid"])),
    referralCode: raw["referral_code"] ? Buffer.from(raw["referral_code"] as any).toString("hex") : undefined,
    submitterReputation: Number(raw["submitter_reputation"]),
    effectiveYieldBps: computeEffectiveYieldBps(discountRate, dueDate),
  };
}

/**
 * Parse invoice status from XDR enum or string.
 */
function parseInvoiceStatus(status: unknown): InvoiceStatus {
  if (typeof status === "string") {
    return status as InvoiceStatus;
  }
  // Handle SCVal enum with tag property
  if (status && typeof status === "object" && "tag" in status) {
    return String(status.tag) as InvoiceStatus;
  }
  return "Pending" as InvoiceStatus; // Default fallback
}

/**
 * Compute effective yield in basis points (imported from fundInvoice).
 * This is duplicated here to avoid circular dependencies.
 */
function computeEffectiveYieldBps(discountRateBps: number, dueDateUnix: number): number {
  const nowUnix = Math.floor(Date.now() / 1000);
  const secondsToMaturity = Math.max(0, dueDateUnix - nowUnix);
  const daysToMaturity = secondsToMaturity / 86400;
  return Math.round((discountRateBps * daysToMaturity) / 365);
}

// ---------------------------------------------------------------------------
// Reputation decoder
// ---------------------------------------------------------------------------

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
export function decodeReputationScore(raw: Record<string, unknown>, address: string): ReputationProfile {

  return {
    address: String(raw["address"] ?? address),
    score: Number(raw["score"] ?? 0),
    invoicesSubmitted: Number(raw["invoices_submitted"] ?? 0),
    invoicesPaid: Number(raw["invoices_paid"] ?? 0),
    invoicesDefaulted: Number(raw["invoices_defaulted"] ?? 0),
  };
}

// ---------------------------------------------------------------------------
// ContractStats decoder
// ---------------------------------------------------------------------------

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
export function decodeContractStats(raw: Record<string, unknown>): ContractStats {

  // Parse per-token volumes: the contract returns a Vec<(Address, i128)>
  const volumeByToken: Record<string, bigint> = {};
  const rawTokenVolumes = raw["token_volumes"] as Array<[string, string]> | undefined;
  if (Array.isArray(rawTokenVolumes)) {
    for (const [token, volume] of rawTokenVolumes) {
      volumeByToken[token] = BigInt(volume);
    }
  }

  return {
    totalInvoices: BigInt(String(raw["total_invoices"] ?? "0")),
    totalFunded: BigInt(String(raw["total_funded"] ?? "0")),
    totalPaid: BigInt(String(raw["total_paid"] ?? "0")),
    totalVolumeUsdc: BigInt(String(raw["total_volume_usdc"] ?? "0")),
    totalVolumeEurc: BigInt(String(raw["total_volume_eurc"] ?? "0")),
    totalVolumeXlm: BigInt(String(raw["total_volume_xlm"] ?? "0")),
    volumeByToken,
    totalVolumeUsdNormalized: BigInt(
      String(raw["total_volume_usd_normalized"] ?? "0")
    ),
  };
}

// ---------------------------------------------------------------------------
// TopPayerEntry decoder
// ---------------------------------------------------------------------------

/**
 * A single entry in the top-payers leaderboard.
 */
export interface TopPayerEntry {
  /** Stellar G… address of the payer. */
  address: string;
  /** Payer's reputation score. */
  score: number;
}

/**
 * Decode a TopPayerEntry from native contract response (after scValToNative).
 *
 * @param raw - Native object from scValToNative(sim.result.retval)
 * @returns Decoded TopPayerEntry object
 *
 * @example
 * ```ts
 * const raw = scValToNative(sim.result.retval);
 * const entries = raw.map(decodeTopPayerEntry);
 * ```
 */
export function decodeTopPayerEntry(raw: Record<string, unknown>): TopPayerEntry {
  return {
    address: String(raw["address"]),
    score: Number(raw["score"]),
  };
}

// ---------------------------------------------------------------------------
// GovernanceProposal decoder
// ---------------------------------------------------------------------------

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
export function decodeGovernanceProposal(raw: Record<string, unknown>): Proposal {
  const statusTag = (raw["status"] as any)?.tag ?? String(raw["status"]);

  return {
    id: BigInt(String(raw["id"])),
    action: Number(raw["action"]) as ProposalAction,
    proposedValue: BigInt(String(raw["proposed_value"] ?? 0)),
    descriptionHash: raw["description_hash"]
      ? Buffer.from(raw["description_hash"] as any).toString("hex")
      : "",
    proposer: String(raw["proposer"]),
    votesFor: BigInt(String(raw["votes_for"] ?? 0)),
    votesAgainst: BigInt(String(raw["votes_against"] ?? 0)),
    status: parseProposalStatus(statusTag),
    votingEndsAt: Number(raw["voting_ends_at"] ?? 0),
  };
}

/**
 * Parse proposal status from XDR enum or string.
 */
function parseProposalStatus(status: string): ProposalStatus {
  // Try to match against known enum values
  if (status === "Active" || status === "Passed" || status === "Rejected" || status === "Executed") {
    return status as ProposalStatus;
  }
  // Fallback to Active for unknown statuses
  return "Active" as ProposalStatus;
}

// ---------------------------------------------------------------------------
// NFT Metadata decoder
// ---------------------------------------------------------------------------

/**
 * NFT Metadata: complete information about an invoice NFT
 */
export interface InvoiceNftMetadata {
  /** The invoice ID this NFT represents. */
  invoiceId: bigint;
  /** Full invoice amount in stroops. */
  amount: bigint;
  /** Unix timestamp of when the invoice is due. */
  dueDate: number;
  /** Discount rate in basis points (e.g. 300 = 3.00%). */
  discountRate: number;
  /** Token used for the invoice. */
  token: string;
  /** Current owner of the NFT. */
  owner: string;
  /** Timestamp when the NFT was minted. */
  mintedAt: number;
}

/**
 * Decode an InvoiceNftMetadata from native contract response (after scValToNative).
 *
 * @param raw - Native object from scValToNative(sim.result.retval)
 * @returns Decoded InvoiceNftMetadata object
 *
 * @example
 * ```ts
 * const raw = scValToNative(sim.result.retval);
 * const nftMetadata = decodeNftMetadata(raw);
 * console.log(nftMetadata.invoiceId);
 * ```
 */
export function decodeNftMetadata(raw: Record<string, unknown>): InvoiceNftMetadata {
  return {
    invoiceId: BigInt(String(raw["invoice_id"])),
    amount: BigInt(String(raw["amount"])),
    dueDate: Number(raw["due_date"]),
    discountRate: Number(raw["discount_rate"]),
    token: String(raw["token"]),
    owner: String(raw["owner"]),
    mintedAt: Number(raw["minted_at"]),
  };
}
