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
import { appealInvoice, resolveAppeal } from "./appeal.js";

const mockScValToNative = scValToNative as unknown as vi.Mock;

const PAYER = "GBR7RT4MZTLKK2JNZPOSWVY74VFDR4HVR24QZNH2WONHPQFJZPKHWOTP";
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const PASS = "Test SDF Network ; September 2015";
const HASH32 = "ab".repeat(32);

function rawInvoice(status: string) {
  return {
    id: "42",
    freelancer: PAYER,
    payer: PAYER,
    token: CONTRACT,
    amount: "1000",
    due_date: "1700000000",
    discount_rate: "300",
    status: { tag: status },
    amount_funded: "0",
    amount_paid: "0",
    submitter_reputation: "50",
  };
}

function makeClient(withSigner = true) {
  return ILNClient.custom({
    rpcUrl: "https://fake-rpc.example.org",
    networkPassphrase: PASS,
    contractId: CONTRACT,
    ...(withSigner ? { signer: { publicKey: PAYER, signTransaction: vi.fn().mockResolvedValue("signed-xdr") } } : {}),
  });
}

function mockRpc(overrides: Record<string, unknown> = {}) {
  return {
    getAccount: vi.fn().mockResolvedValue(new Account(PAYER, "1")),
    simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: {} } }),
    sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING", hash: "txAPPEAL" }),
    getTransaction: vi.fn().mockResolvedValue({ status: "SUCCESS", returnValue: {} }),
    ...overrides,
  };
}

describe("appealInvoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits an appeal for a Defaulted invoice", async () => {
    mockScValToNative.mockReturnValue(rawInvoice("Defaulted"));
    const client = makeClient(true);
    Object.assign(client, { rpc: mockRpc() });

    const res = await appealInvoice(client, 42n, HASH32);
    expect(res.txHash).toBe("txAPPEAL");
  });

  it("throws ILNError.NotDefaulted when the invoice is not Defaulted", async () => {
    mockScValToNative.mockReturnValue(rawInvoice("Pending"));
    const client = makeClient(true);
    Object.assign(client, { rpc: mockRpc() });

    await expect(appealInvoice(client, 42n, HASH32)).rejects.toBeInstanceOf(ILNError.NotDefaulted);
  });

  it("throws when no signer is configured", async () => {
    const client = makeClient(false);
    await expect(appealInvoice(client, 42n, HASH32)).rejects.toThrow(
      "appealInvoice requires a client configured with a signer"
    );
  });
});

describe("resolveAppeal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits an Upheld resolution", async () => {
    const client = makeClient(true);
    Object.assign(client, { rpc: mockRpc() });

    const res = await resolveAppeal(client, 42n, true);
    expect(res.txHash).toBe("txAPPEAL");
  });

  it("submits a Rejected resolution", async () => {
    const client = makeClient(true);
    Object.assign(client, { rpc: mockRpc() });

    const res = await resolveAppeal(client, 42n, false);
    expect(res.txHash).toBe("txAPPEAL");
  });

  it("maps simulation errors through ILNError.fromError", async () => {
    const client = makeClient(true);
    Object.assign(client, {
      rpc: mockRpc({
        simulateTransaction: vi.fn().mockResolvedValue({ error: "Error(Contract, 19)", _parsed: true }),
      }),
    });

    await expect(resolveAppeal(client, 42n, true)).rejects.toBeInstanceOf(ILNError.NotDefaulted);
  });

  it("throws when no signer is configured", async () => {
    const client = makeClient(false);
    await expect(resolveAppeal(client, 42n, true)).rejects.toThrow(
      "resolveAppeal requires a client configured with a signer"
    );
  });
});
