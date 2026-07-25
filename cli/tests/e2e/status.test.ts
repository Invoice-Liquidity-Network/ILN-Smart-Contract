import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
/**
 * Tests for `iln status` — rich formatted output (#231).
 */
import { makeStatusCommand } from "../../src/commands/status";
import type { InvoiceDetail } from "../../src/commands/status-types";

function mockInvoice(overrides: Partial<InvoiceDetail> = {}): InvoiceDetail {
  return {
    id: "INV-500",
    state: "Funded",
    submitter: "GSUB0000000000000000000000000000000000000000000000000001",
    payer: "GPAY0000000000000000000000000000000000000000000000000001",
    lp: "GLP00000000000000000000000000000000000000000000000000001",
    token: "USDC",
    amount: "750",
    discountRateBps: 350,
    effectiveYieldPct: "3.50",
    dueDate: "2026-06-30",
    createdAt: "2026-06-01T10:00:00Z",
    ...overrides,
  };
}

describe("iln status — rich output", () => {
  it("prints invoice ID, state, amount and due date", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice());
    const cmd = makeStatusCommand(fetcher);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync(["--id", "INV-500"], { from: "user" });

    const output = logs.join("\n");
    expect(output).toContain("INV-500");
    expect(output).toContain("FUNDED");
    expect(output).toContain("750 USDC");
    expect(output).toContain("2026-06-30");
    vi.restoreAllMocks();
  });

  it("prints timeline section", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice({ state: "Pending" }));
    const cmd = makeStatusCommand(fetcher);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync(["--id", "INV-500"], { from: "user" });

    expect(logs.some((l) => l.includes("Timeline"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("shows LP field when invoice is Funded", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice());
    const cmd = makeStatusCommand(fetcher);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync(["--id", "INV-500"], { from: "user" });

    expect(logs.some((l) => l.includes("LP"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("exits with error when fetcher throws", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("Invoice not found"));
    const cmd = makeStatusCommand(fetcher);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await cmd.parseAsync(["--id", "MISSING"], { from: "user" });

    expect(exit).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });
});
