import { vi, describe, it, expect, afterEach } from 'vitest';
/**
 * Tests for the global --json flag propagation to subcommands.
 *
 * Verifies that `iln --json <command>` produces machine-readable JSON
 * output for all commands that support it.
 */
import { Command } from "commander";
import { makeStatusCommand } from "../../src/commands/status";
import { makeReputationCommand } from "../../src/commands/reputation";
import { makeSubmitCommand } from "../../src/commands/submit";
import { makeFundCommand } from "../../src/commands/fund";
import { makeCancelCommand } from "../../src/commands/cancel";
import { makeMarketplaceCommand } from "../../src/commands/marketplace";
import type { InvoiceDetail } from "../../src/commands/status-types";
import type { InvoiceSummary, CancelResult } from "../../src/commands/cancel-types";
import type { MarketplaceListing, FundResult } from "../../src/commands/marketplace-types";
import type { SubmitResult } from "../../src/commands/submit-types";

function makeProgram(...cmds: Command[]): Command {
  const program = new Command();
  program.option("--json", "Output machine-readable JSON");
  for (const c of cmds) program.addCommand(c);
  return program;
}

function mockInvoice(): InvoiceDetail {
  return {
    id: "INV-999",
    state: "Pending",
    submitter: "GSUB0000000000000000000000000000000000000000000000000001",
    payer: "GPAY0000000000000000000000000000000000000000000000000001",
    token: "USDC",
    amount: "250",
    discountRateBps: 300,
    effectiveYieldPct: "3.00",
    dueDate: "2026-06-30",
    createdAt: "2026-01-01T00:00:00Z",
  };
}

describe("global --json flag", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("iln --json status outputs JSON", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice());
    const program = makeProgram(makeStatusCommand(fetcher));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await program.parseAsync(["--json", "status", "--id", "INV-999"], { from: "user" });

    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.id).toBe("INV-999");
    expect(parsed.token).toBe("USDC");
    vi.restoreAllMocks();
  });

  it("iln --json cancel outputs JSON on success", async () => {
    const invoice: InvoiceSummary = { id: "42", state: "Pending", amount: "100", token: "USDC", dueDate: "2025-12-31" };
    const result: CancelResult = { invoiceId: "42", txHash: "TXCANCEL001" };
    const fetcher = vi.fn().mockResolvedValue(invoice);
    const executor = vi.fn().mockResolvedValue(result);
    const confirm = vi.fn().mockResolvedValue(true);
    const program = makeProgram(makeCancelCommand(fetcher, executor, confirm));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await program.parseAsync(["--json", "cancel", "--id", "42", "--yes"], { from: "user" });

    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.invoiceId).toBe("42");
    expect(parsed.txHash).toBe("TXCANCEL001");
    vi.restoreAllMocks();
  });

  it("iln --json cancel outputs JSON when user aborts", async () => {
    const invoice: InvoiceSummary = { id: "42", state: "Pending", amount: "100", token: "USDC", dueDate: "2025-12-31" };
    const fetcher = vi.fn().mockResolvedValue(invoice);
    const executor = vi.fn();
    const confirm = vi.fn().mockResolvedValue(false);
    const program = makeProgram(makeCancelCommand(fetcher, executor, confirm));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await program.parseAsync(["--json", "cancel", "--id", "42"], { from: "user" });

    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.aborted).toBe(true);
    expect(executor).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("iln --json fund outputs JSON on success", async () => {
    const listing: MarketplaceListing = { id: "INV-500", amount: "100", token: "USDC", yieldPct: "3.20", dueDate: "2025-12-31", payerReputation: "medium" };
    const result: FundResult = { invoiceId: "INV-500", txHash: "TXFUND001" };
    const fetcher = vi.fn().mockResolvedValue(listing);
    const executor = vi.fn().mockResolvedValue(result);
    const confirm = vi.fn().mockResolvedValue(true);
    const program = makeProgram(makeFundCommand(fetcher, executor, confirm));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await program.parseAsync(["--json", "fund", "--id", "INV-500", "--yes"], { from: "user" });

    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.invoiceId).toBe("INV-500");
    expect(parsed.txHash).toBe("TXFUND001");
    vi.restoreAllMocks();
  });

  it("iln --json marketplace outputs JSON array", async () => {
    const listings: MarketplaceListing[] = [
      { id: "INV-1", amount: "500", token: "USDC", yieldPct: "3.50", dueDate: "2025-12-31", payerReputation: "high" },
    ];
    const program = makeProgram(makeMarketplaceCommand(vi.fn().mockResolvedValue(listings)));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await program.parseAsync(["--json", "marketplace"], { from: "user" });

    const parsed = JSON.parse(logs.join("\n"));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("INV-1");
    vi.restoreAllMocks();
  });

  it("command-level --json still works alongside global --json", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice());
    const program = makeProgram(makeStatusCommand(fetcher));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await program.parseAsync(["--json", "status", "--id", "INV-999", "--json"], { from: "user" });

    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.id).toBe("INV-999");
    vi.restoreAllMocks();
  });
});
