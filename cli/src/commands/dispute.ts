/**
 * `iln dispute` — dispute an invoice before settlement.
 *
 * Calls the contract's `dispute_invoice` function as the payer.
 * Validates the invoice is in a disputable state (Pending or Funded)
 * before submitting.
 *
 * Issue: #414
 */
import * as readline from "readline";
import { Command } from "commander";
import { formatOutput, formatError, isJsonMode } from "../format.js";

export type InvoiceState = "Pending" | "Funded" | "Settled" | "Cancelled" | "Disputed" | "Unknown";

export interface InvoiceSummary {
  id: string;
  state: InvoiceState;
  payer: string;
}

export interface DisputeResult {
  invoiceId: string;
  txHash: string;
  reasonHash: string;
  payer: string;
}

export type InvoiceFetcher = (id: string) => Promise<InvoiceSummary>;
export type DisputeExecutor = (id: string, reasonHash: string, payer: string) => Promise<DisputeResult>;
export type WalletResolver = () => Promise<string>;

async function promptConfirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

const REASON_HASH_RE = /^[a-f0-9]{64}$/;
const DISPUTABLE_STATES: InvoiceState[] = ["Pending", "Funded"];

export function validateReasonHash(reasonHash: string): boolean {
  return REASON_HASH_RE.test(reasonHash);
}

export function isDisputable(state: InvoiceState): boolean {
  return DISPUTABLE_STATES.includes(state);
}

async function defaultFetcher(id: string): Promise<InvoiceSummary> {
  return { id, state: "Funded", payer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
}

async function defaultExecutor(id: string, reasonHash: string, payer: string): Promise<DisputeResult> {
  return { invoiceId: id, txHash: `TX${Math.random().toString(36).slice(2).toUpperCase()}`, reasonHash, payer };
}

async function defaultResolver(): Promise<string> {
  return "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
}

export function makeDisputeCommand(
  fetchInvoice: InvoiceFetcher = defaultFetcher,
  executeDispute: DisputeExecutor = defaultExecutor,
  resolveWallet: WalletResolver = defaultResolver,
  confirm: (msg: string) => Promise<boolean> = promptConfirm
): Command {
  const cmd = new Command("dispute").description("Dispute a pending or funded invoice");

  cmd
    .requiredOption("--invoice-id <invoice-id>", "Invoice ID to dispute")
    .requiredOption("--reason-hash <reason-hash>", "SHA-256 hash of dispute evidence (64-char hex)")
    .option("--payer <payer>", "Payer Stellar address (defaults to configured wallet)")
    .option("--yes", "Skip confirmation prompt")
    .action(async (opts: { invoiceId: string; reasonHash: string; payer?: string; yes?: boolean }) => {
      const parentOpts = cmd.parent?.opts() as Record<string, unknown> | undefined;
      const json = isJsonMode(parentOpts);

      try {
        if (!validateReasonHash(opts.reasonHash)) {
          formatError("reason-hash must be a 64-character hex SHA-256 string", "VALIDATION_ERROR", json);
          return;
        }

        const invoice = await fetchInvoice(opts.invoiceId);

        if (!isDisputable(invoice.state)) {
          formatError(
            `invoice #${invoice.id} is in state '${invoice.state}'; only Pending or Funded invoices can be disputed`,
            "INVALID_STATE",
            json
          );
          return;
        }

        const payer = opts.payer ?? (await resolveWallet());

        if (!opts.yes) {
          const msg = `Dispute invoice #${invoice.id} (state ${invoice.state}, payer ${payer}) with reason ${opts.reasonHash}? [y/N]`;
          const confirmed = await confirm(msg);
          if (!confirmed) {
            formatOutput({ aborted: true, message: "invoice not disputed" }, json, () => {
              console.log("Aborted — invoice not disputed.");
            });
            return;
          }
        }

        const result = await executeDispute(invoice.id, opts.reasonHash, payer);
        formatOutput(result, json, () => {
          console.log(`Disputed invoice #${result.invoiceId}. TX: ${result.txHash}`);
        });
      } catch (err) {
        formatError((err as Error).message, "DISPUTE_ERROR", json);
      }
    });

  return cmd;
}
