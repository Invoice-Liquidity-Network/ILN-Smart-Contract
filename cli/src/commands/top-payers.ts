import { Command, InvalidArgumentError } from "commander";
import { ILNClient, type TopPayer } from "@iln/sdk";
import { formatError, formatOutput, isJsonMode } from "../format.js";

export type TopPayersFetcher = (limit: number) => Promise<TopPayer[]>;

function parseLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new InvalidArgumentError("limit must be an integer between 1 and 50");
  }
  return limit;
}

function printTopPayers(payers: TopPayer[]): void {
  if (payers.length === 0) {
    console.log("No ranked payers found.");
    return;
  }

  const sorted = [...payers].sort((left, right) => right.score - left.score);
  const addressWidth = Math.max("ADDRESS".length, ...sorted.map(({ address }) => address.length));
  console.log(`${"RANK".padEnd(6)}${"ADDRESS".padEnd(addressWidth + 2)}SCORE`);
  console.log("-".repeat(addressWidth + 15));
  sorted.forEach(({ address, score }, index) => {
    console.log(`${String(index + 1).padEnd(6)}${address.padEnd(addressWidth + 2)}${score}`);
  });
}

async function defaultFetcher(limit: number): Promise<TopPayer[]> {
  return ILNClient.testnet().getTopPayers(limit);
}

export function makeTopPayersCommand(fetchPayers: TopPayersFetcher = defaultFetcher): Command {
  const command = new Command("top-payers").description(
    "List the highest-reputation invoice payers",
  );

  command
    .option("--limit <number>", "Number of payers to return (1-50)", parseLimit, 10)
    .action(async (options: { limit: number }) => {
      const json = isJsonMode(command.parent?.opts() as Record<string, unknown> | undefined);
      try {
        const payers = (await fetchPayers(options.limit))
          .sort((left, right) => right.score - left.score)
          .slice(0, options.limit);
        formatOutput(payers, json, () => printTopPayers(payers));
      } catch (error) {
        formatError((error as Error).message, "TOP_PAYERS_ERROR", json);
      }
    });

  return command;
}
