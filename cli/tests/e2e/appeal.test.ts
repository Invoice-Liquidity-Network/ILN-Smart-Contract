import { describe, expect, it, vi } from "vitest";
import { makeAppealCommand } from "../../src/commands/appeal";

const HASH = "ab".repeat(32);
describe("iln appeal", () => {
  it("validates the invoice and submits normalized evidence", async () => {
    const fetcher = vi.fn().mockResolvedValue({ id: "42", status: "Defaulted" });
    const executor = vi.fn().mockResolvedValue({ invoiceId: "42", txHash: "TXAPPEAL" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await makeAppealCommand(fetcher, executor).parseAsync(
      ["--invoice-id", "42", "--evidence-hash", `0x${HASH.toUpperCase()}`],
      { from: "user" }
    );
    expect(fetcher).toHaveBeenCalledWith("42");
    expect(executor).toHaveBeenCalledWith("42", HASH, undefined);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("TXAPPEAL"));
    vi.restoreAllMocks();
  });

  it("does not submit an appeal for a non-defaulted invoice", async () => {
    const executor = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await makeAppealCommand(vi.fn().mockResolvedValue({ id: "42", status: "Funded" }), executor)
      .parseAsync(["--invoice-id", "42", "--evidence-hash", HASH], { from: "user" });
    expect(executor).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("rejects malformed evidence before reading the invoice", async () => {
    const fetcher = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await makeAppealCommand(fetcher, vi.fn()).parseAsync(
      ["--invoice-id", "42", "--evidence-hash", "not-a-hash"], { from: "user" }
    );
    expect(fetcher).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
