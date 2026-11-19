import { vi, describe, it, expect, beforeEach } from "vitest";
import { ILNError } from "../errors.js";
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
import { disputeInvoice, sha256Hex } from "./disputeInvoice.js";

const mockScValToNative = scValToNative as unknown as vi.Mock;

const PAYER = "GBR7RT4MZTLKK2JNZPOSWVY74VFDR4HVR24QZNH2WONHPQFJZPKHWOTP";
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const PASS = "Test SDF Network ; September 2015";

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

function mockSigner() {
  return {
    publicKey: PAYER,
    signTransaction: vi.fn().mockResolvedValue("signed-xdr"),
  };
}

function mockRpc(overrides: Record<string, unknown> = {}) {
  return {
    getAccount: vi.fn().mockResolvedValue(new Account(PAYER, "1")),
    getNetwork: vi.fn().mockResolvedValue({ passphrase: PASS }),
    simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: {} } }),
    sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING", hash: "txDISPUTE" }),
    ...overrides,
  };
}

describe("disputeInvoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits a dispute for a Funded invoice and returns the evidence hash", async () => {
    mockScValToNative.mockReturnValue(rawInvoice("Funded"));
    const rpc = mockRpc();

    const result = await disputeInvoice({
      rpc: rpc as any,
      contractAddress: CONTRACT,
      signer: mockSigner(),
      invoiceId: 42n,
      evidence: "Payment already settled",
    });

    expect(result.txHash).toBe("txDISPUTE");
    expect(result.evidenceHash).toBe(await sha256Hex("Payment already settled"));
  });

  it("throws when the invoice is not in a disputable status", async () => {
    mockScValToNative.mockReturnValue(rawInvoice("Paid"));
    const rpc = mockRpc();

    await expect(
      disputeInvoice({
        rpc: rpc as any,
        contractAddress: CONTRACT,
        signer: mockSigner(),
        invoiceId: 42n,
        evidence: "too late",
      })
    ).rejects.toThrow("cannot be disputed");
  });

  it("maps simulation errors through ILNError.fromError", async () => {
    mockScValToNative.mockReturnValueOnce(rawInvoice("Funded"));
    const rpc = mockRpc({
      simulateTransaction: vi.fn().mockResolvedValue({ error: "Error(Contract, 23)", _parsed: true }),
    });

    await expect(
      disputeInvoice({
        rpc: rpc as any,
        contractAddress: CONTRACT,
        signer: mockSigner(),
        invoiceId: 42n,
        evidence: "duplicate",
      })
    ).rejects.toBeInstanceOf(ILNError.AlreadyDisputed);
  });
});

describe("sha256Hex", () => {
  it("returns a stable 64-char lower-case hex digest", async () => {
    const hash = await sha256Hex("hello world");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex("hello world")).toBe(hash);
  });
});
