import { vi, describe, it, expect, beforeEach } from "vitest";
import { setInsurancePool, getInsurancePool } from "./admin.js";
import { Account, SorobanRpc, scValToNative } from "@stellar/stellar-sdk";

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual("@stellar/stellar-sdk");
  return {
    ...actual,
    scValToNative: vi.fn(),
    SorobanRpc: {
      ...actual.SorobanRpc,
      assembleTransaction: vi.fn(() => ({ build: () => ({}) })),
    },
  };
});

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
// Reuses the same valid checksummed contract address string as CONTRACT -
// nativeToScVal's "address" encoding validates the StrKey checksum, so an
// arbitrary same-length string of letters (unlike a real base32 address)
// fails to decode.
const POOL = CONTRACT;
const ADMIN = "GBR7RT4MZTLKK2JNZPOSWVY74VFDR4HVR24QZNH2WONHPQFJZPKHWOTP";
const PASS = "Test SDF Network ; September 2015";

const mockScValToNative = scValToNative as unknown as vi.Mock;

describe("admin - insurance pool config (#529)", () => {
  const mockServer = {
    simulateTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
  } as unknown as SorobanRpc.Server;

  const account = new Account(ADMIN, "1");
  const sign = vi.fn((tx) => tx);

  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error mock
    mockServer.simulateTransaction.mockResolvedValue({ result: { retval: {} } });
    // @ts-expect-error mock
    mockServer.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "txINS" });
    // @ts-expect-error mock
    mockServer.getTransaction.mockResolvedValue({
      status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
      returnValue: {},
    });
  });

  it("setInsurancePool submits and returns txHash", async () => {
    const res = await setInsurancePool(mockServer, CONTRACT, POOL, account, sign, PASS);
    expect(res.txHash).toBe("txINS");
    expect(sign).toHaveBeenCalled();
  });

  it("getInsurancePool returns the decoded address", async () => {
    mockScValToNative.mockReturnValue(POOL);
    const pool = await getInsurancePool(mockServer, CONTRACT, account, PASS);
    expect(pool).toBe(POOL);
  });

  it("getInsurancePool returns undefined when unset", async () => {
    // @ts-expect-error mock
    mockServer.simulateTransaction.mockResolvedValueOnce({ result: { retval: null } });
    const pool = await getInsurancePool(mockServer, CONTRACT, account, PASS);
    expect(pool).toBeUndefined();
  });
});
