import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDistributionAccrual, accrueLp, accrueSettlement, claimTokens } from "./distribution.js";
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

import { scValToNative } from "@stellar/stellar-sdk";
const mockScValToNative = scValToNative as vi.Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let VALID_PARTICIPANT: string;
let CONTRACT_ID: string;

beforeAll(() => {
  VALID_PARTICIPANT = Keypair.random().publicKey();
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

describe("getDistributionAccrual", () => {
  it("returns accrued tokens as a number on success", async () => {
    const server = serverWith({ result: { retval: {} } });
    mockScValToNative.mockReturnValue(50000000n);

    const accrual = await getDistributionAccrual(server, CONTRACT_ID, VALID_PARTICIPANT);
    expect(accrual).toBe(50000000);
    expect(typeof accrual).toBe("number");
  });

  it("returns 0 if no retval in simulation", async () => {
    const server = serverWith({ result: { retval: null } });

    const accrual = await getDistributionAccrual(server, CONTRACT_ID, VALID_PARTICIPANT);
    expect(accrual).toBe(0);
  });

  it("throws validation error for invalid contractId or participant address", async () => {
    const server = serverWith({});
    await expect(getDistributionAccrual(server, "invalid", VALID_PARTICIPANT)).rejects.toThrow("Invalid contract ID");
    await expect(getDistributionAccrual(server, CONTRACT_ID, "invalid")).rejects.toThrow("Invalid Stellar address");
  });

  it("throws when simulation returns an error object", async () => {
    const server = serverWith({ error: "simulation crash", _parsed: true });

    await expect(
      getDistributionAccrual(server, CONTRACT_ID, VALID_PARTICIPANT)
    ).rejects.toThrow("get_accrual simulation failed");
  });
});

// ---------------------------------------------------------------------------
// Write operations (#476)
// ---------------------------------------------------------------------------

describe("accrueLp", () => {
  it("submits successfully and returns the tx hash", async () => {
    const server = writeServer({ result: { retval: {} } });
    const account = new Account(VALID_PARTICIPANT, "1");
    const sign = vi.fn((tx) => tx);

    const result = await accrueLp(server, CONTRACT_ID, VALID_PARTICIPANT, 1000n, account, sign);
    expect(result.txHash).toBe("txABC");
    expect(sign).toHaveBeenCalled();
  });

  it("throws validation error for invalid contractId or LP address", async () => {
    const server = writeServer({});
    const account = new Account(VALID_PARTICIPANT, "1");
    await expect(
      accrueLp(server, "invalid", VALID_PARTICIPANT, 1000n, account, vi.fn((tx) => tx))
    ).rejects.toThrow("Invalid contract ID");
    await expect(
      accrueLp(server, CONTRACT_ID, "invalid", 1000n, account, vi.fn((tx) => tx))
    ).rejects.toThrow("Invalid Stellar address");
  });
});

describe("accrueSettlement", () => {
  it("submits successfully and returns the tx hash", async () => {
    const server = writeServer({ result: { retval: {} } });
    const freelancer = VALID_PARTICIPANT;
    const payer = Keypair.random().publicKey();
    const account = new Account(VALID_PARTICIPANT, "1");
    const sign = vi.fn((tx) => tx);

    const result = await accrueSettlement(server, CONTRACT_ID, freelancer, payer, true, account, sign);
    expect(result.txHash).toBe("txABC");
  });

  it("throws validation error for invalid addresses", async () => {
    const server = writeServer({});
    const account = new Account(VALID_PARTICIPANT, "1");
    await expect(
      accrueSettlement(server, CONTRACT_ID, "invalid", VALID_PARTICIPANT, true, account, vi.fn((tx) => tx))
    ).rejects.toThrow("Invalid Stellar address");
  });
});

describe("claimTokens", () => {
  it("claims successfully and returns the tx hash and claimed amount", async () => {
    const server = writeServer({ result: { retval: {} } });
    mockScValToNative.mockReturnValue(2500n);
    const account = new Account(VALID_PARTICIPANT, "1");
    const sign = vi.fn((tx) => tx);

    const result = await claimTokens(server, CONTRACT_ID, VALID_PARTICIPANT, account, sign);
    expect(result.txHash).toBe("txABC");
    expect(result.claimed).toBe(2500n);
  });

  it("throws validation error for invalid claimer address", async () => {
    const server = writeServer({});
    const account = new Account(VALID_PARTICIPANT, "1");
    await expect(
      claimTokens(server, CONTRACT_ID, "invalid", account, vi.fn((tx) => tx))
    ).rejects.toThrow("Invalid Stellar address");
  });
});
