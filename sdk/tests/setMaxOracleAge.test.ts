import { vi, describe, it, expect, beforeEach } from "vitest";
import { Account, SorobanRpc } from "@stellar/stellar-sdk";

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");
  return {
    ...actual,
    SorobanRpc: { ...actual.SorobanRpc, assembleTransaction: vi.fn(() => ({ build: () => ({}) })) },
  };
});

import { setMaxOracleAge } from "../src/methods/admin.js";

const VALID_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const MOCK_HASH = "abc123";

describe("setMaxOracleAge", () => {
  const mockServer = {
    simulateTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
  } as unknown as SorobanRpc.Server;
  const mockAccount = new Account(
    "GAGZSXAR7P7PASD2PGYISBMEZCMSI35TRJXYZTZNNCAUZRDEMHQM2XJS",
    "1"
  );
  const mockSign = vi.fn((tx) => tx);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws if simulation returns an error", async () => {
    mockServer.simulateTransaction = vi.fn().mockResolvedValue({
      error: "simulation failed",
    });
    await expect(
      setMaxOracleAge(mockServer, VALID_CONTRACT, 17280n, mockAccount, mockSign, "passphrase")
    ).rejects.toThrow();
  });

  it("throws if the transaction fails during execution", async () => {
    mockServer.simulateTransaction = vi.fn().mockResolvedValue({
      result: { auth: [], retval: undefined },
      transactionData: { build: () => ({}) },
      minResourceFee: "100",
    });
    mockServer.sendTransaction = vi.fn().mockResolvedValue({
      hash: MOCK_HASH,
      errorResult: undefined,
    });
    mockServer.getTransaction = vi.fn().mockResolvedValue({
      status: SorobanRpc.Api.GetTransactionStatus.FAILED,
    });

    await expect(
      setMaxOracleAge(mockServer, VALID_CONTRACT, 17280n, mockAccount, mockSign, "passphrase")
    ).rejects.toThrow("Transaction failed during execution");
  });

  it("returns txHash on success", async () => {
    mockServer.simulateTransaction = vi.fn().mockResolvedValue({
      result: { auth: [], retval: undefined },
      transactionData: { build: () => ({}) },
      minResourceFee: "100",
    });
    mockServer.sendTransaction = vi.fn().mockResolvedValue({
      hash: MOCK_HASH,
      errorResult: undefined,
    });
    mockServer.getTransaction = vi.fn().mockResolvedValue({
      status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
    });

    const result = await setMaxOracleAge(
      mockServer,
      VALID_CONTRACT,
      17280n,
      mockAccount,
      mockSign,
      "passphrase"
    );
    expect(result.txHash).toBe(MOCK_HASH);
  });
});
