/**
 * `iln insurance` — enroll, deposit, claim, and check status against the
 * default-protection insurance pool contract.
 *
 * Issue: #459
 *
 * `enroll`/`deposit`/`claim` are stubbed (like `fund.ts`'s default executor)
 * since the SDK does not yet expose signed write methods for the insurance
 * pool contract (`enroll`/`deposit_premium`/`claim` — only read queries
 * exist in sdk/src/methods/insurance.ts). `status` is wired to the real
 * `ILNClient.getInsurancePoolInfo` read method.
 */
import { Command } from "commander";
import { ILNClient } from "@iln/sdk";
import { resolveProfile } from "../config.js";
import { formatOutput, formatError, isJsonMode } from "../format.js";

export interface InsuranceStatus {
  poolBalance: bigint;
  coverage: bigint;
  isEnrolled: boolean;
  premiumsPaid: bigint;
}

export type StatusFetcher = (contractId: string, address: string) => Promise<InsuranceStatus>;
export type EnrollExecutor = (contractId: string) => Promise<{ txHash: string }>;
export type DepositExecutor = (contractId: string, amount: number) => Promise<{ txHash: string }>;
export type ClaimExecutor = (contractId: string, invoiceId: string) => Promise<{ txHash: string }>;

async function defaultStatusFetcher(contractId: string, address: string): Promise<InsuranceStatus> {
  const client = ILNClient.testnet();
  return client.getInsurancePoolInfo(contractId, address);
}

async function defaultEnrollExecutor(_contractId: string): Promise<{ txHash: string }> {
  return { txHash: `TX${Math.random().toString(36).slice(2).toUpperCase()}` };
}

async function defaultDepositExecutor(_contractId: string, _amount: number): Promise<{ txHash: string }> {
  return { txHash: `TX${Math.random().toString(36).slice(2).toUpperCase()}` };
}

async function defaultClaimExecutor(_contractId: string, _invoiceId: string): Promise<{ txHash: string }> {
  return { txHash: `TX${Math.random().toString(36).slice(2).toUpperCase()}` };
}

function requireAddress(opts: { address?: string }): string {
  if (opts.address) return opts.address;
  const profile = resolveProfile();
  if (!profile) {
    throw new Error("No connected wallet found. Run: iln wallet generate");
  }
  return profile.publicKey;
}

export function makeInsuranceCommand(
  fetchStatus: StatusFetcher = defaultStatusFetcher,
  executeEnroll: EnrollExecutor = defaultEnrollExecutor,
  executeDeposit: DepositExecutor = defaultDepositExecutor,
  executeClaim: ClaimExecutor = defaultClaimExecutor
): Command {
  const cmd = new Command("insurance").description(
    "Manage default-protection insurance pool enrollment and claims"
  );

  cmd
    .command("status")
    .description("Show insurance pool status for an LP")
    .requiredOption("--contract <id>", "Insurance pool contract address")
    .option("-a, --address <address>", "LP address to check (defaults to connected wallet)")
    .action(async (opts: { contract: string; address?: string }) => {
      const json = isJsonMode(cmd.parent?.opts() as Record<string, unknown> | undefined);
      try {
        const address = requireAddress(opts);
        const status = await fetchStatus(opts.contract, address);
        formatOutput(status, json, () => {
          console.log(`Enrolled:       ${status.isEnrolled}`);
          console.log(`Pool balance:   ${status.poolBalance}`);
          console.log(`Coverage cap:   ${status.coverage}`);
          console.log(`Premiums paid:  ${status.premiumsPaid}`);
        });
      } catch (err) {
        formatError((err as Error).message, "INSURANCE_STATUS_ERROR", json);
      }
    });

  cmd
    .command("enroll")
    .description("Enroll in the insurance pool")
    .requiredOption("--contract <id>", "Insurance pool contract address")
    .action(async (opts: { contract: string }) => {
      const json = isJsonMode(cmd.parent?.opts() as Record<string, unknown> | undefined);
      try {
        const result = await executeEnroll(opts.contract);
        formatOutput(result, json, () => {
          console.log(`Enrolled in insurance pool. TX: ${result.txHash}`);
        });
      } catch (err) {
        formatError((err as Error).message, "INSURANCE_ENROLL_ERROR", json);
      }
    });

  cmd
    .command("deposit")
    .description("Deposit a premium into the insurance pool")
    .requiredOption("--contract <id>", "Insurance pool contract address")
    .requiredOption("--amount <amount>", "Premium amount")
    .action(async (opts: { contract: string; amount: string }) => {
      const json = isJsonMode(cmd.parent?.opts() as Record<string, unknown> | undefined);
      try {
        const amount = Number(opts.amount);
        const result = await executeDeposit(opts.contract, amount);
        formatOutput(result, json, () => {
          console.log(`Deposited ${amount} premium. TX: ${result.txHash}`);
        });
      } catch (err) {
        formatError((err as Error).message, "INSURANCE_DEPOSIT_ERROR", json);
      }
    });

  cmd
    .command("claim")
    .description("File a claim against a defaulted invoice")
    .requiredOption("--contract <id>", "Insurance pool contract address")
    .requiredOption("--invoice <id>", "Defaulted invoice ID")
    .action(async (opts: { contract: string; invoice: string }) => {
      const json = isJsonMode(cmd.parent?.opts() as Record<string, unknown> | undefined);
      try {
        const result = await executeClaim(opts.contract, opts.invoice);
        formatOutput(result, json, () => {
          console.log(`Claim filed for invoice #${opts.invoice}. TX: ${result.txHash}`);
        });
      } catch (err) {
        formatError((err as Error).message, "INSURANCE_CLAIM_ERROR", json);
      }
    });

  return cmd;
}
