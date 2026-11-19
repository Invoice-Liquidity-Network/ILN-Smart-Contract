/**
 * Property-based tests for XDR decoder utilities
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  decodeInvoice,
  decodeReputationScore,
  decodeContractStats,
  decodeGovernanceProposal,
} from "./xdrDecoder.js";
import type { Invoice, InvoiceStatus } from "../types/invoice.js";
import type { Proposal, ProposalAction, ProposalStatus } from "../types/governance.js";

describe("xdrDecoder property-based tests", () => {
  describe("decodeInvoice", () => {
    it("should decode valid invoice data", () => {
      fc.assert(
        fc.property(
          fc.record({
            id: fc.bigInt(),
            freelancer: fc.hexaString({ minLength: 56, maxLength: 56 }),
            payer: fc.hexaString({ minLength: 56, maxLength: 56 }),
            token: fc.hexaString({ minLength: 56, maxLength: 56 }),
            amount: fc.bigInt(),
            due_date: fc.integer(),
            discount_rate: fc.integer(),
            status: fc.constantFrom(...["Pending", "Funded", "PartiallyFunded", "Paid", "Defaulted", "Appealed", "Disputed", "Expired", "Cancelled"] as InvoiceStatus[]),
            funder: fc.option(fc.hexaString({ minLength: 56, maxLength: 56 })),
            funded_at: fc.option(fc.integer()),
            amount_funded: fc.bigInt(),
            amount_paid: fc.bigInt(),
            referral_code: fc.option(fc.hexaString()),
            submitter_reputation: fc.integer(),
          }),
          (raw) => {
            const invoice = decodeInvoice(raw);
            
            expect(invoice.id).toBe(raw.id);
            expect(invoice.freelancer).toBe(raw.freelancer);
            expect(invoice.payer).toBe(raw.payer);
            expect(invoice.token).toBe(raw.token);
            expect(invoice.amount).toBe(raw.amount);
            expect(invoice.dueDate).toBe(raw.due_date);
            expect(invoice.discountRate).toBe(raw.discount_rate);
            expect(invoice.amountFunded).toBe(raw.amount_funded);
            expect(invoice.amountPaid).toBe(raw.amount_paid);
            expect(invoice.submitterReputation).toBe(raw.submitter_reputation);
          }
        )
      );
    });

    it("should handle missing optional fields", () => {
      const raw = {
        id: 1n,
        freelancer: "G" + "A".repeat(55),
        payer: "G" + "B".repeat(55),
        token: "G" + "C".repeat(55),
        amount: 1000n,
        due_date: 1234567890,
        discount_rate: 500,
        status: "Pending",
        amount_funded: 0n,
        amount_paid: 0n,
        submitter_reputation: 50,
      };
      
      const invoice = decodeInvoice(raw);
      expect(invoice.funder).toBeUndefined();
      expect(invoice.fundedAt).toBeUndefined();
      expect(invoice.referralCode).toBeUndefined();
    });

    it("should compute effective yield", () => {
      const raw = {
        id: 1n,
        freelancer: "G" + "A".repeat(55),
        payer: "G" + "B".repeat(55),
        token: "G" + "C".repeat(55),
        amount: 1000n,
        due_date: Math.floor(Date.now() / 1000) + 86400 * 30, // 30 days from now
        discount_rate: 1000, // 10%
        status: "Pending",
        amount_funded: 0n,
        amount_paid: 0n,
        submitter_reputation: 50,
      };
      
      const invoice = decodeInvoice(raw);
      expect(invoice.effectiveYieldBps).toBeGreaterThan(0);
    });
  });

  describe("decodeReputationScore", () => {
    it("should decode valid reputation data", () => {
      fc.assert(
        fc.property(
          fc.record({
            address: fc.hexaString({ minLength: 56, maxLength: 56 }),
            score: fc.integer({ min: 0, max: 100 }),
            invoices_submitted: fc.integer({ min: 0 }),
            invoices_paid: fc.integer({ min: 0 }),
            invoices_defaulted: fc.integer({ min: 0 }),
          }),
          (raw) => {
            const address = "G" + "A".repeat(55);
            const reputation = decodeReputationScore(raw, address);
            
            expect(reputation.address).toBe(raw.address ?? address);
            expect(reputation.score).toBe(raw.score);
            expect(reputation.invoicesSubmitted).toBe(raw.invoices_submitted);
            expect(reputation.invoicesPaid).toBe(raw.invoices_paid);
            expect(reputation.invoicesDefaulted).toBe(raw.invoices_defaulted);
          }
        )
      );
    });

    it("should handle missing fields with defaults", () => {
      const address = "G" + "A".repeat(55);
      const raw = {};
      
      const reputation = decodeReputationScore(raw, address);
      expect(reputation.address).toBe(address);
      expect(reputation.score).toBe(0);
      expect(reputation.invoicesSubmitted).toBe(0);
      expect(reputation.invoicesPaid).toBe(0);
      expect(reputation.invoicesDefaulted).toBe(0);
    });
  });

  describe("decodeContractStats", () => {
    it("should decode valid contract stats", () => {
      fc.assert(
        fc.property(
          fc.record({
            total_invoices: fc.bigInt(),
            total_funded: fc.bigInt(),
            total_paid: fc.bigInt(),
            total_volume_usdc: fc.bigInt(),
            total_volume_eurc: fc.bigInt(),
            total_volume_xlm: fc.bigInt(),
            token_volumes: fc.array(fc.tuple(fc.hexaString({ minLength: 56, maxLength: 56 }), fc.bigInt().map(String))),
            total_volume_usd_normalized: fc.bigInt(),
          }),
          (raw) => {
            const stats = decodeContractStats(raw);
            
            expect(stats.totalInvoices).toBe(raw.total_invoices);
            expect(stats.totalFunded).toBe(raw.total_funded);
            expect(stats.totalPaid).toBe(raw.total_paid);
            expect(stats.totalVolumeUsdc).toBe(raw.total_volume_usdc);
            expect(stats.totalVolumeEurc).toBe(raw.total_volume_eurc);
            expect(stats.totalVolumeXlm).toBe(raw.total_volume_xlm);
            expect(stats.totalVolumeUsdNormalized).toBe(raw.total_volume_usd_normalized);
          }
        )
      );
    });

    it("should handle missing token volumes", () => {
      const raw = {
        total_invoices: 100n,
        total_funded: 50n,
        total_paid: 30n,
        total_volume_usdc: 1000000n,
        total_volume_eurc: 500000n,
        total_volume_xlm: 2000000n,
        total_volume_usd_normalized: 1500000n,
      };
      
      const stats = decodeContractStats(raw);
      expect(stats.volumeByToken).toEqual({});
    });

    it("should parse token volumes correctly", () => {
      const raw = {
        total_invoices: 100n,
        total_funded: 50n,
        total_paid: 30n,
        total_volume_usdc: 1000000n,
        total_volume_eurc: 500000n,
        total_volume_xlm: 2000000n,
        token_volumes: [["G" + "A".repeat(55), "1000"], ["G" + "B".repeat(55), "2000"]],
        total_volume_usd_normalized: 1500000n,
      };
      
      const stats = decodeContractStats(raw);
      expect(Object.keys(stats.volumeByToken)).toHaveLength(2);
    });
  });

  describe("decodeGovernanceProposal", () => {
    it("should decode valid proposal data", () => {
      fc.assert(
        fc.property(
          fc.record({
            id: fc.bigInt(),
            action: fc.integer({ min: 0, max: 5 }),
            proposed_value: fc.bigInt(),
            description_hash: fc.hexaString({ minLength: 64, maxLength: 64 }),
            proposer: fc.hexaString({ minLength: 56, maxLength: 56 }),
            votes_for: fc.bigInt(),
            votes_against: fc.bigInt(),
            status: fc.constantFrom(...["Active", "Passed", "Rejected", "Executed"] as ProposalStatus[]),
            voting_ends_at: fc.integer(),
          }),
          (raw) => {
            const proposal = decodeGovernanceProposal(raw);
            
            expect(proposal.id).toBe(raw.id);
            expect(proposal.action).toBe(raw.action);
            expect(proposal.proposedValue).toBe(raw.proposed_value);
            expect(proposal.proposer).toBe(raw.proposer);
            expect(proposal.votesFor).toBe(raw.votes_for);
            expect(proposal.votesAgainst).toBe(raw.votes_against);
            expect(proposal.votingEndsAt).toBe(raw.voting_ends_at);
          }
        )
      );
    });

    it("should handle missing description hash", () => {
      const raw = {
        id: 1n,
        action: 0,
        proposed_value: 100n,
        proposer: "G" + "A".repeat(55),
        votes_for: 50n,
        votes_against: 10n,
        status: "Active",
        voting_ends_at: 1234567890,
      };
      
      const proposal = decodeGovernanceProposal(raw);
      expect(proposal.descriptionHash).toBe("");
    });

    it("should handle unknown status gracefully", () => {
      const raw = {
        id: 1n,
        action: 0,
        proposed_value: 100n,
        proposer: "G" + "A".repeat(55),
        votes_for: 50n,
        votes_against: 10n,
        status: "UnknownStatus",
        voting_ends_at: 1234567890,
      };
      
      const proposal = decodeGovernanceProposal(raw);
      expect(proposal.status).toBe("Active"); // Fallback
    });
  });
});
