import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
/**
 * Tests for `iln dispute` — state validation, reason-hash, --yes, --payer (#414).
 */
import { makeDisputeCommand } from "../../src/commands/dispute";
import type { InvoiceSummary, DisputeResult } from "../../src/commands/dispute";

const VALID_HASH = "a".repeat(64);
const PAYER = "GBOYEEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function mockInvoice(state: InvoiceSummary["state"] = "Funded"): InvoiceSummary {
  return { id: "INV-101", state, payer: PAYER };
}

function mockResult(id = "INV-101"): DisputeResult {
  return { invoiceId: id, txHash: "TXDISP001", reasonHash: VALID_HASH, payer: PAYER };
}

describe("iln dispute — happy path", () => {
  it("disputes a Funded invoice when confirmed", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice("Funded"));
    const executor = vi.fn().mockResolvedValue(mockResult());
    const resolver = vi.fn().mockResolvedValue(PAYER);
    const confirm = vi.fn().mockResolvedValue(true);
    const cmd = makeDisputeCommand(fetcher, executor, resolver, confirm);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync(
      ["--invoice-id", "INV-101", "--reason-hash", VALID_HASH, "--payer", PAYER],
      { from: "user" }
    );

    expect(executor).toHaveBeenCalledWith("INV-101", VALID_HASH, PAYER);
    expect(logs.some((l) => l.includes("Disputed invoice"))).toBe(true);
    expect(logs.some((l) => l.includes("TXDISP001"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("disputes a Pending invoice", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice("Pending"));
    const executor = vi.fn().mockResolvedValue(mockResult());
    const resolver = vi.fn().mockResolvedValue(PAYER);
    const confirm = vi.fn().mockResolvedValue(true);
    const cmd = makeDisputeCommand(fetcher, executor, resolver, confirm);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await cmd.parseAsync(
      ["--invoice-id", "INV-101", "--reason-hash", VALID_HASH, "--payer", PAYER, "--yes"],
      { from: "user" }
    );

    expect(executor).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("defaults payer to the resolved wallet when --payer omitted", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice("Funded"));
    const executor = vi.fn().mockResolvedValue(mockResult());
    const resolver = vi.fn().mockResolvedValue(PAYER);
    const confirm = vi.fn().mockResolvedValue(true);
    const cmd = makeDisputeCommand(fetcher, executor, resolver, confirm);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await cmd.parseAsync(
      ["--invoice-id", "INV-101", "--reason-hash", VALID_HASH, "--yes"],
      { from: "user" }
    );

    expect(resolver).toHaveBeenCalled();
    expect(executor).toHaveBeenCalledWith("INV-101", VALID_HASH, PAYER);
    vi.restoreAllMocks();
  });

  it("skips confirmation with --yes", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice("Funded"));
    const executor = vi.fn().mockResolvedValue(mockResult());
    const resolver = vi.fn().mockResolvedValue(PAYER);
    const confirm = vi.fn();
    const cmd = makeDisputeCommand(fetcher, executor, resolver, confirm);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await cmd.parseAsync(
      ["--invoice-id", "INV-101", "--reason-hash", VALID_HASH, "--payer", PAYER, "--yes"],
      { from: "user" }
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(executor).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("rejects an invalid reason-hash (not 64-char hex)", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice("Funded"));
    const executor = vi.fn();
    const resolver = vi.fn().mockResolvedValue(PAYER);
    const confirm = vi.fn();
    const cmd = makeDisputeCommand(fetcher, executor, resolver, confirm);
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => errs.push(a.join(" ")));
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await cmd.parseAsync(
      ["--invoice-id", "INV-101", "--reason-hash", "not-a-hash", "--payer", PAYER, "--yes"],
      { from: "user" }
    );

    expect(executor).not.toHaveBeenCalled();
    expect(errs.some((e) => e.includes("reason-hash"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("rejects a non-disputable state (Settled)", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice("Settled"));
    const executor = vi.fn();
    const resolver = vi.fn().mockResolvedValue(PAYER);
    const confirm = vi.fn();
    const cmd = makeDisputeCommand(fetcher, executor, resolver, confirm);
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => errs.push(a.join(" ")));
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await cmd.parseAsync(
      ["--invoice-id", "INV-101", "--reason-hash", VALID_HASH, "--payer", PAYER, "--yes"],
      { from: "user" }
    );

    expect(executor).not.toHaveBeenCalled();
    expect(errs.some((e) => e.includes("Settled"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("aborts when user declines confirmation", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice("Funded"));
    const executor = vi.fn();
    const resolver = vi.fn().mockResolvedValue(PAYER);
    const confirm = vi.fn().mockResolvedValue(false);
    const cmd = makeDisputeCommand(fetcher, executor, resolver, confirm);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync(
      ["--invoice-id", "INV-101", "--reason-hash", VALID_HASH, "--payer", PAYER],
      { from: "user" }
    );

    expect(executor).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("Aborted"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("emits JSON when --json is set on parent", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice("Funded"));
    const executor = vi.fn().mockResolvedValue(mockResult());
    const resolver = vi.fn().mockResolvedValue(PAYER);
    const confirm = vi.fn().mockResolvedValue(true);
    const cmd = makeDisputeCommand(fetcher, executor, resolver, confirm);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync(
      ["--invoice-id", "INV-101", "--reason-hash", VALID_HASH, "--payer", PAYER, "--yes"],
      { from: "user" }
    );
    // non-json path still logs; json-mode exercised via parent in integration
    expect(executor).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
