import { vi, describe, it, expect, beforeEach} from 'vitest';
/**
 * Tests for getContractStats().
 *
 * Mocks scValToNative so we control decoded output. Everything else
 * is the real Stellar SDK.
 */

import { getContractStats } from "./stats.js";
import { SorobanRpc, Address } from "@stellar/stellar-sdk";

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

let CONTRACT_ID: string;

beforeAll(() => {
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

const MOCK_STATS_RAW = {
  total_invoices: "42",
  total_funded: "30",
  total_paid: "25",
  total_volume_usdc: "1000000000",
  total_volume_eurc: "500000000",
  total_volume_xlm: "20000000000",
  token_volumes: [
    ["CDTOKENUSDC000", "1000000000"],
    ["CDTOKENEURC000", "500000000"],
    ["CDTOKENXLM00000", "20000000000"],
  ],
  total_volume_usd_normalized: "1750000000",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getContractStats — populated contract", () => {
  beforeEach(() => {
    mockScValToNative.mockReturnValue(MOCK_STATS_RAW);
  });

  it("returns a fully populated ContractStats object", async () => {
    const server = serverWith({ result: { retval: {} } });

    const stats = await getContractStats(server, CONTRACT_ID);

    expect(stats.totalInvoices).toBe(42n);
    expect(stats.totalFunded).toBe(30n);
    expect(stats.totalPaid).toBe(25n);
    expect(stats.totalVolumeUsdc).toBe(1_000_000_000n);
    expect(stats.totalVolumeEurc).toBe(500_000_000n);
    expect(stats.totalVolumeXlm).toBe(20_000_000_000n);
    expect(stats.totalVolumeUsdNormalized).toBe(1_750_000_000n);
  });

  it("parses token_volumes into volumeByToken map", async () => {
    const server = serverWith({ result: { retval: {} } });

    const stats = await getContractStats(server, CONTRACT_ID);

    expect(stats.volumeByToken).toEqual({
      CDTOKENUSDC000: 1_000_000_000n,
      CDTOKENEURC000: 500_000_000n,
      CDTOKENXLM00000: 20_000_000_000n,
    });
  });

  it("calls simulateTransaction once", async () => {
    const server = serverWith({ result: { retval: {} } });

    await getContractStats(server, CONTRACT_ID);
    expect(server.simulateTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("getContractStats — empty contract", () => {
  it("returns zeroed stats when simulation returns no retval", async () => {
    const server = serverWith({ result: { retval: null } });

    const stats = await getContractStats(server, CONTRACT_ID);

    expect(stats.totalInvoices).toBe(0n);
    expect(stats.totalFunded).toBe(0n);
    expect(stats.totalPaid).toBe(0n);
    expect(stats.totalVolumeUsdc).toBe(0n);
    expect(stats.volumeByToken).toEqual({});
    expect(stats.totalVolumeUsdNormalized).toBe(0n);
  });

  it("handles missing token_volumes gracefully", async () => {
    const server = serverWith({ result: { retval: {} } });
    mockScValToNative.mockReturnValue({
      total_invoices: "1",
      total_funded: "1",
      total_paid: "1",
      total_volume_usdc: "0",
      total_volume_eurc: "0",
      total_volume_xlm: "0",
      total_volume_usd_normalized: "0",
    });

    const stats = await getContractStats(server, CONTRACT_ID);
    expect(stats.volumeByToken).toEqual({});
    expect(stats.totalInvoices).toBe(1n);
  });

  it("handles non-array token_volumes gracefully", async () => {
    const server = serverWith({ result: { retval: {} } });
    mockScValToNative.mockReturnValue({
      total_invoices: "5",
      total_funded: "3",
      total_paid: "2",
      total_volume_usdc: "100",
      total_volume_eurc: "0",
      total_volume_xlm: "0",
      token_volumes: "not-an-array",
      total_volume_usd_normalized: "100",
    });

    const stats = await getContractStats(server, CONTRACT_ID);
    expect(stats.volumeByToken).toEqual({});
    expect(stats.totalInvoices).toBe(5n);
  });
});

describe("getContractStats — RPC errors", () => {
  it("throws when simulation returns an error object", async () => {
    const server = serverWith({ error: "host trap", _parsed: true });

    await expect(
      getContractStats(server, CONTRACT_ID)
    ).rejects.toThrow("get_contract_stats simulation failed");
  });

  it("propagates RPC connection errors", async () => {
    const server = {
      simulateTransaction: vi
        .fn()
        .mockRejectedValue(new Error("fetch failed")),
    } as unknown as SorobanRpc.Server;

    await expect(getContractStats(server, CONTRACT_ID)).rejects.toThrow(
      "fetch failed"
    );
  });
});
