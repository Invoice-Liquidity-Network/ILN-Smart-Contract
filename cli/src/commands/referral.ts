import { Command, InvalidArgumentError } from "commander";
import { getReferralStats, ILNClient } from "@iln/sdk";
import { formatError, formatOutput, isJsonMode } from "../format.js";

export type ReferralStatsFetcher = (code: string) => Promise<number>;

function validateReferralCode(value: string): string {
  if (!/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new InvalidArgumentError("Referral code must be exactly 64 hex characters");
  }
  return value.toLowerCase();
}

async function defaultFetcher(code: string): Promise<number> {
  const client = ILNClient.testnet();
  return getReferralStats(client.rpc, client.contractId, code, client.networkPassphrase);
}

export function makeReferralCommand(fetchStats: ReferralStatsFetcher = defaultFetcher): Command {
  const command = new Command("referral").description(
    "Query the referral count for a given referral code"
  );

  command
    .requiredOption("-c, --code <hex>", "64-character hex referral code", validateReferralCode)
    .action(async (options: { code: string }) => {
      const json = isJsonMode(command.parent?.opts() as Record<string, unknown> | undefined);
      try {
        const count = await fetchStats(options.code);
        formatOutput({ code: options.code, count }, json, () => {
          console.log(`Referral Code: ${options.code}`);
          console.log(`Total Referrals: ${count}`);
        });
      } catch (error) {
        formatError((error as Error).message, "REFERRAL_STATS_ERROR", json);
      }
    });

  return command;
}
