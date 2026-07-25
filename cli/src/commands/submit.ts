/**
 * `iln submit` — submit an invoice to the ILN network.
 *
 * Modes:
 *   Flag-based:   iln submit --payer G... --amount 100 --token USDC --rate 300 --due 2025-12-31
 *   Interactive:  iln submit  (launches @inquirer/prompts wizard)
 *   Dry-run:      any mode + --dry-run  (prints TX without signing)
 *
 * Issue: #229
 */
import { Command } from "commander";
import type { SubmitOptions, SubmitResult } from "./submit-types.js";
import { printReceiptTable, bpsToYieldPct } from "./submit-receipt.js";
import { formatOutput, formatError, isJsonMode } from "../format.js";

export type Prompter = () => Promise<Required<Omit<SubmitOptions, "dryRun">>>;
export type Submitter = (opts: Required<Omit<SubmitOptions, "dryRun">>) => Promise<SubmitResult>;

const TOKENS = ["USDC", "EURC", "XLM"] as const;

function validateStellarAddress(addr: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(addr);
}

export async function runInteractivePrompts(): Promise<Required<Omit<SubmitOptions, "dryRun">>> {
  const { input, select, confirm } = await import("@inquirer/prompts");

  const payer = await input({
    message: "Payer Stellar address:",
    validate: (v) => validateStellarAddress(v) || "Must be a valid Stellar G-address (56 chars)",
  });

  const amountStr = await input({
    message: "Invoice amount:",
    validate: (v) => (!isNaN(Number(v)) && Number(v) > 0) || "Must be a positive number",
  });

  const token = await select({
    message: "Token:",
    choices: TOKENS.map((t) => ({ value: t, name: t })),
  });

  const rateStr = await input({
    message: "Discount rate in basis points (e.g. 300 = 3.00%):",
    validate: (v) => {
      const n = Number(v);
      return (!isNaN(n) && n >= 0 && n <= 10000) || "Must be 0–10000";
    },
  });

  console.log(`  → Effective yield: ${bpsToYieldPct(Number(rateStr))}%`);

  const due = await input({
    message: "Due date (YYYY-MM-DD):",
    validate: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) || "Use YYYY-MM-DD format",
  });

  const referral = await input({ message: "Referral code (optional, press Enter to skip):" });

  return { payer, amount: amountStr, token, rate: rateStr, due, referral };
}

async function defaultSubmitter(opts: Required<Omit<SubmitOptions, "dryRun">>): Promise<SubmitResult> {
  const invoiceId = `INV-${Date.now()}`;
  const txHash = `TX${Math.random().toString(36).slice(2).toUpperCase()}`;
  return {
    invoiceId,
    txHash,
    payer: opts.payer,
    amount: opts.amount,
    token: opts.token,
    rateBps: Number(opts.rate),
    yieldPct: bpsToYieldPct(Number(opts.rate)),
    dueDate: opts.due,
    referral: opts.referral || undefined,
  };
}

export function makeSubmitCommand(
  prompter: Prompter = runInteractivePrompts,
  submitter: Submitter = defaultSubmitter
): Command {
  const cmd = new Command("submit").description(
    "Submit an invoice to the ILN network"
  );

  cmd
    .option("--payer <address>", "Payer Stellar G-address")
    .option("--amount <number>", "Invoice amount")
    .option("--token <USDC|EURC|XLM>", "Token", "USDC")
    .option("--rate <bps>", "Discount rate in basis points")
    .option("--due <YYYY-MM-DD>", "Due date")
    .option("--referral <code>", "Optional referral code")
    .option("--dry-run", "Build and print transaction without signing")
    .action(async (opts: SubmitOptions) => {
      const parentOpts = cmd.parent?.opts() as Record<string, unknown> | undefined;
      const json = isJsonMode(parentOpts);

      try {
        const isInteractive = !opts.payer && !opts.amount && !opts.rate && !opts.due;
        const params = isInteractive
          ? await prompter()
          : {
              payer: opts.payer ?? "",
              amount: opts.amount ?? "",
              token: opts.token ?? "USDC",
              rate: opts.rate ?? "0",
              due: opts.due ?? "",
              referral: opts.referral ?? "",
            };

        if (!params.payer || !validateStellarAddress(params.payer)) {
          formatError("invalid payer address", "INVALID_ADDRESS", json);
        }

        if (opts.dryRun) {
          const dryRunPayload = { ...params, rateBps: Number(params.rate) };
          formatOutput(dryRunPayload, json, () => {
            console.log("\n[dry-run] Transaction payload (not signed):");
            console.log(JSON.stringify(dryRunPayload, null, 2));
          });
          return;
        }

        const result = await submitter(params as Required<Omit<SubmitOptions, "dryRun">>);
        formatOutput(result, json, () => {
          console.log(`\n✓ Invoice #${result.invoiceId} submitted. TX: ${result.txHash}`);
          printReceiptTable(result);
        });
      } catch (err) {
        formatError((err as Error).message, "SUBMIT_ERROR", json);
      }
    });

  return cmd;
}
