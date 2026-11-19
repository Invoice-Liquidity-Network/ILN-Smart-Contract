import { vi, describe, it, expect, beforeEach } from 'vitest';
/**
 * Tests for getTopPayers().
 *
 * Mocks scValToNative (the only SDK function that touches the simulated
 * retval) so we control decoded output without constructing real ScVals.
 */

import { getTopPayers } from "./topPayers.js";
import type { TopPayerEntry } from "./topPayers.js";
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

let ADDRESS_A: string;
let ADDRESS_B: string;
let CONTRACT_ID: string;

beforeAll(() => {
  ADDRESS_A = Keypair.random().publicKey();
  ADDRESS_B = Keypair.random().publicKey();
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

describe("getTopPayers — success", () => {
  it("returns entries sorted by descending score", async () => {
    const server = serverWith({ result: { retval: {} } });
    mockScValToNative.mockReturnValue([
      { address: ADDRESS_A, score: 90 },
      { address: ADDRESS_B, score: 42 },
    ]);

    const result = await getTopPayers(server, CONTRACT_ID);

    expect(result).toEqual<TopPayerEntry[]>([
      { address: ADDRESS_A, score: 90 },
      { address: ADDRESS_B, score: 42 },
    ]);
  });

  it("calls simulateTransaction once", async () => {
    const server = serverWith({ result: { retval: {} } });
    mockScValToNative.mockReturnValue([]);

    await getTopPayers(server, CONTRACT_ID);
    expect(server.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("defaults limit to 10 when not provided", async () => {
    const server = serverWith({ result: { retval: {} } });
    mockScValToNative.mockReturnValue([]);

    await getTopPayers(server, CONTRACT_ID);

    const tx = (server.simulateTransaction as vi.Mock).mock.calls[0][0];
    const op = tx.operations[0];
    expect(op.func.invokeContract().args()[0].u32()).toBe(10);
  });

  it("passes a custom limit through to the contract call", async () => {
    const server = serverWith({ result: { retval: {} } });
    mockScValToNative.mockReturnValue([]);

    await getTopPayers(server, CONTRACT_ID, 3);

    const tx = (server.simulateTransaction as vi.Mock).mock.calls[0][0];
    const op = tx.operations[0];
    expect(op.func.invokeContract().args()[0].u32()).toBe(3);
  });
});

describe("getTopPayers — empty result", () => {
  it("returns an empty array when simulation returns no retval", async () => {
    const server = serverWith({ result: { retval: null } });

    const result = await getTopPayers(server, CONTRACT_ID);

    expect(result).toEqual([]);
  });

  it("returns an empty array when the heap is empty", async () => {
    const server = serverWith({ result: { retval: {} } });
    mockScValToNative.mockReturnValue([]);

    const result = await getTopPayers(server, CONTRACT_ID);

    expect(result).toEqual([]);
  });
});

describe("getTopPayers — RPC errors", () => {
  it("throws when simulation returns an error object", async () => {
    const server = serverWith({ error: "contract trap", _parsed: true });

    await expect(getTopPayers(server, CONTRACT_ID)).rejects.toThrow(
      "get_top_payers simulation failed"
    );
  });

  it("propagates RPC connection errors", async () => {
    const server = {
      simulateTransaction: vi
        .fn()
        .mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as SorobanRpc.Server;

    await expect(getTopPayers(server, CONTRACT_ID)).rejects.toThrow(
      "connect ECONNREFUSED"
    );
  });
});
