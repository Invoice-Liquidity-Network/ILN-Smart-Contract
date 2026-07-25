import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  getPoolBalance,
  getCoverage,
  isEnrolled,
  getPremiumsPaid,
  getInsurancePoolInfo,
  enrollInsurancePool,
  depositInsurancePremium,
  claimInsurance,
  InsuranceContractError,
} from "./insurance.js";
import { SorobanRpc, Keypair, Address, Account } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// vi.mock — patch scValToNative only
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

let VALID_LP: string;
let CONTRACT_ID: string;

beforeAll(() => {
  VALID_LP = Keypair.random().publicKey();
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

describe("getPoolBalance", () => {
  it("returns pool balance on success", async () => {
    const server = serverWith({ result: { retval: {} } });
    mockScValToNative.mockReturnValue(5000n);

    const balance = await getPoolBalance(server, CONTRACT_ID);
    expect(balance).toBe(5000n);
  });

  it("returns 0n if no retval in simulation", async () => {
    const server = serverWith({ result: { retval: null } });

    const balance = await getPoolBalance(server, CONTRACT_ID);
    expect(balance).toBe(0n);
  });

  it("throws validation error for invalid contractId", async () => {
    const server = serverWith({});
    await expect(getPoolBalance(server, "invalid")).rejects.toThrow("Invalid contract ID");
  });

  it("throws InsuranceContractError.PoolEmpty on Error(Contract, 4)", async () => {
    const server = serverWith({ error: "Error(Contract, 4)", _parsed: true });
    await expect(getPoolBalance(server, CONTRACT_ID)).rejects.toBeInstanceOf(
      InsuranceContractError.PoolEmpty
    );
  });
});

describe("getCoverage", () => {
  it("returns coverage on success", async () => {
    const server = serverWith({ result: { retval: {} } });
    mockScValToNative.mockReturnValue(1000n);

    const coverage = await getCoverage(server, CONTRACT_ID);
    expect(coverage).toBe(1000n);
  });

  it("returns 0n if no retval in simulation", async () => {
    const server = serverWith({ result: { retval: null } });

    const coverage = await getCoverage(server, CONTRACT_ID);
    expect(coverage).toBe(0n);
  });

  it("throws validation error for invalid contractId", async () => {
    const server = serverWith({});
    await expect(getCoverage(server, "invalid")).rejects.toThrow("Invalid contract ID");
  });
});

describe("isEnrolled", () => {
  it("returns is_enrolled boolean on success", async () => {
    const server = serverWith({ result: { retval: {} } });
    mockScValToNative.mockReturnValue(true);

    const enrolled = await isEnrolled(server, CONTRACT_ID, VALID_LP);
    expect(enrolled).toBe(true);
  });

  it("returns false if no retval in simulation", async () => {
    const server = serverWith({ result: { retval: null } });

    const enrolled = await isEnrolled(server, CONTRACT_ID, VALID_LP);
    expect(enrolled).toBe(false);
  });

  it("throws validation error for invalid contractId or LP address", async () => {
    const server = serverWith({});
    await expect(isEnrolled(server, "invalid", VALID_LP)).rejects.toThrow("Invalid contract ID");
    await expect(isEnrolled(server, CONTRACT_ID, "invalid")).rejects.toThrow("Invalid Stellar address");
  });
});

describe("getPremiumsPaid", () => {
  it("returns premiums paid on success", async () => {
    const server = serverWith({ result: { retval: {} } });
    mockScValToNative.mockReturnValue(200n);

    const premiums = await getPremiumsPaid(server, CONTRACT_ID, VALID_LP);
    expect(premiums).toBe(200n);
  });

  it("returns 0n if no retval in simulation", async () => {
    const server = serverWith({ result: { retval: null } });

    const premiums = await getPremiumsPaid(server, CONTRACT_ID, VALID_LP);
    expect(premiums).toBe(0n);
  });

  it("throws validation error for invalid contractId or LP address", async () => {
    const server = serverWith({});
    await expect(getPremiumsPaid(server, "invalid", VALID_LP)).rejects.toThrow("Invalid contract ID");
    await expect(getPremiumsPaid(server, CONTRACT_ID, "invalid")).rejects.toThrow("Invalid Stellar address");
  });
});

describe("getInsurancePoolInfo", () => {
  it("combines all pool queries successfully", async () => {
    const server = serverWith({ result: { retval: {} } });
    mockScValToNative
      .mockReturnValueOnce(5000n)  // getPoolBalance
      .mockReturnValueOnce(1000n)  // getCoverage
      .mockReturnValueOnce(true)   // isEnrolled
      .mockReturnValueOnce(200n);  // getPremiumsPaid

    const info = await getInsurancePoolInfo(server, CONTRACT_ID, VALID_LP);
    expect(info).toEqual({
      poolBalance: 5000n,
      coverage: 1000n,
      isEnrolled: true,
      premiumsPaid: 200n,
    });
  });

  it("throws validation error for invalid contractId or LP address", async () => {
    const server = serverWith({});
    await expect(getInsurancePoolInfo(server, "invalid", VALID_LP)).rejects.toThrow("Invalid contract ID");
    await expect(getInsurancePoolInfo(server, CONTRACT_ID, "invalid")).rejects.toThrow("Invalid Stellar address");
  });
});

// ---------------------------------------------------------------------------
// Write operations (#475)
// ---------------------------------------------------------------------------

describe("enrollInsurancePool", () => {
  it("enrolls successfully and returns the tx hash", async () => {
    const server = writeServer({ result: { retval: {} } });
    const account = new Account(VALID_LP, "1");
    const sign = vi.fn((tx) => tx);

    const result = await enrollInsurancePool(server, CONTRACT_ID, VALID_LP, account, sign);
    expect(result.txHash).toBe("txABC");
    expect(sign).toHaveBeenCalled();
  });

  it("throws validation error for invalid LP address", async () => {
    const server = writeServer({});
    const account = new Account(VALID_LP, "1");
    await expect(
      enrollInsurancePool(server, CONTRACT_ID, "invalid", account, vi.fn((tx) => tx))
    ).rejects.toThrow("Invalid Stellar address");
  });
});

describe("depositInsurancePremium", () => {
  it("deposits successfully and returns the tx hash", async () => {
    const server = writeServer({ result: { retval: {} } });
    const account = new Account(VALID_LP, "1");
    const sign = vi.fn((tx) => tx);

    const result = await depositInsurancePremium(server, CONTRACT_ID, VALID_LP, 100n, account, sign);
    expect(result.txHash).toBe("txABC");
  });

  it("throws InvalidAmount for a non-positive amount", async () => {
    const server = writeServer({});
    const account = new Account(VALID_LP, "1");
    await expect(
      depositInsurancePremium(server, CONTRACT_ID, VALID_LP, 0n, account, vi.fn((tx) => tx))
    ).rejects.toThrow(InsuranceContractError.InvalidAmount);
  });
});

describe("claimInsurance", () => {
  it("claims successfully and returns the tx hash and payout", async () => {
    const server = writeServer({ result: { retval: {} } });
    mockScValToNative.mockReturnValue(500n);
    const adminAccount = new Account(VALID_LP, "1");
    const sign = vi.fn((tx) => tx);

    const result = await claimInsurance(server, CONTRACT_ID, 42n, adminAccount, sign);
    expect(result.txHash).toBe("txABC");
    expect(result.payout).toBe(500n);
  });

  it("maps a contract error code to InsuranceContractError.AlreadyClaimed", async () => {
    const server = serverWith({ error: "HostError: Error(Contract, 2)" });
    const adminAccount = new Account(VALID_LP, "1");
    await expect(
      claimInsurance(server, CONTRACT_ID, 42n, adminAccount, vi.fn((tx) => tx))
    ).rejects.toThrow(InsuranceContractError.AlreadyClaimed);
  });
});
