/**
 * `iln status --id X` — display a rich, human-readable invoice summary.
 *
 * Flags:
 *   --json    Output raw JSON for piping
 *   --watch   Refresh every 10 seconds until a terminal state is reached
 *
 * Issue: #231
 */
import { Command } from "commander";
import type { InvoiceDetail } from "./status-types.js";
export type InvoiceFetcher = (id: string) => Promise<InvoiceDetail>;
export declare function makeStatusCommand(fetchInvoice?: InvoiceFetcher, setIntervalFn?: typeof setInterval, clearIntervalFn?: typeof clearInterval): Command;
//# sourceMappingURL=status.d.ts.map