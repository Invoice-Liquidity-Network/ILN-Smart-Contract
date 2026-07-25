/**
 * `iln marketplace` — list Pending invoices available for funding.
 *
 * Flags:
 *   --sort yield|amount|due   Sort order (default: yield desc)
 *   --filter token=USDC       Filter by token
 *
 * Issue: #230
 */
import { Command } from "commander";
import type { MarketplaceListing, MarketplaceOptions } from "./marketplace-types.js";
export type ListingsFetcher = () => Promise<MarketplaceListing[]>;
export declare function applyFilter(listings: MarketplaceListing[], filterStr?: string): MarketplaceListing[];
export declare function applySort(listings: MarketplaceListing[], sort?: MarketplaceOptions["sort"]): MarketplaceListing[];
export declare function printListingsTable(listings: MarketplaceListing[]): void;
export declare function makeMarketplaceCommand(fetchListings?: ListingsFetcher): Command;
//# sourceMappingURL=marketplace.d.ts.map