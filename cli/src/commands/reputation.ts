import { Command } from "commander";
import { ILNClient } from "@iln/sdk";
import { resolveProfile, loadConfig } from "../config.js";
import { formatOutput, formatError, isJsonMode } from "../format.js";

/** Basic ANSI colors for terminal output. */
const colors = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
};

function getColorForScore(score: number): string {
  if (score >= 70) return colors.green;
  if (score >= 40) return colors.yellow;
  return colors.red;
}

export function makeReputationCommand(): Command {
  const cmd = new Command("reputation").description(
    "Check an address's ILN reputation score"
  );

  cmd
    .option("-a, --address <address>", "Stellar address to check")
    .option("--json", "Output result as JSON (also available as global flag)")
    .action(async (opts: { address?: string; json?: boolean }) => {
      const parentOpts = cmd.parent?.opts() as Record<string, unknown> | undefined;
      const json = opts.json || isJsonMode(parentOpts);

      try {
        const config = loadConfig();
        const client = ILNClient.testnet(); // Default to testnet for CLI

        let address = opts.address;
        if (!address) {
          const profile = resolveProfile();
          if (!profile) {
            formatError("No connected wallet found. Run: iln wallet generate", "NO_WALLET", json);
          }
          address = profile!.publicKey;
        }

        const rep = await client.getReputation(address);

        formatOutput(rep, json, () => {
          const scoreColor = getColorForScore(rep.score);
          console.log(`${colors.bold}Reputation Profile for ${address}${colors.reset}`);
          console.log(`--------------------------------------------------`);
          console.log(`Score:       ${scoreColor}${rep.score}${colors.reset}`);
          console.log(`Paid:        ${rep.invoicesPaid}`);
          console.log(`Defaulted:   ${rep.invoicesDefaulted}`);
          console.log(`Submitted:   ${rep.invoicesSubmitted}`);
          // Decay status not available in SDK, omitting or marking as N/A
          console.log(`Decay:       N/A`);
          console.log(`--------------------------------------------------`);
        });
      } catch (err: any) {
        formatError(err.message, "REPUTATION_ERROR", json);
      }
    });

  return cmd;
}
