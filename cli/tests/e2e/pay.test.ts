import { vi, describe, it, expect } from 'vitest';
/**
 * Tests for `iln pay` — full and partial payment flows.
 * Issue: #232
 */

import { makePayCommand } from "../../src/commands/pay";
import { printPaymentPreview, printPartialProgress, printSettlementReceipt } from "../../src/commands/pay";
import type { InvoicePayState, PayResult } from "../../src/commands/pay-types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const INVOICE_ID = "INV-100";

function mockInvoice(overrides: Partial<InvoicePayState> = {}): InvoicePayState {
  return {
    id: INVOICE_ID,
    totalAmount: 100,
    remainingAmount: 100,
    token: "USDC",
    payer: "GPAY0000000000000000000000000000000000000000000000000001",
    lp: "GLP00000000000000000000000000000000000000000000000000001",
    ...overrides,
  };
}

function mockResult(overrides: Partial<PayResult> = {}): PayResult {
  return {
    invoiceId: INVOICE_ID,
    txHash: "TX_FULL_PAYMENT",
    paidAmount: 100,
    remainingAmount: 0,
    token: "USDC",
    lpEarnings: 0.5,
    isFullyPaid: true,
    ...overrides,
  };
}

function makePromptYes() {
  return vi.fn().mockResolvedValue(true);
}

function makePromptNo() {
  return vi.fn().mockResolvedValue(false);
}

// ── Full payment ──────────────────────────────────────────────────────────────

describe("iln pay — full payment", () => {
  it("calls executor with full remaining amount when --amount is omitted", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice());
    const executor = vi.fn().mockResolvedValue(mockResult());
    const cmd = makePayCommand(makePromptYes(), fetcher, executor);

    vi.spyOn(console, "log").mockImplementation(() => {});

    await cmd.parseAsync(["node", "iln", "--id", INVOICE_ID, "--yes"]);

    expect(executor).toHaveBeenCalledWith(INVOICE_ID, 100);
  });

  it("prints settlement receipt after full payment", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice());
    const executor = vi.fn().mockResolvedValue(mockResult());
    const cmd = makePayCommand(makePromptYes(), fetcher, executor);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync(["node", "iln", "--id", INVOICE_ID, "--yes"]);

    expect(logs.some((l) => l.includes("FULLY PAID"))).toBe(true);
    expect(logs.some((l) => l.includes("TX_FULL_PAYMENT"))).toBe(true);
  });

  it("shows LP earnings in settlement receipt", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice());
    const executor = vi.fn().mockResolvedValue(mockResult({ lpEarnings: 0.5 }));
    const cmd = makePayCommand(makePromptYes(), fetcher, executor);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync(["node", "iln", "--id", INVOICE_ID, "--yes"]);

    expect(logs.some((l) => l.includes("LP earned"))).toBe(true);
  });
});

// ── Partial payment ─────────────────────────────────────────────────

describe("iln pay — partial payment", () => {
  it("calls executor with --amount value for partial payment", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice());
    const executor = vi.fn().mockResolvedValue(
      mockResult({ paidAmount: 50, remainingAmount: 50, isFullyPaid: false }),
    );
    const cmd = makePayCommand(makePromptYes(), fetcher, executor);

    vi.spyOn(console, "log").mockImplementation(() => {});

    await cmd.parseAsync(["node", "iln", "--id", INVOICE_ID, "--amount", "50", "--yes"]);

    expect(executor).toHaveBeenCalledWith(INVOICE_ID, 50);
  });

  it("prints partial progress line on partial payment", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice());
    const executor = vi.fn().mockResolvedValue(
      mockResult({ paidAmount: 50, remainingAmount: 50, isFullyPaid: false }),
    );
    const cmd = makePayCommand(makePromptYes(), fetcher, executor);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync(["node", "iln", "--id", INVOICE_ID, "--amount", "50", "--yes"]);

    expect(logs.some((l) => l.includes("50 USDC remaining"))).toBe(true);
  });

  it("rejects amount exceeding remaining balance", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice({ remainingAmount: 30 }));
    const executor = vi.fn();
    const cmd = makePayCommand(makePromptYes(), fetcher, executor);

    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => errors.push(a.join(" ")));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });

    await expect(
      cmd.parseAsync(["node", "iln", "--id", INVOICE_ID, "--amount", "50", "--yes"]),
    ).rejects.toThrow("exit");

    expect(errors.some((e) => e.includes("exceeds remaining balance"))).toBe(true);
    expect(executor).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

// ── Payment preview ───────────────────────────────────────────────────────────

describe("iln pay — payment preview", () => {
  it("prints preview before signing", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice());
    const executor = vi.fn().mockResolvedValue(mockResult());
    const cmd = makePayCommand(makePromptYes(), fetcher, executor);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync(["node", "iln", "--id", INVOICE_ID, "--yes"]);

    expect(
      logs.some((l) => l.includes("Paying") && l.includes("remaining on Invoice")),
    ).toBe(true);
  });

  it("printPaymentPreview includes LP note when lp is set", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    printPaymentPreview(mockInvoice(), 50);

    expect(logs[0]).toMatch(/Payer earns LP/);
  });

  it("printPaymentPreview omits LP note when lp is undefined", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    printPaymentPreview(mockInvoice({ lp: undefined }), 50);

    expect(logs[0]).not.toMatch(/Payer earns LP/);
  });
});

// ── Confirmation prompt ───────────────────────────────────────────────────────

describe("iln pay — confirmation prompt", () => {
  it("prompts user when --yes is not passed", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice());
    const executor = vi.fn().mockResolvedValue(mockResult());
    const prompter = makePromptYes();
    const cmd = makePayCommand(prompter, fetcher, executor);

    vi.spyOn(console, "log").mockImplementation(() => {});

    await cmd.parseAsync(["node", "iln", "--id", INVOICE_ID]);

    expect(prompter).toHaveBeenCalled();
    expect(executor).toHaveBeenCalled();
  });

  it("skips prompt with --yes flag", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice());
    const executor = vi.fn().mockResolvedValue(mockResult());
    const prompter = vi.fn();
    const cmd = makePayCommand(prompter, fetcher, executor);

    vi.spyOn(console, "log").mockImplementation(() => {});

    await cmd.parseAsync(["node", "iln", "--id", INVOICE_ID, "--yes"]);

    expect(prompter).not.toHaveBeenCalled();
  });

  it("cancels payment when user declines confirmation", async () => {
    const fetcher = vi.fn().mockResolvedValue(mockInvoice());
    const executor = vi.fn();
    const cmd = makePayCommand(makePromptNo(), fetcher, executor);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync(["node", "iln", "--id", INVOICE_ID]);

    expect(executor).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("Payment cancelled"))).toBe(true);
  });
});

// ── printSettlementReceipt / printPartialProgress unit tests ─────────────

describe("iln pay — receipt helpers", () => {
  it("printSettlementReceipt shows FULLY PAID for complete payment", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    printSettlementReceipt(mockResult());

    expect(logs.some((l) => l.includes("FULLY PAID"))).toBe(true);
  });

  it("printSettlementReceipt shows partial status when not fully paid", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    printSettlementReceipt(mockResult({ isFullyPaid: false, remainingAmount: 50 }));

    expect(logs.some((l) => l.includes("still open"))).toBe(true);
  });

  it("printPartialProgress shows paid and remaining amounts", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    printPartialProgress(mockResult({ paidAmount: 50, remainingAmount: 50, isFullyPaid: false }));

    expect(logs[0]).toMatch(/Paid 50 USDC/);
    expect(logs[0]).toMatch(/50 USDC remaining/);
  });
});
