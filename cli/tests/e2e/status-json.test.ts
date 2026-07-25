import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
/**
 * Tests for `iln status --json` flag (#231).
 */
import { makeStatusCommand } from "../../src/commands/status";
import type { InvoiceDetail } from "../../src/commands/status-types";

function mockInvoice(): InvoiceDetail {
  return {
    id: "INV-600",
    state: "Paid",
    submitter: "GSUB0000000000000000000000000000000000000000000000000001",
    payer: "GPAY0000000000000000000000000000000000000000000000000001",
    token: "USDC",
    amount: "300",
    discountRateBps: 200,
    effectiveYieldPct: "2.00",
    dueDate: "2026-03-31",
    createdAt: "2026-01-01T00:00:00Z",
  };
}

describe("iln status --json", () => {
  it("outputs valid JSON", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice());
    const cmd = makeStatusCommand(fetcher);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync(["--id", "INV-600", "--json"], { from: "user" });

    const output = logs.join("\n");
    expect(() => JSON.parse(output)).not.toThrow();
    vi.restoreAllMocks();
  });

  it("JSON output contains all invoice fields", async () => {
    const inv = mockInvoice();
    const fetcher = vi.fn().mockResolvedValue(inv);
    const cmd = makeStatusCommand(fetcher);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync(["--id", "INV-600", "--json"], { from: "user" });

    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.id).toBe("INV-600");
    expect(parsed.state).toBe("Paid");
    expect(parsed.amount).toBe("300");
    expect(parsed.token).toBe("USDC");
    vi.restoreAllMocks();
  });

  it("does not print the rich-format table in --json mode", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice());
    const cmd = makeStatusCommand(fetcher);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync(["--id", "INV-600", "--json"], { from: "user" });

    expect(logs.some((l) => l.includes("Timeline"))).toBe(false);
    vi.restoreAllMocks();
  });
});
