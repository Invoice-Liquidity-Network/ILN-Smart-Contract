import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
/**
 * Tests for `iln cancel` — happy path (#233).
 */
import { makeCancelCommand } from "../../src/commands/cancel";
import type { InvoiceSummary, CancelResult } from "../../src/commands/cancel-types";

function pendingInvoice(id = "42"): InvoiceSummary {
  return { id, state: "Pending", amount: "100", token: "USDC", dueDate: "2025-12-31" };
}

function makeCancelResult(id = "42"): CancelResult {
  return { invoiceId: id, txHash: "TXCANCEL001" };
}

describe("iln cancel — happy path", () => {
  it("cancels a Pending invoice when user confirms", async () => {
    const fetcher = vi.fn().mockResolvedValue(pendingInvoice());
    const executor = vi.fn().mockResolvedValue(makeCancelResult());
    const confirm = vi.fn().mockResolvedValue(true);
    const cmd = makeCancelCommand(fetcher, executor, confirm);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync(["--id", "42"], { from: "user" });

    expect(executor).toHaveBeenCalledWith("42");
    expect(logs.some((l) => l.includes("cancelled"))).toBe(true);
    expect(logs.some((l) => l.includes("TXCANCEL001"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("skips confirmation prompt with --yes flag", async () => {
    const fetcher = vi.fn().mockResolvedValue(pendingInvoice());
    const executor = vi.fn().mockResolvedValue(makeCancelResult());
    const confirm = vi.fn();
    const cmd = makeCancelCommand(fetcher, executor, confirm);

    vi.spyOn(console, "log").mockImplementation(() => {});

    await cmd.parseAsync(["--id", "42", "--yes"], { from: "user" });

    expect(confirm).not.toHaveBeenCalled();
    expect(executor).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("aborts without cancelling when user declines confirmation", async () => {
    const fetcher = vi.fn().mockResolvedValue(pendingInvoice());
    const executor = vi.fn();
    const confirm = vi.fn().mockResolvedValue(false);
    const cmd = makeCancelCommand(fetcher, executor, confirm);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync(["--id", "42"], { from: "user" });

    expect(executor).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("no changes"))).toBe(true);
    vi.restoreAllMocks();
  });
});
