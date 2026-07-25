import { Command } from "commander";
import type { MarketplaceListing, FundResult } from "./marketplace-types.js";
export type InvoiceFetcher = (id: string) => Promise<MarketplaceListing>;
export type FundExecutor = (id: string) => Promise<FundResult>;
export declare function makeFundCommand(fetchInvoice?: InvoiceFetcher, executeFund?: FundExecutor, confirm?: (msg: string) => Promise<boolean>): Command;
//# sourceMappingURL=fund.d.ts.map