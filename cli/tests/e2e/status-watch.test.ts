import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
/**
 * Tests for `iln status --watch` mode (#231).
 */
import { makeStatusCommand } from "../../src/commands/status";
import type { InvoiceDetail } from "../../src/commands/status-types";

function makeInvoice(state: InvoiceDetail["state"]): InvoiceDetail {
  return {
    id: "INV-700",
    state,
    submitter: "GSUB0000000000000000000000000000000000000000000000000001",
    payer: "GPAY0000000000000000000000000000000000000000000000000001",
    token: "USDC",
    amount: "100",
    discountRateBps: 300,
    effectiveYieldPct: "3.00",
    dueDate: "2026-12-31",
    createdAt: "2026-06-01T00:00:00Z",
  };
}

describe("iln status --watch", () => {
  it("does not set interval when invoice is already in a terminal state", async () => {
    const fetcher = vi.fn().mockResolvedValue(makeInvoice("Paid"));
    const mockSetInterval = vi.fn();
    const mockClearInterval = vi.fn();
    const cmd = makeStatusCommand(fetcher, mockSetInterval as unknown as typeof setInterval, mockClearInterval);

    vi.spyOn(console, "log").mockImplementation(() => {});

    await cmd.parseAsync(["--id", "INV-700", "--watch"], { from: "user" });

    expect(mockSetInterval).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("sets interval when invoice is in a non-terminal state with --watch", async () => {
    const fetcher = vi.fn().mockResolvedValue(makeInvoice("Pending"));
    const mockSetInterval = vi.fn().mockReturnValue(99);
    const mockClearInterval = vi.fn();
    const cmd = makeStatusCommand(fetcher, mockSetInterval as unknown as typeof setInterval, mockClearInterval);

    vi.spyOn(console, "log").mockImplementation(() => {});

    await cmd.parseAsync(["--id", "INV-700", "--watch"], { from: "user" });

    expect(mockSetInterval).toHaveBeenCalledWith(expect.any(Function), 10_000);
    vi.restoreAllMocks();
  });

  it("does not set interval without --watch flag even for non-terminal state", async () => {
    const fetcher = vi.fn().mockResolvedValue(makeInvoice("Funded"));
    const mockSetInterval = vi.fn();
    const mockClearInterval = vi.fn();
    const cmd = makeStatusCommand(fetcher, mockSetInterval as unknown as typeof setInterval, mockClearInterval);

    vi.spyOn(console, "log").mockImplementation(() => {});

    await cmd.parseAsync(["--id", "INV-700"], { from: "user" });

    expect(mockSetInterval).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
