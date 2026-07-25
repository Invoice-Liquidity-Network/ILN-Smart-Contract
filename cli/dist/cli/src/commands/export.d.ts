import { Command } from "commander";
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
export declare function toCsv(rows: InvoiceRow[]): string;
/** Serialise rows to pretty-printed JSON. */
export declare function toJson(rows: InvoiceRow[]): string;
/** Apply optional date filters to a row array. */
export declare function filterByDate(rows: InvoiceRow[], from?: string, to?: string): InvoiceRow[];
/**
 * Fetch invoices from the network. In real usage this would call the SDK;
 * here we expose a hook so tests can inject mock data.
 */
export type InvoiceFetcher = (opts: {
    submitter?: string;
    lp?: string;
}) => Promise<InvoiceRow[]>;
export declare function makeExportCommand(fetchInvoices?: InvoiceFetcher): Command;
//# sourceMappingURL=export.d.ts.map