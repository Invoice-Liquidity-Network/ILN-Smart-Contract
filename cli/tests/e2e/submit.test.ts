import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
/**
 * Tests for `iln submit` — flag-based mode (#229).
 */
import { makeSubmitCommand } from "../../src/commands/submit";
import type { SubmitResult } from "../../src/commands/submit-types";

const VALID_PAYER = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU23";

function makeResult(overrides: Partial<SubmitResult> = {}): SubmitResult {
  return {
    invoiceId: "INV-001",
    txHash: "TX123ABC",
    payer: VALID_PAYER,
    amount: "100",
    token: "USDC",
    rateBps: 300,
    yieldPct: "3.00",
    dueDate: "2025-12-31",
    ...overrides,
  };
}

describe("iln submit — flag-based mode", () => {
  it("calls submitter with flag values and prints success", async () => {
    const submitter = vi.fn().mockResolvedValue(makeResult());
    const prompter = vi.fn();
    const cmd = makeSubmitCommand(prompter, submitter);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync([
      "--payer", VALID_PAYER,
      "--amount", "100",
      "--token", "USDC",
      "--rate", "300",
      "--due", "2025-12-31",
    ], { from: "user" });

    expect(submitter).toHaveBeenCalledWith(
      expect.objectContaining({ payer: VALID_PAYER, amount: "100", token: "USDC" })
    );
    expect(logs.some((l) => l.includes("INV-001"))).toBe(true);
    expect(logs.some((l) => l.includes("TX123ABC"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("does not call prompter when all flags are provided", async () => {
    const submitter = vi.fn().mockResolvedValue(makeResult());
    const prompter = vi.fn();
    const cmd = makeSubmitCommand(prompter, submitter);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await cmd.parseAsync([
      "--payer", VALID_PAYER, "--amount", "200", "--rate", "150", "--due", "2026-01-01",
    ], { from: "user" });

    expect(prompter).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("exits with error for invalid payer address", async () => {
    const submitter = vi.fn();
    const prompter = vi.fn();
    const cmd = makeSubmitCommand(prompter, submitter);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await cmd.parseAsync([
      "--payer", "NOT_VALID", "--amount", "100", "--rate", "300", "--due", "2025-12-31",
    ], { from: "user" });

    expect(exit).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });
});
