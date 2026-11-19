import { vi, describe, it, expect, beforeEach } from "vitest";
import { Account, SorobanRpc } from "@stellar/stellar-sdk";

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");
  return {
    ...actual,
    SorobanRpc: { ...actual.SorobanRpc, assembleTransaction: vi.fn(() => ({ build: () => ({}) })) },
  };
});

import { addToken } from "../src/methods/admin.js";

const VALID_TOKEN = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const MOCK_HASH = "abc123";

describe("addToken", () => {
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

  it("throws if token is not a valid contract ID", async () => {
    await expect(
      addToken(
        mockServer,
        VALID_TOKEN,
        "not-a-valid-contract",
        7,
        mockAccount,
        mockSign,
        "passphrase"
      )
    ).rejects.toThrow();
  });

  it("throws if simulation returns an error", async () => {
    mockServer.simulateTransaction = vi.fn().mockResolvedValue({
      error: "simulation failed",
    });
    await expect(
      addToken(
        mockServer,
        VALID_TOKEN,
        VALID_TOKEN,
        7,
        mockAccount,
        mockSign,
        "passphrase"
      )
    ).rejects.toThrow();
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

    const result = await addToken(
      mockServer,
      VALID_TOKEN,
      VALID_TOKEN,
      7,
      mockAccount,
      mockSign,
      "passphrase"
    );
    expect(result.txHash).toBe(MOCK_HASH);
  });
});
