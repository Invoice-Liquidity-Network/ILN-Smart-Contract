import { vi, describe, it, expect, beforeEach } from "vitest";
import { setDistributionContract } from "../src/methods/admin.js";
import { Account, SorobanRpc } from "@stellar/stellar-sdk";

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");
  return {
    ...actual,
    SorobanRpc: { ...actual.SorobanRpc, assembleTransaction: vi.fn() },
  };
});

const VALID_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const MOCK_HASH = "abc123";

describe("setDistributionContract", () => {
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

  it("throws if distributionContract is not a valid contract ID", async () => {
    await expect(
      setDistributionContract(
        mockServer,
        VALID_CONTRACT,
        "not-a-valid-contract",
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
      setDistributionContract(
        mockServer,
        VALID_CONTRACT,
        VALID_CONTRACT,
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

    vi.mocked(SorobanRpc.assembleTransaction).mockReturnValue({
      build: () => ({} as never),
    } as never);

    const result = await setDistributionContract(
      mockServer,
      VALID_CONTRACT,
      VALID_CONTRACT,
      mockAccount,
      mockSign,
      "passphrase"
    );
    expect(result.txHash).toBe(MOCK_HASH);
  });
});
