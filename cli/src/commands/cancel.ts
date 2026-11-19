/**
 * `iln cancel --id X` — cancel a Pending invoice.
 *
 * Fetches the invoice first and validates it is Pending.
 * Shows a confirmation prompt before submitting the cancel TX.
 *
 * Issue: #233
 */
import * as readline from "readline";
import { Command } from "commander";
import type { InvoiceSummary, CancelResult } from "./cancel-types.js";
import { validatePendingState, formatConfirmMessage } from "./cancel-helpers.js";
import { formatOutput, formatError, isJsonMode } from "../format.js";

export type InvoiceFetcher = (id: string) => Promise<InvoiceSummary>;
export type CancelExecutor = (id: string) => Promise<CancelResult>;

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
  return { id, state: "Pending", amount: "100", token: "USDC", dueDate: "2025-12-31" };
}

async function defaultCancelExecutor(id: string): Promise<CancelResult> {
  return { invoiceId: id, txHash: `TX${Math.random().toString(36).slice(2).toUpperCase()}` };
}

export function makeCancelCommand(
  fetchInvoice: InvoiceFetcher = defaultFetcher,
  cancelExecutor: CancelExecutor = defaultCancelExecutor,
  confirm: (msg: string) => Promise<boolean> = promptConfirm
): Command {
  const cmd = new Command("cancel").description("Cancel a pending invoice");

  cmd
    .requiredOption("--id <invoice-id>", "Invoice ID to cancel")
    .option("--yes", "Skip confirmation prompt")
    .action(async (opts: { id: string; yes?: boolean }) => {
      const parentOpts = cmd.parent?.opts() as Record<string, unknown> | undefined;
      const json = isJsonMode(parentOpts);

      try {
        const invoice = await fetchInvoice(opts.id);
        validatePendingState(invoice);

        if (!opts.yes) {
          const confirmed = await confirm(formatConfirmMessage(invoice));
          if (!confirmed) {
            formatOutput({ aborted: true, message: "no changes made" }, json, () => {
              console.log("Cancelled — no changes made.");
            });
            return;
          }
        }

        const result = await cancelExecutor(opts.id);
        formatOutput(result, json, () => {
          console.log(`Invoice #${result.invoiceId} cancelled. TX: ${result.txHash}`);
        });
      } catch (err) {
        formatError((err as Error).message, "CANCEL_ERROR", json);
      }
    });

  return cmd;
}
