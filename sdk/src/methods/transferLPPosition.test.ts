import { vi, describe, it, expect, beforeEach } from 'vitest';
import { transferLPPosition } from "./transferLPPosition.js";
import { ILNError } from "../errors.js";
import { Account, SorobanRpc } from "@stellar/stellar-sdk";

// Mock assembleTransaction — it's a non-writable module export so we must
// mock the whole module at load time.
vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");
  return {
    ...actual,
    SorobanRpc: {
      ...(actual.SorobanRpc as object),
      Api: (actual.SorobanRpc as unknown).Api,
      assembleTransaction: vi.fn(() => ({ build: () => ({}) })),
    },
  };
});

const CURRENT_LP = "GBR7RT4MZTLKK2JNZPOSWVY74VFDR4HVR24QZNH2WONHPQFJZPKHWOTP";
const NEW_LP = "GCCGXKWWVKMVIM2DMFJUTYTHFXSVXSMS7U3LPGS5KUPYE3TN5GXY364G";
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const PASS = "Test SDF Network ; September 2015";

describe("transferLPPosition", () => {
  const mockServer = {
    simulateTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
  } as unknown as SorobanRpc.Server;

  const account = new Account(CURRENT_LP, "1");
  const sign = vi.fn((tx) => tx);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("transfers the position successfully", async () => {
    // @ts-expect-error mock
    mockServer.simulateTransaction.mockResolvedValue({ result: { retval: {} } });
    // @ts-expect-error mock

    // @ts-expect-error mock
    mockServer.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "txABC" });
    // @ts-expect-error mock
    mockServer.getTransaction.mockResolvedValue({ status: SorobanRpc.Api.GetTransactionStatus.SUCCESS });

    const res = await transferLPPosition(mockServer, CONTRACT, 7n, NEW_LP, account, sign, PASS);
    expect(res.txHash).toBe("txABC");
    expect(sign).toHaveBeenCalled();
  });

  it("throws InvalidTransfer when newLP equals the current LP", async () => {
    await expect(
      transferLPPosition(mockServer, CONTRACT, 7n, CURRENT_LP, account, sign, PASS)
    ).rejects.toThrow(ILNError.InvalidTransfer);
  });

  it("throws InvalidAddress when newLP is malformed", async () => {
    await expect(
      transferLPPosition(mockServer, CONTRACT, 7n, "GBAD", account, sign, PASS)
    ).rejects.toThrow(ILNError.InvalidAddress);
  });
});
