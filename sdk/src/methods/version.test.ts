import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";
import { getVersion } from "./version.js";
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

describe("getVersion", () => {
  it("returns the version string when simulation succeeds", async () => {
    mockScValToNative.mockReturnValue("1.0.0");
    const client = mockClientWith({ result: { retval: {} } });

    const version = await getVersion(client);

    expect(version).toBe("1.0.0");
    expect(client.rpc.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("throws when simulation returns an error (e.g., contract not deployed)", async () => {
    const client = mockClientWith({ error: "Host trap: Contract not found", _parsed: true });

    await expect(getVersion(client)).rejects.toThrow("get_version simulation failed");
  });

  it("throws when simulation returns empty result", async () => {
    const client = mockClientWith({ result: { retval: null } });

    await expect(getVersion(client)).rejects.toThrow("get_version returned empty result");
  });

  it("throws when returned value is not a string", async () => {
    mockScValToNative.mockReturnValue(123);
    const client = mockClientWith({ result: { retval: {} } });

    await expect(getVersion(client)).rejects.toThrow("get_version returned non-string value");
  });
});
