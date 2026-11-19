import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
/**
 * Tests for `iln submit --dry-run` (#229).
 */
import { makeSubmitCommand } from "../../src/commands/submit";
import type { SubmitResult } from "../../src/commands/submit-types";

const VALID_PAYER = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU23";

function makeResult(): SubmitResult {
  return {
    invoiceId: "INV-999",
    txHash: "TXDRYRUN",
    payer: VALID_PAYER,
    amount: "500",
    token: "EURC",
    rateBps: 200,
    yieldPct: "2.00",
    dueDate: "2026-06-30",
  };
}

describe("iln submit --dry-run", () => {
  it("prints transaction payload without calling submitter", async () => {
    const submitter = vi.fn().mockResolvedValue(makeResult());
    const prompter = vi.fn();
    const cmd = makeSubmitCommand(prompter, submitter);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync([
      "--payer", VALID_PAYER,
      "--amount", "500",
      "--token", "EURC",
      "--rate", "200",
      "--due", "2026-06-30",
      "--dry-run",
    ], { from: "user" });

    expect(submitter).not.toHaveBeenCalled();
    const output = logs.join("\n");
    expect(output).toContain("dry-run");
    expect(output).toContain(VALID_PAYER);
    vi.restoreAllMocks();
  });

  it("dry-run output is valid JSON", async () => {
    const submitter = vi.fn();
    const prompter = vi.fn();
    const cmd = makeSubmitCommand(prompter, submitter);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync([
      "--payer", VALID_PAYER,
      "--amount", "100",
      "--rate", "300",
      "--due", "2025-12-31",
      "--dry-run",
    ], { from: "user" });

    const jsonLine = logs.find((l) => l.trim().startsWith("{"));
    expect(jsonLine).toBeDefined();
    expect(() => JSON.parse(jsonLine!)).not.toThrow();
    vi.restoreAllMocks();
  });

  it("dry-run exits cleanly (no process.exit call)", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const cmd = makeSubmitCommand(vi.fn(), vi.fn());
    vi.spyOn(console, "log").mockImplementation(() => {});

    await cmd.parseAsync([
      "--payer", VALID_PAYER, "--amount", "100", "--rate", "300", "--due", "2025-12-31", "--dry-run",
    ], { from: "user" });

    expect(exit).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
