import { Command } from "commander";
import { formatError, formatOutput, isJsonMode } from "../format.js";

export interface AppealableInvoice { id: string; status: string; payer?: string }
export interface AppealResult { invoiceId: string; txHash: string; status?: string }
export type InvoiceFetcher = (invoiceId: string) => Promise<AppealableInvoice | null>;
export type AppealExecutor = (invoiceId: string, evidenceHash: string, payer?: string) => Promise<AppealResult>;

const EVIDENCE_HASH = /^(?:0x)?[a-fA-F0-9]{64}$/;
const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;

function defaultFetcher(invoiceId: string): Promise<AppealableInvoice> {
  return Promise.resolve({ id: invoiceId, status: "Defaulted" });
}
function defaultExecutor(invoiceId: string): Promise<AppealResult> {
  return Promise.resolve({ invoiceId, txHash: `TX${Math.random().toString(36).slice(2).toUpperCase()}`, status: "Appealed" });
}

export function makeAppealCommand(
  fetchInvoice: InvoiceFetcher = defaultFetcher,
  executeAppeal: AppealExecutor = defaultExecutor
): Command {
  const cmd = new Command("appeal").description("Appeal a defaulted invoice");
  cmd
    .requiredOption("--invoice-id <id>", "Invoice ID to appeal")
    .requiredOption("--evidence-hash <sha256>", "SHA-256 hash of off-chain evidence")
    .option("--payer <address>", "Payer address (defaults to the configured wallet)")
    .action(async (opts: { invoiceId: string; evidenceHash: string; payer?: string }) => {
      const json = isJsonMode(cmd.parent?.opts() as Record<string, unknown> | undefined);
      try {
        if (!/^\d+$/.test(opts.invoiceId) || BigInt(opts.invoiceId) < 1n) throw new Error("invoice ID must be a positive integer");
        if (!EVIDENCE_HASH.test(opts.evidenceHash)) throw new Error("evidence hash must be a 64-character SHA-256 hex digest");
        if (opts.payer && !STELLAR_ADDRESS.test(opts.payer)) throw new Error("payer must be a valid Stellar G-address");
        const invoice = await fetchInvoice(opts.invoiceId);
        if (!invoice) throw new Error(`invoice #${opts.invoiceId} does not exist`);
        if (invoice.status.toLowerCase() !== "defaulted") throw new Error(`invoice #${opts.invoiceId} is ${invoice.status}, not Defaulted`);
        const evidenceHash = opts.evidenceHash.replace(/^0x/i, "").toLowerCase();
        const result = await executeAppeal(opts.invoiceId, evidenceHash, opts.payer);
        formatOutput(result, json, () => console.log(`Invoice #${result.invoiceId} appealed. TX: ${result.txHash}`));
      } catch (error) {
        formatError((error as Error).message, "APPEAL_ERROR", json);
      }
    });
  return cmd;
}
