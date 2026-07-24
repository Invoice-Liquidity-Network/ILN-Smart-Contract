import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";
import { getLpScore } from "./getLpScore.js";
import { ILNClient } from "../client.js";
import { scValToNative, Address } from "@stellar/stellar-sdk";

// Mock scValToNative so we can control the decoded result
vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");
  return {
    ...actual,
    scValToNative: vi.fn().mockImplementation(actual.scValToNative),
  };
});

const mockScValToNative = scValToNative as vi.Mock;

let CONTRACT_ID: string;

beforeAll(() => {
  const buf = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) buf[i] = i + 1;
  CONTRACT_ID = Address.contract(buf).toString();
});

beforeEach(() => {
  vi.clearAllMocks();
});

function mockClientWith(sim: unknown): ILNClient {
  const client = ILNClient.custom({
    rpcUrl: "https://mock-rpc.stellar.org",
    networkPassphrase: "Mock Network",
    contractId: CONTRACT_ID,
  });
  client.rpc.simulateTransaction = vi.fn().mockResolvedValue(sim);
  return client;
}

describe("getLpScore", () => {
  const LP_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

  it("returns the LP score when simulation succeeds", async () => {
    mockScValToNative.mockReturnValue(72);
    const client = mockClientWith({ result: { retval: {} } });

    const score = await getLpScore(client, LP_ADDRESS);

    expect(score).toBe(72);
    expect(client.rpc.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns the default baseline for an unknown LP", async () => {
    mockScValToNative.mockReturnValue(50);
    const client = mockClientWith({ result: { retval: {} } });

    const score = await getLpScore(client, LP_ADDRESS);

    expect(score).toBe(50);
  });

  it("throws when simulation returns an error", async () => {
    const client = mockClientWith({ error: "Host trap: Contract not found", _parsed: true });

    await expect(getLpScore(client, LP_ADDRESS)).rejects.toThrow("lp_score simulation failed");
  });

  it("throws when simulation returns empty result", async () => {
    const client = mockClientWith({ result: { retval: null } });

    await expect(getLpScore(client, LP_ADDRESS)).rejects.toThrow("lp_score returned empty result");
  });

  it("throws when returned value is not a number", async () => {
    mockScValToNative.mockReturnValue("50");
    const client = mockClientWith({ result: { retval: {} } });

    await expect(getLpScore(client, LP_ADDRESS)).rejects.toThrow("lp_score returned non-number value");
  });
});
