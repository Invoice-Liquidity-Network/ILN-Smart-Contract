import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";
import { getTokenDecimals } from "./getTokenDecimals.js";
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

describe("getTokenDecimals", () => {
  const TOKEN_ADDRESS = "CB64D3G7SM2RTH6JSGG34DDTFTQ5CFDKVDZJZF3TDG4BTO3OBKLU6RVQ";

  it("returns the decimals when simulation succeeds", async () => {
    mockScValToNative.mockReturnValue(7);
    const client = mockClientWith({ result: { retval: {} } });

    const decimals = await getTokenDecimals(client, TOKEN_ADDRESS);

    expect(decimals).toBe(7);
    expect(client.rpc.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns null when token is not registered (None returned)", async () => {
    mockScValToNative.mockReturnValue(undefined);
    const client = mockClientWith({ result: { retval: {} } });

    const decimals = await getTokenDecimals(client, TOKEN_ADDRESS);

    expect(decimals).toBeNull();
  });

  it("throws when simulation returns an error", async () => {
    const client = mockClientWith({ error: "Host trap: Contract not found", _parsed: true });

    await expect(getTokenDecimals(client, TOKEN_ADDRESS)).rejects.toThrow("get_token_decimals simulation failed");
  });

  it("throws when simulation returns empty result", async () => {
    const client = mockClientWith({ result: { retval: null } });

    await expect(getTokenDecimals(client, TOKEN_ADDRESS)).rejects.toThrow("get_token_decimals returned empty result");
  });

  it("throws when returned value is not a number", async () => {
    mockScValToNative.mockReturnValue("7");
    const client = mockClientWith({ result: { retval: {} } });

    await expect(getTokenDecimals(client, TOKEN_ADDRESS)).rejects.toThrow("get_token_decimals returned non-number value");
  });
});
