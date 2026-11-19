import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isValidGAddress,
  resolveFederationAddress,
  friendbotFund,
  truncateAddress,
} from "./stellarHelpers.js";

// ── isValidGAddress ───────────────────────────────────────────────────────────

describe("isValidGAddress", () => {
  const valid = "GABCD123456789012345678901234567890123456789012345678901";

  it("returns true for a 56-char G-address", () => {
    expect(isValidGAddress(valid)).toBe(true);
  });

  it("returns false when shorter than 56 chars", () => {
    expect(isValidGAddress("GABCD")).toBe(false);
  });

  it("returns false when longer than 56 chars", () => {
    expect(isValidGAddress(valid + "X")).toBe(false);
  });

  it("returns false when it does not start with G", () => {
    const cAddress = "C" + valid.slice(1);
    expect(isValidGAddress(cAddress)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isValidGAddress("")).toBe(false);
  });

  it("returns false for non-string input", () => {
    expect(isValidGAddress(null as unknown as string)).toBe(false);
    expect(isValidGAddress(undefined as unknown as string)).toBe(false);
    expect(isValidGAddress(123 as unknown as string)).toBe(false);
  });
});

// ── resolveFederationAddress ──────────────────────────────────────────────────

describe("resolveFederationAddress", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns stellar_address from a successful federation lookup", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ stellar_address: "alice*iln.network" }),
    });

    const result = await resolveFederationAddress(
      "GABCD1234567890123456789012345678901234567890123456789012"
    );
    expect(result).toBe("alice*iln.network");
  });

  it("returns null when the federation server returns a non-OK response", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });

    const result = await resolveFederationAddress(
      "GABCD1234567890123456789012345678901234567890123456789012"
    );
    expect(result).toBeNull();
  });

  it("returns null when stellar_address is absent from the response", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const result = await resolveFederationAddress(
      "GABCD1234567890123456789012345678901234567890123456789012"
    );
    expect(result).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network error")
    );

    const result = await resolveFederationAddress(
      "GABCD1234567890123456789012345678901234567890123456789012"
    );
    expect(result).toBeNull();
  });
});

// ── friendbotFund ─────────────────────────────────────────────────────────────

describe("friendbotFund", () => {
  const address = "GABCD1234567890123456789012345678901234567890123456789012";

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    delete process.env.STELLAR_NETWORK;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.STELLAR_NETWORK;
  });

  it("calls Friendbot and resolves on success", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

    await expect(friendbotFund(address)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("friendbot.stellar.org")
    );
  });

  it("throws when Friendbot returns a non-OK response", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"detail":"already funded"}',
    });

    await expect(friendbotFund(address)).rejects.toThrow("Friendbot failed");
  });

  it("throws immediately when STELLAR_NETWORK is mainnet", async () => {
    process.env.STELLAR_NETWORK = "mainnet";

    await expect(friendbotFund(address)).rejects.toThrow(
      "must not be called on mainnet"
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ── truncateAddress ───────────────────────────────────────────────────────────

describe("truncateAddress", () => {
  const addr = "GABCD1234567890123456789012345678901234567890123456789012";

  it("truncates a long address to start...end", () => {
    const result = truncateAddress(addr, 4);
    expect(result).toBe("GABC...9012");
  });

  it("uses 4 chars per side by default", () => {
    const result = truncateAddress(addr);
    expect(result.length).toBeLessThan(addr.length);
    expect(result).toContain("...");
  });

  it("returns the full string when it is short enough to skip truncation", () => {
    const short = "GABCD";
    expect(truncateAddress(short, 4)).toBe(short);
  });

  it("returns empty string for empty input", () => {
    expect(truncateAddress("")).toBe("");
  });

  it("returns empty string for non-string input", () => {
    expect(truncateAddress(null as unknown as string)).toBe("");
  });

  it("honours the chars parameter", () => {
    const result = truncateAddress(addr, 6);
    expect(result.startsWith("GABCD1")).toBe(true);
    expect(result.endsWith("789012")).toBe(true);
  });
});
