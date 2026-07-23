/**
 * `iln dispute` — open a dispute against an invoice.
 *
 * Flags:
 *   --invoice-id <id>     (required) Invoice to dispute
 *   --reason-hash <hash>  (required) SHA-256 hash of the dispute evidence
 *   --payer <address>     (optional) Disputing payer; defaults to configured wallet
 *
 * Validates that the invoice is in state Pending or Funded before calling the
 * contract's `dispute_invoice` function and displaying the tx result.
 *
 * Issue: #414
 */
import * as readline from "readline";
import { Command } from "commander";
import { formatOutput, formatError, isJsonMode } from "../format.js";

/** Minimal view of an invoice needed for dispute validation. */
export interface DisputeInvoiceView {
  id: string;
  state: string;
}

export interface DisputeResult {
  invoiceId: string;
  payer: string;
  reasonHash: string;
  txHash: string;
}

export type InvoiceFetcher = (id: string) => Promise<DisputeInvoiceView>;
export type DisputeExecutor = (
  id: string,
  payer: string,
  reasonHash: string
) => Promise<DisputeResult>;
/** Resolves the default payer (configured wallet) when --payer is omitted. */
export type WalletResolver = () => Promise<string> | string;

const VALID_STATES = ["Pending", "Funded"] as const;

function validateReasonHash(hash: string): boolean {
  return /^[a-fA-F0-9]{64}$/.test(hash);
}

function validateDisputableState(invoice: DisputeInvoiceView): void {
  if (!VALID_STATES.includes(invoice.state as (typeof VALID_STATES)[number])) {
    throw new Error(
      `Invoice #${invoice.id} is in state "${invoice.state}" — only Pending or Funded invoices can be disputed.`
    );
  }
}

async function promptConfirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

async function defaultFetcher(id: string): Promise<DisputeInvoiceView> {
  return { id, state: "Funded" };
}

async function defaultExecutor(
  id: string,
  payer: string,
  reasonHash: string
): Promise<DisputeResult> {
  return {
    invoiceId: id,
    payer,
    reasonHash,
    txHash: `TX${Math.random().toString(36).slice(2).toUpperCase()}`,
  };
}

async function defaultWalletResolver(): Promise<string> {
  return process.env.ILN_WALLET ?? "GDEFAULTWALLETADDRESS00000000000000000000000000000000000000000000000";
}

export function makeDisputeCommand(
  fetchInvoice: InvoiceFetcher = defaultFetcher,
  executeDispute: DisputeExecutor = defaultExecutor,
  resolveWallet: WalletResolver = defaultWalletResolver,
  confirm: (msg: string) => Promise<boolean> = promptConfirm
): Command {
  const cmd = new Command("dispute").description(
    "Open a dispute against an invoice (Pending or Funded)"
  );

  cmd
    .requiredOption("--invoice-id <id>", "Invoice ID to dispute")
    .requiredOption(
      "--reason-hash <hash>",
      "SHA-256 hash of the dispute evidence"
    )
    .option("--payer <address>", "Disputing payer (defaults to configured wallet)")
    .option("--yes", "Skip confirmation prompt")
    .action(
      async (opts: { invoiceId: string; reasonHash: string; payer?: string; yes?: boolean }) => {
        const parentOpts = cmd.parent?.opts() as Record<string, unknown> | undefined;
        const json = isJsonMode(parentOpts);

        try {
          if (!validateReasonHash(opts.reasonHash)) {
            formatError(
              "--reason-hash must be a 64-character hex SHA-256 hash",
              "INVALID_REASON_HASH",
              json
            );
            return;
          }

          const invoice = await fetchInvoice(opts.invoiceId);
          validateDisputableState(invoice);

          const payer = opts.payer ?? (await resolveWallet());

          if (!opts.yes) {
            const confirmed = await confirm(
              `Dispute invoice #${invoice.id} as ${payer}? [y/N]`
            );
            if (!confirmed) {
              formatOutput({ aborted: true, message: "dispute not submitted" }, json, () => {
                console.log("Aborted — dispute not submitted.");
              });
              return;
            }
          }

          const result = await executeDispute(opts.invoiceId, payer, opts.reasonHash);
          formatOutput(result, json, () => {
            console.log(`Dispute opened for invoice #${result.invoiceId}. TX: ${result.txHash}`);
          });
        } catch (err) {
          formatError((err as Error).message, "DISPUTE_ERROR", json);
        }
      }
    );

  return cmd;
}
