import { Command, InvalidArgumentError } from "commander";
import { ILNClient, type InvoiceNftMetadata } from "@iln/sdk";
import { formatError, formatOutput, isJsonMode } from "../format.js";

export interface NftQueries {
  metadata(invoiceId: bigint): Promise<InvoiceNftMetadata | null>;
  owner(invoiceId: bigint): Promise<string | null>;
}

function parseInvoiceId(value: string): bigint {
  if (!/^\d+$/.test(value) || BigInt(value) < 1n) {
    throw new InvalidArgumentError("invoice ID must be a positive integer");
  }
  return BigInt(value);
}

function defaultQueries(): NftQueries {
  const client = ILNClient.testnet();
  return {
    metadata: (invoiceId) => client.queryNftMetadata(invoiceId),
    owner: (invoiceId) => client.queryNftOwner(invoiceId),
  };
}

function displayMetadata(metadata: InvoiceNftMetadata) {
  return {
    amount: metadata.amount.toString(),
    dueDate: metadata.dueDate.toString(),
    discountRate: metadata.discountRate,
    token: metadata.token,
    owner: metadata.owner,
    mintedAt: metadata.mintedAt.toString(),
  };
}

function printMetadata(metadata: ReturnType<typeof displayMetadata>): void {
  const rows = [
    ["Amount", metadata.amount],
    ["Due date", metadata.dueDate],
    ["Discount rate", `${metadata.discountRate} bps`],
    ["Token", metadata.token],
    ["Owner", metadata.owner],
    ["Minted at", metadata.mintedAt],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  rows.forEach(([label, value]) => console.log(`${label.padEnd(width)}  ${value}`));
}

export function makeNftCommand(queries: NftQueries = defaultQueries()): Command {
  const command = new Command("nft").description("Query invoice NFT ownership and metadata");

  command
    .command("metadata")
    .description("Display invoice NFT metadata")
    .requiredOption("--invoice-id <id>", "Invoice ID", parseInvoiceId)
    .action(async (options: { invoiceId: bigint }) => {
      const json = isJsonMode(command.parent?.opts() as Record<string, unknown> | undefined);
      try {
        const metadata = await queries.metadata(options.invoiceId);
        if (!metadata) throw new Error(`NFT for invoice ${options.invoiceId} was not found`);
        const result = displayMetadata(metadata);
        formatOutput(result, json, () => printMetadata(result));
      } catch (error) {
        formatError((error as Error).message, "NFT_METADATA_ERROR", json);
      }
    });

  command
    .command("owner")
    .description("Display the current invoice NFT owner")
    .requiredOption("--invoice-id <id>", "Invoice ID", parseInvoiceId)
    .action(async (options: { invoiceId: bigint }) => {
      const json = isJsonMode(command.parent?.opts() as Record<string, unknown> | undefined);
      try {
        const owner = await queries.owner(options.invoiceId);
        if (!owner) throw new Error(`NFT for invoice ${options.invoiceId} was not found`);
        formatOutput({ invoiceId: options.invoiceId.toString(), owner }, json, () =>
          console.log(owner),
        );
      } catch (error) {
        formatError((error as Error).message, "NFT_OWNER_ERROR", json);
      }
    });

  return command;
}
