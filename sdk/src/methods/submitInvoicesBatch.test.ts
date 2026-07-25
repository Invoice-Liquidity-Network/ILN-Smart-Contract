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
import { submitInvoicesBatch, type BatchInvoiceItem } from "./submitInvoicesBatch.js";

const mockScValToNative = scValToNative as unknown as vi.Mock;

const FREELANCER = "GBR7RT4MZTLKK2JNZPOSWVY74VFDR4HVR24QZNH2WONHPQFJZPKHWOTP";
const PAYER = "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37";
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const TOKEN = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PASS = "Test SDF Network ; September 2015";

function makeClient() {
  return ILNClient.custom({
    rpcUrl: "https://fake-rpc.example.org",
    networkPassphrase: PASS,
    contractId: CONTRACT,
    signer: { publicKey: FREELANCER, signTransaction: vi.fn().mockResolvedValue("signed-xdr") },
  });
}

function mockRpc(overrides: Record<string, unknown> = {}) {
  return {
    getAccount: vi.fn().mockResolvedValue(new Account(FREELANCER, "1")),
    simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: {} } }),
    sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING", hash: "txBATCH" }),
    getTransaction: vi.fn().mockResolvedValue({
      status: "SUCCESS",
      returnValue: {},
    }),
    ...overrides,
  };
}

function item(overrides: Partial<BatchInvoiceItem> = {}): BatchInvoiceItem {
  return {
    freelancer: FREELANCER,
    payer: PAYER,
    amount: 1000n,
    token: TOKEN,
    discountRate: 300,
    dueDate: Math.floor(Date.now() / 1000) + 86400 * 30,
    ...overrides,
  };
}

describe("submitInvoicesBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits a batch and returns the new invoice IDs", async () => {
    mockScValToNative.mockReturnValue(["1", "2", "3"]);
    const client = makeClient();
    Object.assign(client, { rpc: mockRpc() });

    const res = await submitInvoicesBatch(client, [item(), item(), item()]);
    expect(res.invoiceIds).toEqual([1n, 2n, 3n]);
    expect(res.txHash).toBe("txBATCH");
  });

  it("throws ILNError.BatchTooLarge for more than 10 invoices", async () => {
    const client = makeClient();
    Object.assign(client, { rpc: mockRpc() });

    const invoices = Array.from({ length: 11 }, () => item());
    await expect(submitInvoicesBatch(client, invoices)).rejects.toBeInstanceOf(ILNError.BatchTooLarge);
  });

  it("throws for an empty batch", async () => {
    const client = makeClient();
    Object.assign(client, { rpc: mockRpc() });

    await expect(submitInvoicesBatch(client, [])).rejects.toThrow("at least one invoice");
  });

  it("maps simulation errors through ILNError.fromError", async () => {
    const client = makeClient();
    Object.assign(client, {
      rpc: mockRpc({
        simulateTransaction: vi.fn().mockResolvedValue({ error: "Error(Contract, 9)", _parsed: true }),
      }),
    });

    await expect(submitInvoicesBatch(client, [item()])).rejects.toBeInstanceOf(ILNError.InvoiceDefaulted);
  });

  it("throws when no signer is configured", async () => {
    const client = ILNClient.custom({
      rpcUrl: "https://fake-rpc.example.org",
      networkPassphrase: PASS,
      contractId: CONTRACT,
    });
    await expect(submitInvoicesBatch(client, [item()])).rejects.toThrow(
      "submitInvoicesBatch requires a client configured with a signer"
    );
  });
});
