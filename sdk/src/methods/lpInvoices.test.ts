import { vi, describe, it, expect, beforeEach } from 'vitest';
/**
 * Tests for getLpInvoices().
 *
 * Mocks scValToNative (the only SDK function that touches the simulated
 * retval) so we control decoded output without constructing real ScVals.
 */

import { getLpInvoices } from "./lpInvoices.js";
import { SorobanRpc, Keypair, Address } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// vi.mock — patch scValToNative only
// ---------------------------------------------------------------------------

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");
  return {
    ...actual,
    scValToNative: vi.fn().mockImplementation(actual.scValToNative),
  };
});

import { scValToNative } from "@stellar/stellar-sdk";
const mockScValToNative = scValToNative as vi.Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let LP_ADDRESS: string;
let FREELANCER: string;
let PAYER: string;
let TOKEN: string;
let CONTRACT_ID: string;

function rawInvoice(id: number) {
  return {
    id: String(id),
    freelancer: FREELANCER,
    payer: PAYER,
    token: TOKEN,
    amount: "1000000",
    due_date: Math.floor(Date.now() / 1000) + 86400,
    discount_rate: 300,
    status: "Funded",
    funder: LP_ADDRESS,
    funded_at: Math.floor(Date.now() / 1000),
    amount_funded: "1000000",
    amount_paid: "0",
    referral_code: undefined,
    submitter_reputation: 50,
  };
}

beforeAll(() => {
  LP_ADDRESS = Keypair.random().publicKey();
  FREELANCER = Keypair.random().publicKey();
  PAYER = Keypair.random().publicKey();
  TOKEN = Keypair.random().publicKey();
  const buf = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) buf[i] = i + 1;
  CONTRACT_ID = Address.contract(buf).toString();
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Mock server helpers
// ---------------------------------------------------------------------------

function serverWith(sim: unknown): SorobanRpc.Server {
  return {
    simulateTransaction: vi.fn().mockResolvedValue(sim),
  } as unknown as SorobanRpc.Server;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getLpInvoices — success", () => {
  it("returns a page of decoded invoices", async () => {
    const server = serverWith({ result: { retval: {} } });
    mockScValToNative.mockReturnValue([rawInvoice(1), rawInvoice(2)]);

    const result = await getLpInvoices(server, CONTRACT_ID, LP_ADDRESS);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 1n, freelancer: FREELANCER, payer: PAYER, funder: LP_ADDRESS });
    expect(result[1]).toMatchObject({ id: 2n });
  });

  it("calls simulateTransaction once", async () => {
    const server = serverWith({ result: { retval: {} } });
    mockScValToNative.mockReturnValue([]);

    await getLpInvoices(server, CONTRACT_ID, LP_ADDRESS);
    expect(server.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("defaults page to 0 and pageSize to 10", async () => {
    const server = serverWith({ result: { retval: {} } });
    mockScValToNative.mockReturnValue([]);

    await getLpInvoices(server, CONTRACT_ID, LP_ADDRESS);

    const tx = (server.simulateTransaction as vi.Mock).mock.calls[0][0];
    const args = tx.operations[0].func.invokeContract().args();
    expect(args[1].u32()).toBe(0);
    expect(args[2].u32()).toBe(10);
  });

  it("passes custom page and pageSize through to the contract call", async () => {
    const server = serverWith({ result: { retval: {} } });
    mockScValToNative.mockReturnValue([]);

    await getLpInvoices(server, CONTRACT_ID, LP_ADDRESS, 2, 25);

    const tx = (server.simulateTransaction as vi.Mock).mock.calls[0][0];
    const args = tx.operations[0].func.invokeContract().args();
    expect(args[1].u32()).toBe(2);
    expect(args[2].u32()).toBe(25);
  });
});

describe("getLpInvoices — empty result", () => {
  it("returns an empty array when simulation returns no retval", async () => {
    const server = serverWith({ result: { retval: null } });

    const result = await getLpInvoices(server, CONTRACT_ID, LP_ADDRESS);

    expect(result).toEqual([]);
  });

  it("returns an empty array past the last page", async () => {
    const server = serverWith({ result: { retval: {} } });
    mockScValToNative.mockReturnValue([]);

    const result = await getLpInvoices(server, CONTRACT_ID, LP_ADDRESS, 99, 10);

    expect(result).toEqual([]);
  });
});

describe("getLpInvoices — invalid address", () => {
  const server = serverWith({});

  it("throws for empty string", async () => {
    await expect(getLpInvoices(server, CONTRACT_ID, "")).rejects.toThrow(
      "Invalid Stellar address"
    );
  });

  it("throws for non-G addresses", async () => {
    await expect(
      getLpInvoices(
        server,
        CONTRACT_ID,
        "SAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN"
      )
    ).rejects.toThrow("Invalid Stellar address");
  });
});

describe("getLpInvoices — RPC errors", () => {
  it("throws when simulation returns an error object", async () => {
    const server = serverWith({ error: "contract trap", _parsed: true });

    await expect(getLpInvoices(server, CONTRACT_ID, LP_ADDRESS)).rejects.toThrow(
      "list_invoices_by_lp simulation failed"
    );
  });

  it("propagates RPC connection errors", async () => {
    const server = {
      simulateTransaction: vi
        .fn()
        .mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as SorobanRpc.Server;

    await expect(getLpInvoices(server, CONTRACT_ID, LP_ADDRESS)).rejects.toThrow(
      "connect ECONNREFUSED"
    );
  });
});
