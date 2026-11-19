import { vi, describe, it, expect, beforeEach } from "vitest";
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
import { transferInvoice } from "./transferInvoice.js";

const mockScValToNative = scValToNative as unknown as vi.Mock;

const FREELANCER = "GBR7RT4MZTLKK2JNZPOSWVY74VFDR4HVR24QZNH2WONHPQFJZPKHWOTP";
const NEW_FREELANCER = "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37";
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const PASS = "Test SDF Network ; September 2015";

function rawInvoice(status: string) {
  return {
    id: "42",
    freelancer: FREELANCER,
    payer: FREELANCER,
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
    ...(withSigner ? { signer: { publicKey: FREELANCER, signTransaction: vi.fn().mockResolvedValue("signed-xdr") } } : {}),
  });
}

function mockRpc(overrides: Record<string, unknown> = {}) {
  return {
    getAccount: vi.fn().mockResolvedValue(new Account(FREELANCER, "1")),
    simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: {} } }),
    sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING", hash: "txTRANSFER" }),
    ...overrides,
  };
}

describe("transferInvoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits a transfer for a Pending invoice", async () => {
    mockScValToNative.mockReturnValue(rawInvoice("Pending"));
    const client = makeClient(true);
    Object.assign(client, { rpc: mockRpc() });

    const res = await transferInvoice(client, 42n, NEW_FREELANCER);
    expect(res.txHash).toBe("txTRANSFER");
  });

  it("throws when the invoice is not Pending", async () => {
    mockScValToNative.mockReturnValue(rawInvoice("Funded"));
    const client = makeClient(true);
    Object.assign(client, { rpc: mockRpc() });

    await expect(transferInvoice(client, 42n, NEW_FREELANCER)).rejects.toThrow("not Pending");
  });

  it("throws when no signer is configured", async () => {
    const client = makeClient(false);
    await expect(transferInvoice(client, 42n, NEW_FREELANCER)).rejects.toThrow(
      "transferInvoice requires a client configured with a signer"
    );
  });
});
