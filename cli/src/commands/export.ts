/**
 * `iln export` — export invoice data to CSV or JSON.
 *
 * Usage:
 *   iln export invoices --submitter G...
 *   iln export invoices --lp G...
 *   iln export invoices --format json --output ./invoices.json
 *   iln export invoices --from 2025-01-01 --to 2025-12-31
 *
 * Issue: #244
 */
import fs from "fs";
import { Command } from "commander";
import { formatError, isJsonMode } from "../format.js";

export interface InvoiceRow {
  id: string;
  state: string;
  submitter: string;
  payer: string;
  lp: string;
  amount: string;
  token: string;
  yieldPct: string;
  settlementDate: string;
}

/** Serialise rows to CSV with a header line. */
export function toCsv(rows: InvoiceRow[]): string {
  const header =
    "Invoice ID,State,Submitter,Payer,LP,Amount,Token,Yield %,Settlement Date";
  const lines = rows.map((r) =>
    [
      r.id,
      r.state,
      r.submitter,
      r.payer,
      r.lp,
      r.amount,
      r.token,
      r.yieldPct,
      r.settlementDate,
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(",")
  );
  return [header, ...lines].join("\n");
}

/** Serialise rows to pretty-printed JSON. */
export function toJson(rows: InvoiceRow[]): string {
  return JSON.stringify(rows, null, 2);
}

/** Apply optional date filters to a row array. */
export function filterByDate(
  rows: InvoiceRow[],
  from?: string,
  to?: string
): InvoiceRow[] {
  return rows.filter((r) => {
    const d = new Date(r.settlementDate).getTime();
    if (isNaN(d)) return true; // keep rows without a parseable date
    if (from && d < new Date(from).getTime()) return false;
    if (to && d > new Date(to).getTime()) return false;
    return true;
  });
}

/**
 * Fetch invoices from the network. In real usage this calls the SDK;
 * tests can inject a mock via the parameter.
 */
export type InvoiceFetcher = (opts: {
  submitter?: string;
  lp?: string;
}) => Promise<InvoiceRow[]>;

/** Default fetcher using the SDK's getLpInvoices method. */
async function sdkFetcher(opts: {
  submitter?: string;
  lp?: string;
}): Promise<InvoiceRow[]> {
  // Dynamic import to avoid bundling the SDK when not needed
  const { iln } = await import("@iln/sdk");

  // SDK currently exposes getLpInvoices; if a submitter filter is requested
  // without an LP, we fetch all LP invoices and filter client-side.
  const lpAddress = opts.lp;
  if (!lpAddress) {
    // No LP filter — fetch a broad page and let date/submitter filters apply
    // For now, return empty if no LP specified (submitter-only queries need
    // a dedicated SDK method which is tracked separately).
    console.warn(
      "Warning: --submitter filter requires a future SDK method. " +
      "Use --lp to filter by liquidity provider."
    );
    return [];
  }

  const invoices = await iln.getLpInvoices(lpAddress, 0, 50);
  return invoices.map((inv: any) => ({
    id: inv.id ?? "",
    state: inv.state ?? "",
    submitter: inv.submitter ?? "",
    payer: inv.payer ?? "",
    lp: inv.lp ?? lpAddress,
    amount: inv.amount ?? "",
    token: inv.token ?? "",
    yieldPct: inv.yieldPct ?? "",
    settlementDate: inv.settlementDate ?? "",
  }));
}

export function makeExportCommand(
  fetchInvoices: InvoiceFetcher = sdkFetcher
): Command {
  const cmd = new Command("export").description(
    "Export invoice data to CSV or JSON"
  );

  cmd
    .command("invoices")
    .description("Export invoices for a submitter or LP")
    .option("--submitter <address>", "Filter by submitter Stellar address")
    .option("--lp <address>", "Filter by LP Stellar address")
    .option("--format <csv|json>", "Output format", "csv")
    .option("--output <path>", "Write to file (default: stdout)")
    .option("--from <date>", "Start date filter (YYYY-MM-DD)")
    .option("--to <date>", "End date filter (YYYY-MM-DD)")
    .action(
      async (opts: {
        submitter?: string;
        lp?: string;
        format: string;
        output?: string;
        from?: string;
        to?: string;
      }) => {
        const rootOpts = cmd.parent?.opts() as Record<string, unknown> | undefined;
        const json = isJsonMode(rootOpts);

        try {
          let rows = await fetchInvoices({
            submitter: opts.submitter,
            lp: opts.lp,
          });

          rows = filterByDate(rows, opts.from, opts.to);

          const content =
            opts.format === "json" ? toJson(rows) : toCsv(rows);

          if (opts.output) {
            fs.writeFileSync(opts.output, content, "utf-8");
            console.error(`✓ Exported ${rows.length} invoice(s) to ${opts.output}`);
          } else {
            process.stdout.write(content + "\n");
          }
        } catch (err) {
          formatError((err as Error).message, "EXPORT_ERROR", json);
        }
      }
    );

  return cmd;
}
