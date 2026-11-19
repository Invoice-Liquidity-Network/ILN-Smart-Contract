import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
/**
 * Tests for `iln dispute` — happy path (#414).
 */
import { makeDisputeCommand } from "../../src/commands/dispute";
import type { InvoiceSummary, DisputeResult } from "../../src/commands/dispute-types";

function disputableInvoice(id = "42", status = "Funded"): InvoiceSummary {
  return { id, status, amount: "100", token: "USDC", dueDate: "2025-12-31" };
}

function makeDisputeResult(id = "42"): DisputeResult {
  return { invoiceId: id, txHash: "TXDISPUTE001", disputedAt: new Date().toISOString() };
}

describe("iln dispute — happy path", () => {
  it("disputes a Funded invoice when user confirms", async () => {
    const fetcher = vi.fn().mockResolvedValue(disputableInvoice());
    const executor = vi.fn().mockResolvedValue(makeDisputeResult());
    const confirm = vi.fn().mockResolvedValue(true);
    const cmd = makeDisputeCommand(fetcher, executor, confirm);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync(["--invoice-id", "42", "--reason-hash", "abc123"], { from: "user" });

    expect(executor).toHaveBeenCalledWith("42", "abc123", undefined);
    expect(logs.some((l) => l.includes("disputed"))).toBe(true);
    expect(logs.some((l) => l.includes("TXDISPUTE001"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("disputes a Pending invoice", async () => {
    const fetcher = vi.fn().mockResolvedValue(disputableInvoice("43", "Pending"));
    const executor = vi.fn().mockResolvedValue(makeDisputeResult("43"));
    const confirm = vi.fn().mockResolvedValue(true);
    const cmd = makeDisputeCommand(fetcher, executor, confirm);

    vi.spyOn(console, "log").mockImplementation(() => {});

    await cmd.parseAsync(["--invoice-id", "43", "--reason-hash", "def456"], { from: "user" });

    expect(executor).toHaveBeenCalledWith("43", "def456", undefined);
    vi.restoreAllMocks();
  });

  it("disputes a PartiallyFunded invoice", async () => {
    const fetcher = vi.fn().mockResolvedValue(disputableInvoice("44", "PartiallyFunded"));
    const executor = vi.fn().mockResolvedValue(makeDisputeResult("44"));
    const confirm = vi.fn().mockResolvedValue(true);
    const cmd = makeDisputeCommand(fetcher, executor, confirm);

    vi.spyOn(console, "log").mockImplementation(() => {});

    await cmd.parseAsync(["--invoice-id", "44", "--reason-hash", "ghi789"], { from: "user" });

    expect(executor).toHaveBeenCalledWith("44", "ghi789", undefined);
    vi.restoreAllMocks();
  });

  it("skips confirmation prompt with --yes flag", async () => {
    const fetcher = vi.fn().mockResolvedValue(disputableInvoice());
    const executor = vi.fn().mockResolvedValue(makeDisputeResult());
    const confirm = vi.fn();
    const cmd = makeDisputeCommand(fetcher, executor, confirm);

    vi.spyOn(console, "log").mockImplementation(() => {});

    await cmd.parseAsync(["--invoice-id", "42", "--reason-hash", "abc123", "--yes"], { from: "user" });

    expect(confirm).not.toHaveBeenCalled();
    expect(executor).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("accepts optional --payer parameter", async () => {
    const fetcher = vi.fn().mockResolvedValue(disputableInvoice());
    const executor = vi.fn().mockResolvedValue(makeDisputeResult());
    const confirm = vi.fn().mockResolvedValue(true);
    const cmd = makeDisputeCommand(fetcher, executor, confirm);

    vi.spyOn(console, "log").mockImplementation(() => {});

    await cmd.parseAsync(["--invoice-id", "42", "--reason-hash", "abc123", "--payer", "GABC123"], { from: "user" });

    expect(executor).toHaveBeenCalledWith("42", "abc123", "GABC123");
    vi.restoreAllMocks();
  });

  it("aborts without disputing when user declines confirmation", async () => {
    const fetcher = vi.fn().mockResolvedValue(disputableInvoice());
    const executor = vi.fn();
    const confirm = vi.fn().mockResolvedValue(false);
    const cmd = makeDisputeCommand(fetcher, executor, confirm);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync(["--invoice-id", "42", "--reason-hash", "abc123"], { from: "user" });

    expect(executor).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("no changes"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("rejects dispute for Paid invoice", async () => {
    const fetcher = vi.fn().mockResolvedValue(disputableInvoice("45", "Paid"));
    const executor = vi.fn();
    const confirm = vi.fn();
    const cmd = makeDisputeCommand(fetcher, executor, confirm);

    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(cmd.parseAsync(["--invoice-id", "45", "--reason-hash", "abc123"], { from: "user" })).rejects.toThrow();
    expect(executor).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("rejects dispute for Defaulted invoice", async () => {
    const fetcher = vi.fn().mockResolvedValue(disputableInvoice("46", "Defaulted"));
    const executor = vi.fn();
    const confirm = vi.fn();
    const cmd = makeDisputeCommand(fetcher, executor, confirm);

    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(cmd.parseAsync(["--invoice-id", "46", "--reason-hash", "abc123"], { from: "user" })).rejects.toThrow();
    expect(executor).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
