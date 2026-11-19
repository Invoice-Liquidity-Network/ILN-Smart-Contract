import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
/**
 * Tests for `iln submit` interactive prompt mode (#229).
 * Prompter is injected so no real terminal I/O occurs.
 */
import { makeSubmitCommand } from "../../src/commands/submit";
import type { SubmitResult } from "../../src/commands/submit-types";

const VALID_PAYER = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU23";

const MOCK_PROMPT_ANSWERS = {
  payer: VALID_PAYER,
  amount: "250",
  token: "USDC",
  rate: "400",
  due: "2026-03-15",
  referral: "REF42",
};

function makeResult(): SubmitResult {
  return {
    invoiceId: "INV-INTER",
    txHash: "TXINTER99",
    payer: VALID_PAYER,
    amount: "250",
    token: "USDC",
    rateBps: 400,
    yieldPct: "4.00",
    dueDate: "2026-03-15",
    referral: "REF42",
  };
}

describe("iln submit — interactive mode", () => {
  it("calls prompter when no flags are supplied", async () => {
    const prompter = vi.fn().mockResolvedValue(MOCK_PROMPT_ANSWERS);
    const submitter = vi.fn().mockResolvedValue(makeResult());
    const cmd = makeSubmitCommand(prompter, submitter);

    vi.spyOn(console, "log").mockImplementation(() => {});

    await cmd.parseAsync([], { from: "user" });

    expect(prompter).toHaveBeenCalledTimes(1);
    expect(submitter).toHaveBeenCalledWith(expect.objectContaining({ payer: VALID_PAYER }));
    vi.restoreAllMocks();
  });

  it("passes all prompt answers to submitter", async () => {
    const prompter = vi.fn().mockResolvedValue(MOCK_PROMPT_ANSWERS);
    const submitter = vi.fn().mockResolvedValue(makeResult());
    const cmd = makeSubmitCommand(prompter, submitter);

    vi.spyOn(console, "log").mockImplementation(() => {});

    await cmd.parseAsync([], { from: "user" });

    expect(submitter).toHaveBeenCalledWith({
      payer: VALID_PAYER,
      amount: "250",
      token: "USDC",
      rate: "400",
      due: "2026-03-15",
      referral: "REF42",
    });
    vi.restoreAllMocks();
  });

  it("prints success message with invoice ID after interactive submit", async () => {
    const prompter = vi.fn().mockResolvedValue(MOCK_PROMPT_ANSWERS);
    const submitter = vi.fn().mockResolvedValue(makeResult());
    const cmd = makeSubmitCommand(prompter, submitter);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync([], { from: "user" });

    expect(logs.some((l) => l.includes("INV-INTER"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("handles prompter rejection gracefully", async () => {
    const prompter = vi.fn().mockRejectedValue(new Error("User aborted"));
    const submitter = vi.fn();
    const cmd = makeSubmitCommand(prompter, submitter);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await cmd.parseAsync([], { from: "user" });

    expect(exit).toHaveBeenCalledWith(1);
    expect(submitter).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
