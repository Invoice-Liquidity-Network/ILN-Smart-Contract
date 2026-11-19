import { vi, describe, it, expect, beforeEach } from "vitest";
import { getReferralStats } from "../src/methods/referralStats.js";
import {
  SorobanRpc,
  xdr,
} from "@stellar/stellar-sdk";

function mockSimulationResult(retval: xdr.ScVal | null) {
  return {
    result: retval ? { retval } : undefined,
  };
}

describe("getReferralStats", () => {
  const mockServer = {
    simulateTransaction: vi.fn(),
  } as unknown as SorobanRpc.Server;

  const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  const VALID_HEX = "ab" + "01".repeat(31); // 64 hex chars (32 bytes)
  const VALID_HEX_WITH_PREFIX = "0x" + VALID_HEX;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Success path
  // ---------------------------------------------------------------------------

  it("returns the referral count for a valid hex code", async () => {
    const retval = xdr.ScVal.scvU64(xdr.Uint64.fromString("42"));
    vi.mocked(mockServer.simulateTransaction).mockResolvedValue(
      mockSimulationResult(retval) as any
    );

    const count = await getReferralStats(
      mockServer,
      CONTRACT_ID,
      VALID_HEX
    );

    expect(count).toBe(42);
    expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("strips the 0x prefix and returns the referral count", async () => {
    const retval = xdr.ScVal.scvU64(xdr.Uint64.fromString("7"));
    vi.mocked(mockServer.simulateTransaction).mockResolvedValue(
      mockSimulationResult(retval) as any
    );

    const count = await getReferralStats(
      mockServer,
      CONTRACT_ID,
      VALID_HEX_WITH_PREFIX
    );

    expect(count).toBe(7);
  });

  // ---------------------------------------------------------------------------
  // Zero default
  // ---------------------------------------------------------------------------

  it("returns 0 when the simulation returns no retval", async () => {
    vi.mocked(mockServer.simulateTransaction).mockResolvedValue(
      mockSimulationResult(null) as any
    );

    const count = await getReferralStats(
      mockServer,
      CONTRACT_ID,
      VALID_HEX
    );

    expect(count).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Hex validation errors
  // ---------------------------------------------------------------------------

  it("throws when the hex string is too short", async () => {
    await expect(
      getReferralStats(mockServer, CONTRACT_ID, "abc123")
    ).rejects.toThrow(/invalid referral code/i);
    expect(mockServer.simulateTransaction).not.toHaveBeenCalled();
  });

  it("throws when the hex string is too long", async () => {
    await expect(
      getReferralStats(mockServer, CONTRACT_ID, VALID_HEX + "ff")
    ).rejects.toThrow(/invalid referral code/i);
    expect(mockServer.simulateTransaction).not.toHaveBeenCalled();
  });

  it("throws when the hex string contains non-hex characters", async () => {
    await expect(
      getReferralStats(mockServer, CONTRACT_ID, "z" + "01".repeat(31) + "xy")
    ).rejects.toThrow(/invalid referral code/i);
    expect(mockServer.simulateTransaction).not.toHaveBeenCalled();
  });

  it("throws when the hex string is empty", async () => {
    await expect(
      getReferralStats(mockServer, CONTRACT_ID, "")
    ).rejects.toThrow(/invalid referral code/i);
    expect(mockServer.simulateTransaction).not.toHaveBeenCalled();
  });

  it("throws when given an invalid 0x-prefixed hex string", async () => {
    await expect(
      getReferralStats(mockServer, CONTRACT_ID, "0x123")
    ).rejects.toThrow(/invalid referral code/i);
    expect(mockServer.simulateTransaction).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Simulation errors
  // ---------------------------------------------------------------------------

  it("throws when the simulation returns an error", async () => {
    vi.mocked(mockServer.simulateTransaction).mockResolvedValue({
      error: "Contract error: not found",
    } as any);

    await expect(
      getReferralStats(mockServer, CONTRACT_ID, VALID_HEX)
    ).rejects.toThrow(/simulation failed/i);
  });

  it("throws when the simulation fails with a SorobanRPC error", async () => {
    vi.mocked(mockServer.simulateTransaction).mockResolvedValue({
      error: "Contract error #4",
    } as any);

    await expect(
      getReferralStats(mockServer, CONTRACT_ID, VALID_HEX)
    ).rejects.toThrow(/get_referral_stats simulation failed/i);
  });
});
