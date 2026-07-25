import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
/**
 * Tests for `iln cancel` — state guard and error paths (#233).
 */
import { makeCancelCommand } from "../../src/commands/cancel";
import { validatePendingState, formatConfirmMessage } from "../../src/commands/cancel-helpers";
import type { InvoiceSummary } from "../../src/commands/cancel-types";

function invoice(state: InvoiceSummary["state"], id = "99"): InvoiceSummary {
  return { id, state, amount: "200", token: "EURC", dueDate: "2026-01-15" };
}

describe("validatePendingState helper", () => {
  it("does not throw for Pending invoices", () => {
    expect(() => validatePendingState(invoice("Pending"))).not.toThrow();
  });

  it("throws for Funded invoices", () => {
    expect(() => validatePendingState(invoice("Funded"))).toThrow(/Funded/);
  });

  it("throws for Paid invoices", () => {
    expect(() => validatePendingState(invoice("Paid"))).toThrow(/Paid/);
  });

  it("throws for Cancelled invoices", () => {
    expect(() => validatePendingState(invoice("Cancelled"))).toThrow(/Cancelled/);
  });

  it("includes the invoice id in the error message", () => {
    expect(() => validatePendingState(invoice("Expired", "77"))).toThrow(/#77/);
  });
});

describe("formatConfirmMessage helper", () => {
  it("includes invoice ID, amount, token and due date", () => {
    const msg = formatConfirmMessage(invoice("Pending", "42"));
    expect(msg).toContain("#42");
    expect(msg).toContain("200 EURC");
    expect(msg).toContain("2026-01-15");
    expect(msg).toContain("[y/N]");
  });
});

describe("iln cancel — non-Pending state errors", () => {
  it("exits with error when invoice is Funded", async () => {
    const fetcher = vi.fn().mockResolvedValue(invoice("Funded"));
    const executor = vi.fn();
    const confirm = vi.fn();
    const cmd = makeCancelCommand(fetcher, executor, confirm);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await cmd.parseAsync(["--id", "99"], { from: "user" });

    expect(exit).toHaveBeenCalledWith(1);
    expect(executor).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("exits with error when fetcher throws", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("Network error"));
    const executor = vi.fn();
    const cmd = makeCancelCommand(fetcher, executor, vi.fn());
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await cmd.parseAsync(["--id", "99"], { from: "user" });

    expect(exit).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });
});
