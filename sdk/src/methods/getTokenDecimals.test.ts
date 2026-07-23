import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";
import { getTokenDecimals } from "./getTokenDecimals.js";
import { SorobanRpc, Keypair, Address } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// vi.mock — patch scValToNative only
// ---------------------------------------------------------------------------

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>(
    "@stellar/stellar-sdk"
  );
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

let VALID_TOKEN: string;
let CONTRACT_ID: string;

beforeAll(() => {
  VALID_TOKEN = Keypair.random().publicKey(); // G… address
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

describe("getTokenDecimals", () => {
  it("returns the registered decimal precision on success", async () => {
    const server = serverWith({ result: { retval: {} } });
    mockScValToNative.mockReturnValue(6);

    const decimals = await getTokenDecimals(server, CONTRACT_ID, VALID_TOKEN);
    expect(decimals).toBe(6);
  });

  it("returns null when the token is not registered (Option None)", async () => {
    const server = serverWith({ result: { retval: {} } });
    mockScValToNative.mockReturnValue(null);

    const decimals = await getTokenDecimals(server, CONTRACT_ID, VALID_TOKEN);
    expect(decimals).toBeNull();
  });

  it("returns null when the simulation has no retval", async () => {
    const server = serverWith({ result: { retval: null } });

    const decimals = await getTokenDecimals(server, CONTRACT_ID, VALID_TOKEN);
    expect(decimals).toBeNull();
  });

  it("throws validation error for an invalid contractId", async () => {
    const server = serverWith({});
    await expect(
      getTokenDecimals(server, "invalid", VALID_TOKEN)
    ).rejects.toThrow("Invalid contract ID");
  });

  it("throws validation error for an invalid token address", async () => {
    const server = serverWith({});
    await expect(
      getTokenDecimals(server, CONTRACT_ID, "invalid")
    ).rejects.toThrow("Invalid Stellar address");
  });

  it("rejects on simulation error", async () => {
    const server = serverWith({
      error: "simulation failed",
      events: [],
      results: [],
      latestLedger: "0",
    });
    await expect(
      getTokenDecimals(server, CONTRACT_ID, VALID_TOKEN)
    ).rejects.toThrow("get_token_decimals simulation failed");
  });
});
