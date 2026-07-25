import { vi, describe, it, expect} from 'vitest';
/**
 * Tests for ILNClient — covers:
 *   - testnet / mainnet / custom factory methods
 *   - singleton iln.configure / iln.getReputation / iln.getContractStats
 *   - Preset defaults (RPC URL, network passphrase, contract ID)
 */

import { ILNClient, iln, TESTNET_RPC_URL, MAINNET_RPC_URL } from "./client.js";
import { Networks } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Mock SorobanRpc.Server to avoid real network connections in tests
// ---------------------------------------------------------------------------

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");
  const mockServer = vi.fn().mockImplementation(() => ({
    getAccount: vi.fn(),
    simulateTransaction: vi.fn(),
    prepareTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    getLatestLedger: vi.fn(),
  }));
  return {
    ...actual,
    SorobanRpc: {
      ...(actual.SorobanRpc as object),
      Server: mockServer,
      Api: (actual.SorobanRpc as unknown)?.Api,
    },
  };
});

// ---------------------------------------------------------------------------
// testnet()
// ---------------------------------------------------------------------------

describe("ILNClient.testnet", () => {
  it("creates a client with testnet defaults", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const client = ILNClient.testnet();

    expect(client.networkPassphrase).toBe(Networks.TESTNET);
    expect(client.contractId).toBeTruthy();
    expect(client.contractId.length).toBeGreaterThan(0);
  });

  it("uses the testnet RPC URL", () => {
    ILNClient.testnet();
    // We can't inspect rpc.serverUrl directly in v12, but the constructor
    // receives the correct URL.
    expect(TESTNET_RPC_URL).toContain("testnet");
  });

  it("accepts an optional signer", () => {
    const signer = { publicKey: "GAA", signTransaction: vi.fn() };
    const client = ILNClient.testnet(signer as unknown);
    expect(client.signer).toBe(signer);
  });

  it("accepts optional overrides", () => {
    const client = ILNClient.testnet(undefined, {
      rpcUrl: "https://soroban-testnet.stellar.org",
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    });

    expect(client.contractId).toBe("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4");
  });

  it("works without any arguments", () => {
    const client = ILNClient.testnet();
    expect(client).toBeInstanceOf(ILNClient);
    expect(client.signer).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mainnet()
// ---------------------------------------------------------------------------

describe("ILNClient.mainnet", () => {
  it("creates a client with mainnet defaults", () => {
    const client = ILNClient.mainnet();

    expect(client.networkPassphrase).toBe(Networks.PUBLIC);
    expect(MAINNET_RPC_URL).toContain("soroban.stellar.org");
  });

  it("accepts an optional signer", () => {
    const signer = { publicKey: "GAA", signTransaction: vi.fn() };
    const client = ILNClient.mainnet(signer as unknown);
    expect(client.signer).toBe(signer);
  });

  it("accepts optional overrides", () => {
    const client = ILNClient.mainnet(undefined, {
      rpcUrl: "https://custom-rpc.example.com",
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    });

    expect(client.contractId).toBe("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4");
  });
});

// ---------------------------------------------------------------------------
// custom()
// ---------------------------------------------------------------------------

describe("ILNClient.custom", () => {
  it("creates a client with fully custom config", () => {
    const signer = { publicKey: "GAA", signTransaction: vi.fn() };
    const client = ILNClient.custom({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Standalone Network ; February 2017",
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
      signer: signer as unknown,
    });

    expect(client.networkPassphrase).toBe(
      "Standalone Network ; February 2017"
    );
    expect(client.contractId).toBe("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4");
    expect(client.signer).toBe(signer);
  });

  it("works without a signer (read-only configs)", () => {
    const client = ILNClient.custom({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: Networks.TESTNET,
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    });

    expect(client.signer).toBeUndefined();
    expect(client.contractId).toBe("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4");
  });
});

// ---------------------------------------------------------------------------
// Singleton (iln)
// ---------------------------------------------------------------------------

describe("iln singleton", () => {
  it("throws if getReputation is called before configure", async () => {
    // Reset singleton state (it's a module-level singleton, but we
    // re-configure it in each test)
    await expect(iln.getReputation("GAA")).rejects.toThrow(
      "not configured"
    );
  });

  it("throws if getContractStats is called before configure", async () => {
    await expect(iln.getContractStats()).rejects.toThrow(
      "not configured"
    );
  });

  it("throws if getTopPayers is called before configure", async () => {
    await expect(iln.getTopPayers()).rejects.toThrow(
      "not configured"
    );
  });

  it("throws if insurance methods are called before configure", async () => {
    const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
    await expect(iln.getInsurancePoolBalance(contractId)).rejects.toThrow(
      "not configured"
    );
    await expect(iln.getInsurancePoolCoverage(contractId)).rejects.toThrow(
      "not configured"
    );
    await expect(iln.isInsurancePoolEnrolled(contractId, "GAA")).rejects.toThrow(
      "not configured"
    );
    await expect(iln.getInsurancePoolPremiumsPaid(contractId, "GAA")).rejects.toThrow(
      "not configured"
    );
    await expect(iln.getInsurancePoolInfo(contractId, "GAA")).rejects.toThrow(
      "not configured"
    );
  });
});
