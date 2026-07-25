/**
 * `iln pay` command — pay an invoice in full or partially.
 *
 * Usage:
 *   iln pay --id X              → full payment
 *   iln pay --id X --amount 50  → partial payment of 50 USDC
 *   iln pay --id X --yes        → skip confirmation prompt
 *
 * Issue: #232
 */
import { Command } from "commander";
import type { InvoicePayState, PayResult } from "./pay-types";
/** Fetches current invoice state (remaining amount, token, payer, etc.) */
export type InvoiceFetcher = (id: string) => Promise<InvoicePayState>;
/** Executes the payment and returns a PayResult. */
export type PayExecutor = (id: string, amount: number) => Promise<PayResult>;
/** Prompts the user for a y/n confirmation. Returns true if confirmed. */
export type Prompter = (message: string) => Promise<boolean>;
/**
 * Prints the payment preview line shown before signing.
 * "Paying 50 USDC of 100 USDC remaining on Invoice #X (Payer earns LP: Y USDC)"
 */
export declare function printPaymentPreview(invoice: InvoicePayState, payAmount: number): void;
/** Receipt printer for full payment. */
export declare function printSettlementReceipt(result: PayResult): void;
/** Partial payment progress line. */
export declare function printPartialProgress(result: PayResult): void;
/**
 * Factory function following the project's injected-deps pattern.
 * Keeps the command pure and fully testable without real network calls.
 */
export declare function makePayCommand(prompter: Prompter, fetcher: InvoiceFetcher, executor: PayExecutor): Command;
//# sourceMappingURL=pay.d.ts.map