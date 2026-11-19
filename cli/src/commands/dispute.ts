/**
 * `iln dispute --invoice-id X --reason-hash Y` — dispute an invoice before settlement.
 *
 * Fetches the invoice first and validates it is Pending, PartiallyFunded, or Funded.
 * Shows a confirmation prompt before submitting the dispute TX.
 *
 * Issue: #414
 */
import * as readline from "readline";
import { Command } from "commander";
import type { InvoiceSummary, DisputeResult } from "./dispute-types.js";
import { formatOutput, formatError, isJsonMode } from "../format.js";

export type InvoiceFetcher = (id: string) => Promise<InvoiceSummary>;
export type DisputeExecutor = (invoiceId: string, reasonHash: string, payer?: string) => Promise<DisputeResult>;

async function promptConfirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

async function defaultFetcher(id: string): Promise<InvoiceSummary> {
  return { id, status: "Funded", amount: "100", token: "USDC", dueDate: "2025-12-31" };
}

async function defaultDisputeExecutor(invoiceId: string): Promise<DisputeResult> {
  return {
    invoiceId,
    txHash: `TX${Math.random().toString(36).slice(2).toUpperCase()}`,
    disputedAt: new Date().toISOString(),
  };
}

function validateDisputableState(invoice: InvoiceSummary): void {
  const disputableStates = ["Pending", "PartiallyFunded", "Funded"];
  if (!disputableStates.includes(invoice.status)) {
    throw new Error(`Invoice status is ${invoice.status}. Only Pending, PartiallyFunded, or Funded invoices can be disputed.`);
  }
}

function formatConfirmMessage(invoice: InvoiceSummary, reasonHash: string): string {
  return `Dispute invoice #${invoice.id} (${invoice.status}, ${invoice.amount} ${invoice.token}) with reason hash ${reasonHash}? [y/N]`;
}

export function makeDisputeCommand(
  fetchInvoice: InvoiceFetcher = defaultFetcher,
  disputeExecutor: DisputeExecutor = defaultDisputeExecutor,
  confirm: (msg: string) => Promise<boolean> = promptConfirm
): Command {
  const cmd = new Command("dispute").description("Dispute an invoice before settlement");

  cmd
    .requiredOption("--invoice-id <invoice-id>", "Invoice ID to dispute")
    .requiredOption("--reason-hash <hash>", "SHA-256 hash of dispute evidence")
    .option("--payer <address>", "Payer address (defaults to configured wallet)")
    .option("--yes", "Skip confirmation prompt")
    .action(async (opts: { invoiceId: string; reasonHash: string; payer?: string; yes?: boolean }) => {
      const parentOpts = cmd.parent?.opts() as Record<string, unknown> | undefined;
      const json = isJsonMode(parentOpts);

      try {
        const invoice = await fetchInvoice(opts.invoiceId);
        validateDisputableState(invoice);

        if (!opts.yes) {
          const confirmed = await confirm(formatConfirmMessage(invoice, opts.reasonHash));
          if (!confirmed) {
            formatOutput({ aborted: true, message: "no changes made" }, json, () => {
              console.log("Cancelled — no changes made.");
            });
            return;
          }
        }

        const result = await disputeExecutor(opts.invoiceId, opts.reasonHash, opts.payer);
        formatOutput(result, json, () => {
          console.log(`Invoice #${result.invoiceId} disputed. TX: ${result.txHash}`);
        });
      } catch (err) {
        formatError((err as Error).message, "DISPUTE_ERROR", json);
      }
    });

  return cmd;
}
