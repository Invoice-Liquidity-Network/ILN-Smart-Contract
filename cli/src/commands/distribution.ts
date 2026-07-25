/**
 * `iln distribution` — check accrued governance-token rewards and claim them.
 *
 * Issue: #460
 *
 * `claim` is stubbed (like `fund.ts`'s default executor) since the SDK does
 * not yet expose a signed write method for `claim_tokens` on the
 * iln_distribution contract — only the `get_accrual` read query exists in
 * sdk/src/methods/distribution.ts. `accrual` is wired to the real
 * `ILNClient.getDistributionAccrual` read method.
 */
import { Command } from "commander";
import { ILNClient } from "@iln/sdk";
import { resolveProfile } from "../config.js";
import { formatOutput, formatError, isJsonMode } from "../format.js";

export type AccrualFetcher = (contractId: string, address: string) => Promise<number>;
export type ClaimExecutor = (contractId: string) => Promise<{ txHash: string; amount: number }>;

async function defaultAccrualFetcher(contractId: string, address: string): Promise<number> {
  const client = ILNClient.testnet();
  return client.getDistributionAccrual(contractId, address);
}

async function defaultClaimExecutor(_contractId: string): Promise<{ txHash: string; amount: number }> {
  return { txHash: `TX${Math.random().toString(36).slice(2).toUpperCase()}`, amount: 0 };
}

function requireAddress(opts: { address?: string }): string {
  if (opts.address) return opts.address;
  const profile = resolveProfile();
  if (!profile) {
    throw new Error("No connected wallet found. Run: iln wallet generate");
  }
  return profile.publicKey;
}

export function makeDistributionCommand(
  fetchAccrual: AccrualFetcher = defaultAccrualFetcher,
  executeClaim: ClaimExecutor = defaultClaimExecutor
): Command {
  const cmd = new Command("distribution").description(
    "Check and claim accrued governance-token distribution rewards"
  );

  cmd
    .command("accrual")
    .description("Show accrued distribution tokens for a participant")
    .requiredOption("--contract <id>", "Distribution contract address")
    .option("-a, --address <address>", "Participant address (defaults to connected wallet)")
    .action(async (opts: { contract: string; address?: string }) => {
      const json = isJsonMode(cmd.parent?.opts() as Record<string, unknown> | undefined);
      try {
        const address = requireAddress(opts);
        const accrual = await fetchAccrual(opts.contract, address);
        formatOutput({ address, accrual }, json, () => {
          console.log(`Accrued tokens for ${address}: ${accrual}`);
        });
      } catch (err) {
        formatError((err as Error).message, "DISTRIBUTION_ACCRUAL_ERROR", json);
      }
    });

  cmd
    .command("claim")
    .description("Claim accrued distribution tokens")
    .requiredOption("--contract <id>", "Distribution contract address")
    .action(async (opts: { contract: string }) => {
      const json = isJsonMode(cmd.parent?.opts() as Record<string, unknown> | undefined);
      try {
        const result = await executeClaim(opts.contract);
        formatOutput(result, json, () => {
          console.log(`Claimed ${result.amount} tokens. TX: ${result.txHash}`);
        });
      } catch (err) {
        formatError((err as Error).message, "DISTRIBUTION_CLAIM_ERROR", json);
      }
    });

  return cmd;
}
