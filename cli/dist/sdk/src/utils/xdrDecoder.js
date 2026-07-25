"use strict";
/**
 * xdrDecoder — strongly-typed decoders for contract return values.
 *
 * Soroban contract responses return XDR-encoded data that must be decoded
 * into TypeScript types. This module provides centralized, strongly-typed
 * decoder functions for all contract return types.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.decodeInvoice = decodeInvoice;
exports.decodeReputationScore = decodeReputationScore;
exports.decodeContractStats = decodeContractStats;
exports.decodeGovernanceProposal = decodeGovernanceProposal;
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
function decodeInvoice(raw) {
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
        referralCode: raw["referral_code"] ? Buffer.from(raw["referral_code"]).toString("hex") : undefined,
        submitterReputation: Number(raw["submitter_reputation"]),
        effectiveYieldBps: computeEffectiveYieldBps(discountRate, dueDate),
    };
}
/**
 * Parse invoice status from XDR enum or string.
 */
function parseInvoiceStatus(status) {
    if (typeof status === "string") {
        return status;
    }
    // Handle SCVal enum with tag property
    if (status && typeof status === "object" && "tag" in status) {
        return String(status.tag);
    }
    return "Pending"; // Default fallback
}
/**
 * Compute effective yield in basis points (imported from fundInvoice).
 * This is duplicated here to avoid circular dependencies.
 */
function computeEffectiveYieldBps(discountRateBps, dueDateUnix) {
    const nowUnix = Math.floor(Date.now() / 1000);
    const secondsToMaturity = Math.max(0, dueDateUnix - nowUnix);
    const daysToMaturity = secondsToMaturity / 86400;
    return Math.round((discountRateBps * daysToMaturity) / 365);
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
function decodeReputationScore(raw, address) {
    return {
        address: String(raw["address"] ?? address),
        score: Number(raw["score"] ?? 0),
        invoicesSubmitted: Number(raw["invoices_submitted"] ?? 0),
        invoicesPaid: Number(raw["invoices_paid"] ?? 0),
        invoicesDefaulted: Number(raw["invoices_defaulted"] ?? 0),
    };
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
function decodeContractStats(raw) {
    // Parse per-token volumes: the contract returns a Vec<(Address, i128)>
    const volumeByToken = {};
    const rawTokenVolumes = raw["token_volumes"];
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
        totalVolumeUsdNormalized: BigInt(String(raw["total_volume_usd_normalized"] ?? "0")),
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
function decodeGovernanceProposal(raw) {
    const statusTag = raw["status"]?.tag ?? String(raw["status"]);
    return {
        id: BigInt(String(raw["id"])),
        action: Number(raw["action"]),
        proposedValue: BigInt(String(raw["proposed_value"] ?? 0)),
        descriptionHash: raw["description_hash"]
            ? Buffer.from(raw["description_hash"]).toString("hex")
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
function parseProposalStatus(status) {
    // Try to match against known enum values
    if (status === "Active" || status === "Passed" || status === "Rejected" || status === "Executed") {
        return status;
    }
    // Fallback to Active for unknown statuses
    return "Active";
}
//# sourceMappingURL=xdrDecoder.js.map