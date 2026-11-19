import { describe, it, expect } from "vitest";
import {
  ILNError,
  ValidationError,
  AuthorizationError,
  InvoiceStateError,
  ContractExecutionError,
  NetworkError,
} from "./errors.js";

describe("SDK Error Handling", () => {
  describe("fromError mapping", () => {
    it("maps contract error code 1 to ValidationError.InvoiceNotFound", () => {
      const err = ILNError.fromError("Error(Contract, 1)");
      expect(err).toBeInstanceOf(ILNError.InvoiceNotFound);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ILNError).originalCode).toBe(1);
      expect((err as ILNError).recommendRetry).toBe(false);
    });

    it("maps contract error code 2 to InvoiceStateError.AlreadyFunded", () => {
      const err = ILNError.fromError("Error(Contract, 2)");
      expect(err).toBeInstanceOf(ILNError.AlreadyFunded);
      expect(err).toBeInstanceOf(InvoiceStateError);
      expect((err as ILNError).originalCode).toBe(2);
      expect((err as ILNError).recommendRetry).toBe(false);
    });

    it("maps contract error code 5 to AuthorizationError.Unauthorized", () => {
      const err = ILNError.fromError("Error(Contract, 5)");
      expect(err).toBeInstanceOf(ILNError.Unauthorized);
      expect(err).toBeInstanceOf(AuthorizationError);
      expect((err as ILNError).originalCode).toBe(5);
      expect((err as ILNError).recommendRetry).toBe(false);
    });

    it("maps contract error code 26 to ContractExecutionError.ContractPaused", () => {
      const err = ILNError.fromError("Error(Contract, 26)");
      expect(err).toBeInstanceOf(ILNError.ContractPaused);
      expect(err).toBeInstanceOf(ContractExecutionError);
      expect((err as ILNError).originalCode).toBe(26);
      expect((err as ILNError).recommendRetry).toBe(false);
    });

    it("maps network timeout to NetworkError with retry recommendation", () => {
      const err = ILNError.fromError("Request timeout on endpoint");
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as ILNError).recommendRetry).toBe(true);
    });

    it("maps ledger synchronization delay to ContractExecutionError with retry recommendation", () => {
      const err = ILNError.fromError("Ledger synchronization delay detected");
      expect(err).toBeInstanceOf(ContractExecutionError);
      expect((err as ILNError).recommendRetry).toBe(true);
    });

    it("preserves context metadata in the mapped error", () => {
      const context = {
        txHash: "0x123",
        ledger: 456,
        contractId: "C123",
      };
      const err = ILNError.fromError("Error(Contract, 1)", context) as ILNError;
      expect(err.txHash).toBe("0x123");
      expect(err.ledger).toBe(456);
      expect(err.contractId).toBe("C123");
      expect(err.originalCode).toBe(1);
    });
  });
});
