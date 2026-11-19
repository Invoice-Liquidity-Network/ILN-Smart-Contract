import { vi, describe, it, expect, beforeEach } from "vitest";
import { ILNError } from "../errors.js";
import { ILNClient } from "../client.js";
import { Account } from "@stellar/stellar-sdk";

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");
  return {
    ...actual,
    scValToNative: vi.fn(),
    SorobanRpc: { ...actual.SorobanRpc, assembleTransaction: vi.fn(() => ({ build: () => ({}) })) },
  };
});

import { scValToNative } from "@stellar/stellar-sdk";
import { joinFundQueue, resolveFundQueue } from "./fundQueue.js";

const mockScValToNative = scValToNative as unknown as vi.Mock;

const LP = "GBR7RT4MZTLKK2JNZPOSWVY74VFDR4HVR24QZNH2WONHPQFJZPKHWOTP";
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const PASS = "Test SDF Network ; September 2015";

function makeClient(withSigner = true) {
  return ILNClient.custom({
    rpcUrl: "https://fake-rpc.example.org",
    networkPassphrase: PASS,
    contractId: CONTRACT,
    ...(withSigner ? { signer: { publicKey: LP, signTransaction: vi.fn().mockResolvedValue("signed-xdr") } } : {}),
  });
}

function mockRpc(overrides: Record<string, unknown> = {}) {
  return {
    getAccount: vi.fn().mockResolvedValue(new Account(LP, "1")),
    simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: {} } }),
    sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING", hash: "txQUEUE" }),
    getTransaction: vi.fn().mockResolvedValue({ status: "SUCCESS", returnValue: {} }),
    ...overrides,
  };
}

describe("joinFundQueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits and returns txHash", async () => {
    const client = makeClient(true);
    Object.assign(client, { rpc: mockRpc() });

    const res = await joinFundQueue(client, LP, 42n);
    expect(res.txHash).toBe("txQUEUE");
  });

  it("throws ILNError.AlreadyInQueue on Error(Contract, 20)", async () => {
    const client = makeClient(true);
    Object.assign(client, {
      rpc: mockRpc({
        simulateTransaction: vi.fn().mockResolvedValue({ error: "Error(Contract, 20)", _parsed: true }),
      }),
    });

    await expect(joinFundQueue(client, LP, 42n)).rejects.toBeInstanceOf(ILNError.AlreadyInQueue);
  });

  it("throws ILNError.NotApprovedFunder on Error(Contract, 21)", async () => {
    const client = makeClient(true);
    Object.assign(client, {
      rpc: mockRpc({
        simulateTransaction: vi.fn().mockResolvedValue({ error: "Error(Contract, 21)", _parsed: true }),
      }),
    });

    await expect(joinFundQueue(client, LP, 42n)).rejects.toBeInstanceOf(ILNError.NotApprovedFunder);
  });

  it("throws when no signer is configured", async () => {
    const client = makeClient(false);
    await expect(joinFundQueue(client, LP, 42n)).rejects.toThrow(
      "joinFundQueue requires a client configured with a signer"
    );
  });
});

describe("resolveFundQueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the approved LP and txHash", async () => {
    mockScValToNative.mockReturnValue(LP);
    const client = makeClient(true);
    Object.assign(client, { rpc: mockRpc() });

    const res = await resolveFundQueue(client, 42n);
    expect(res.approvedLp).toBe(LP);
    expect(res.txHash).toBe("txQUEUE");
  });

  it("throws when no signer is configured", async () => {
    const client = makeClient(false);
    await expect(resolveFundQueue(client, 42n)).rejects.toThrow(
      "resolveFundQueue requires a client configured with a signer"
    );
  });
});
