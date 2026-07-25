"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.toCsv = toCsv;
exports.toJson = toJson;
exports.filterByDate = filterByDate;
exports.makeExportCommand = makeExportCommand;
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
const fs_1 = __importDefault(require("fs"));
const commander_1 = require("commander");
/** Serialise rows to CSV with a header line. */
function toCsv(rows) {
    const header = "Invoice ID,State,Submitter,Payer,LP,Amount,Token,Yield %,Settlement Date";
    const lines = rows.map((r) => [
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
        .join(","));
    return [header, ...lines].join("\n");
}
/** Serialise rows to pretty-printed JSON. */
function toJson(rows) {
    return JSON.stringify(rows, null, 2);
}
/** Apply optional date filters to a row array. */
function filterByDate(rows, from, to) {
    return rows.filter((r) => {
        const d = new Date(r.settlementDate).getTime();
        if (isNaN(d))
            return true; // keep rows without a parseable date
        if (from && d < new Date(from).getTime())
            return false;
        if (to && d > new Date(to).getTime())
            return false;
        return true;
    });
}
function makeExportCommand(fetchInvoices = defaultFetcher) {
    const cmd = new commander_1.Command("export").description("Export invoice data to CSV or JSON");
    cmd
        .command("invoices")
        .description("Export invoices for a submitter or LP")
        .option("--submitter <address>", "Filter by submitter Stellar address")
        .option("--lp <address>", "Filter by LP Stellar address")
        .option("--format <csv|json>", "Output format", "csv")
        .option("--output <path>", "Write to file (default: stdout)")
        .option("--from <date>", "Start date filter (YYYY-MM-DD)")
        .option("--to <date>", "End date filter (YYYY-MM-DD)")
        .action(async (opts) => {
        try {
            let rows = await fetchInvoices({
                submitter: opts.submitter,
                lp: opts.lp,
            });
            rows = filterByDate(rows, opts.from, opts.to);
            const content = opts.format === "json" ? toJson(rows) : toCsv(rows);
            if (opts.output) {
                fs_1.default.writeFileSync(opts.output, content, "utf-8");
                console.error(`✓ Exported ${rows.length} invoice(s) to ${opts.output}`);
            }
            else {
                process.stdout.write(content + "\n");
            }
        }
        catch (err) {
            console.error(`Export failed: ${err.message}`);
            process.exit(1);
        }
    });
    return cmd;
}
/** Default fetcher — placeholder for SDK integration. */
async function defaultFetcher(_opts) {
    // TODO: replace with real SDK call once the SDK exposes a listInvoices method
    return [];
}
//# sourceMappingURL=export.js.map