import { vi, describe, it, expect, beforeEach } from "vitest";
import { ILNError } from "../errors.js";
import { ILNClient } from "../client.js";
import { Account } from "@stellar/stellar-sdk";

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");
  return {
    ...actual,
    SorobanRpc: { ...actual.SorobanRpc, assembleTransaction: vi.fn(() => ({ build: () => ({}) })) },
  };
});

import { pause, unpause } from "./adminControls.js";

const ADMIN = "GBR7RT4MZTLKK2JNZPOSWVY74VFDR4HVR24QZNH2WONHPQFJZPKHWOTP";
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const PASS = "Test SDF Network ; September 2015";

function makeClient(withSigner = true) {
  return ILNClient.custom({
    rpcUrl: "https://fake-rpc.example.org",
    networkPassphrase: PASS,
    contractId: CONTRACT,
    ...(withSigner ? { signer: { publicKey: ADMIN, signTransaction: vi.fn().mockResolvedValue("signed-xdr") } } : {}),
  });
}

function mockRpc(overrides: Record<string, unknown> = {}) {
  return {
    getAccount: vi.fn().mockResolvedValue(new Account(ADMIN, "1")),
    simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: {} } }),
    sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING", hash: "txPAUSE" }),
    ...overrides,
  };
}

describe("pause", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits and returns txHash", async () => {
    const client = makeClient(true);
    Object.assign(client, { rpc: mockRpc() });

    const res = await pause(client);
    expect(res.txHash).toBe("txPAUSE");
  });

  it("throws ILNError.Unauthorized when caller is not admin", async () => {
    const client = makeClient(true);
    Object.assign(client, {
      rpc: mockRpc({
        simulateTransaction: vi.fn().mockResolvedValue({ error: "Error(Contract, 5)", _parsed: true }),
      }),
    });

    await expect(pause(client)).rejects.toBeInstanceOf(ILNError.Unauthorized);
  });

  it("throws when no signer is configured", async () => {
    const client = makeClient(false);
    await expect(pause(client)).rejects.toThrow("pause requires a client configured with a signer");
  });
});

describe("unpause", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits and returns txHash", async () => {
    const client = makeClient(true);
    Object.assign(client, { rpc: mockRpc() });

    const res = await unpause(client);
    expect(res.txHash).toBe("txPAUSE");
  });

  it("throws when no signer is configured", async () => {
    const client = makeClient(false);
    await expect(unpause(client)).rejects.toThrow("unpause requires a client configured with a signer");
  });
});
