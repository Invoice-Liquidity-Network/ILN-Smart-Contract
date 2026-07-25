/**
 * `iln fund --id X` — fund a Pending invoice as a liquidity provider.
 *
 * Shows a confirmation prompt with invoice details and yield before signing.
 * Use --yes to skip confirmation for scripting.
 *
 * Issue: #230
 */
import * as readline from "readline";
import { Command } from "commander";
import type { MarketplaceListing, FundResult } from "./marketplace-types.js";
import { formatOutput, formatError, isJsonMode } from "../format.js";

export type InvoiceFetcher = (id: string) => Promise<MarketplaceListing>;
export type FundExecutor = (id: string) => Promise<FundResult>;

async function promptConfirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

async function defaultFetcher(id: string): Promise<MarketplaceListing> {
  return { id, amount: "100", token: "USDC", yieldPct: "3.20", dueDate: "2025-12-31", payerReputation: "medium" };
}

async function defaultExecutor(id: string): Promise<FundResult> {
  return { invoiceId: id, txHash: `TX${Math.random().toString(36).slice(2).toUpperCase()}` };
}

export function makeFundCommand(
  fetchInvoice: InvoiceFetcher = defaultFetcher,
  executeFund: FundExecutor = defaultExecutor,
  confirm: (msg: string) => Promise<boolean> = promptConfirm
): Command {
  const cmd = new Command("fund").description("Fund a pending invoice as a liquidity provider");

  cmd
    .requiredOption("--id <invoice-id>", "Invoice ID to fund")
    .option("--yes", "Skip confirmation prompt")
    .action(async (opts: { id: string; yes?: boolean }) => {
      const parentOpts = cmd.parent?.opts() as Record<string, unknown> | undefined;
      const json = isJsonMode(parentOpts);

      try {
        const invoice = await fetchInvoice(opts.id);

        if (!opts.yes) {
          const msg = `Fund invoice #${invoice.id} (${invoice.amount} ${invoice.token}, ${invoice.yieldPct}% yield)? [y/N]`;
          const confirmed = await confirm(msg);
          if (!confirmed) {
            formatOutput({ aborted: true, message: "invoice not funded" }, json, () => {
              console.log("Aborted — invoice not funded.");
            });
            return;
          }
        }

        const result = await executeFund(opts.id);
        formatOutput(result, json, () => {
          console.log(`Funded invoice #${result.invoiceId}. TX: ${result.txHash}`);
        });
      } catch (err) {
        formatError((err as Error).message, "FUND_ERROR", json);
      }
    });

  return cmd;
}
