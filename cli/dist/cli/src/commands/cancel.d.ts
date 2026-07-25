import { Command } from "commander";
import type { InvoiceSummary, CancelResult } from "./cancel-types.js";
export type InvoiceFetcher = (id: string) => Promise<InvoiceSummary>;
export type CancelExecutor = (id: string) => Promise<CancelResult>;
export declare function makeCancelCommand(fetchInvoice?: InvoiceFetcher, cancelExecutor?: CancelExecutor, confirm?: (msg: string) => Promise<boolean>): Command;
//# sourceMappingURL=cancel.d.ts.map