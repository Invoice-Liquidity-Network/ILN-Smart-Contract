import { vi, describe, it, expect, beforeEach} from 'vitest';
/**
 * Tests for getReputation().
 *
 * Mocks scValToNative (the only SDK function that touches the simulated
 * retval) so we control decoded output without constructing real ScVals.
 * Address and Contract use the real SDK — a valid contract C-address is
 * generated via Address.contract() so Contract.call() passes validation.
 */

import {
  getReputation,
  submitReputationInvoice,
  markReputationInvoicePaid,
  handleDefault,
  ReputationContractError,
} from "./reputation.js";
import type { ReputationProfile } from "./reputation.js";
import { SorobanRpc, Keypair, Address, Account } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// vi.mock — patch scValToNative + assembleTransaction
// ---------------------------------------------------------------------------

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");
  return {
    ...actual,
    scValToNative: vi.fn().mockImplementation(actual.scValToNative),
    SorobanRpc: {
      ...(actual.SorobanRpc as object),
      Api: (actual.SorobanRpc as unknown as { Api: unknown }).Api,
      assembleTransaction: vi.fn(() => ({ build: () => ({}) })),
    },
  };
});

// After the mock, the import above binds to the mocked version
import { scValToNative } from "@stellar/stellar-sdk";
const mockScValToNative = scValToNative as vi.Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let VALID_GA: string;
let CONTRACT_ID: string;

beforeAll(() => {
  VALID_GA = Keypair.random().publicKey();
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

function writeServer(sim: unknown): SorobanRpc.Server {
  return {
    simulateTransaction: vi.fn().mockResolvedValue(sim),
    sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING", hash: "txABC" }),
    getTransaction: vi.fn().mockResolvedValue({
      status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
    }),
  } as unknown as SorobanRpc.Server;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getReputation — known address", () => {
  it("returns a populated profile on success", async () => {
    const server = serverWith({ result: { retval: {} } });
    mockScValToNative.mockReturnValue({
      address: VALID_GA,
      score: 75,
      invoices_submitted: 12,
      invoices_paid: 8,
      invoices_defaulted: 1,
    });

    const result = await getReputation(server, CONTRACT_ID, VALID_GA);

    expect(result).toMatchObject<ReputationProfile>({
      address: VALID_GA,
      score: 75,
      invoicesSubmitted: 12,
      invoicesPaid: 8,
      invoicesDefaulted: 1,
    });
  });

  it("calls simulateTransaction once", async () => {
    const server = serverWith({ result: { retval: {} } });
    mockScValToNative.mockReturnValue({
      address: VALID_GA,
      score: 0,
      invoices_submitted: 0,
      invoices_paid: 0,
      invoices_defaulted: 0,
    });

    await getReputation(server, CONTRACT_ID, VALID_GA);
    expect(server.simulateTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("getReputation — unknown address", () => {
  it("returns zeroed profile when simulation returns no retval", async () => {
    const server = serverWith({ result: { retval: null } });

    const result = await getReputation(server, CONTRACT_ID, VALID_GA);

    expect(result).toMatchObject<ReputationProfile>({
      address: VALID_GA,
      score: 0,
      invoicesSubmitted: 0,
      invoicesPaid: 0,
      invoicesDefaulted: 0,
    });
  });
});

describe("getReputation — invalid address", () => {
  const server = serverWith({});

  it("throws for empty string", async () => {
    await expect(getReputation(server, CONTRACT_ID, "")).rejects.toThrow(
      "Invalid Stellar address"
    );
  });

  it("throws for non-G addresses", async () => {
    await expect(
      getReputation(
        server,
        CONTRACT_ID,
        "SAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN"
      )
    ).rejects.toThrow("Invalid Stellar address");
  });

  it("throws for short addresses", async () => {
    await expect(
      getReputation(server, CONTRACT_ID, "GABC")
    ).rejects.toThrow("Invalid Stellar address");
  });
});

describe("getReputation — RPC errors", () => {
  it("throws when simulation returns an error object", async () => {
    const server = serverWith({ error: "contract trap", _parsed: true });

    await expect(
      getReputation(server, CONTRACT_ID, VALID_GA)
    ).rejects.toThrow("get_reputation simulation failed");
  });

  it("propagates RPC connection errors", async () => {
    const server = {
      simulateTransaction: vi
        .fn()
        .mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as SorobanRpc.Server;

    await expect(
      getReputation(server, CONTRACT_ID, VALID_GA)
    ).rejects.toThrow("connect ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// reputation_bonus write operations (#477)
// ---------------------------------------------------------------------------

describe("submitReputationInvoice", () => {
  it("submits successfully and returns the tx hash", async () => {
    const server = writeServer({ result: { retval: {} } });
    const payer = Keypair.random().publicKey();
    const account = new Account(VALID_GA, "1");
    const sign = vi.fn((tx) => tx);

    const result = await submitReputationInvoice(
      server, CONTRACT_ID, VALID_GA, payer, 1000n, 1_800_000_000n, 500, account, sign
    );
    expect(result.txHash).toBe("txABC");
    expect(sign).toHaveBeenCalled();
  });

  it("throws for an invalid freelancer or payer address", async () => {
    const server = writeServer({});
    const account = new Account(VALID_GA, "1");
    await expect(
      submitReputationInvoice(
        server, CONTRACT_ID, "invalid", VALID_GA, 1000n, 1_800_000_000n, 500, account, vi.fn((tx) => tx)
      )
    ).rejects.toThrow("Invalid Stellar address");
  });
});

describe("markReputationInvoicePaid", () => {
  it("submits successfully and returns the tx hash", async () => {
    const server = writeServer({ result: { retval: {} } });
    const account = new Account(VALID_GA, "1");
    const sign = vi.fn((tx) => tx);

    const result = await markReputationInvoicePaid(server, CONTRACT_ID, 7n, account, sign);
    expect(result.txHash).toBe("txABC");
  });

  it("maps a contract error code to ReputationContractError.InvoiceNotFound", async () => {
    const server = serverWith({ error: "HostError: Error(Contract, 2)" });
    const account = new Account(VALID_GA, "1");
    await expect(
      markReputationInvoicePaid(server, CONTRACT_ID, 7n, account, vi.fn((tx) => tx))
    ).rejects.toThrow(ReputationContractError.InvoiceNotFound);
  });
});

describe("handleDefault", () => {
  it("submits successfully and returns the tx hash", async () => {
    const server = writeServer({ result: { retval: {} } });
    const account = new Account(VALID_GA, "1");
    const sign = vi.fn((tx) => tx);

    const result = await handleDefault(server, CONTRACT_ID, 7n, account, sign);
    expect(result.txHash).toBe("txABC");
  });
});
