import { Command } from "commander";
import * as fs from "fs";
import { formatOutput, formatError, isJsonMode } from "../format.js";

export function makeBatchCommand(): Command {
  const cmd = new Command("batch").description(
    "Submit multiple invoices to the ILN network in a batch transaction"
  );

  cmd
    .requiredOption("-f, --file <path>", "Path to JSON file containing invoice parameters")
    .action(async (opts: { file: string }) => {
      const parentOpts = cmd.parent?.opts() as Record<string, unknown> | undefined;
      const json = isJsonMode(parentOpts);

      try {
        const fileContent = fs.readFileSync(opts.file, "utf8");
        const invoices = JSON.parse(fileContent);

        if (!Array.isArray(invoices)) {
          throw new Error("JSON file must contain an array of invoices");
        }

        // Simulate batch submission
        const txHash = `TX${Math.random().toString(36).slice(2).toUpperCase()}`;
        const results = invoices.map((_, i) => ({
          invoiceId: `INV-BATCH-${Date.now()}-${i}`,
          txHash,
        }));

        formatOutput({ results }, json, () => {
          console.log(`\n✓ Successfully submitted ${invoices.length} invoices.`);
          console.log(`Transaction Hash: ${txHash}`);
          console.log(`Invoice IDs: ${results.map(r => r.invoiceId).join(", ")}`);
        });
      } catch (err) {
        formatError((err as Error).message, "BATCH_ERROR", json);
      }
    });

  return cmd;
}
