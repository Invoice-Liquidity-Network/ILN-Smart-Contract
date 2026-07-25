"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyFilter = applyFilter;
exports.applySort = applySort;
exports.printListingsTable = printListingsTable;
exports.makeMarketplaceCommand = makeMarketplaceCommand;
/**
 * `iln marketplace` — list Pending invoices available for funding.
 *
 * Flags:
 *   --sort yield|amount|due   Sort order (default: yield desc)
 *   --filter token=USDC       Filter by token
 *
 * Issue: #230
 */
const commander_1 = require("commander");
function applyFilter(listings, filterStr) {
    if (!filterStr)
        return listings;
    const [key, value] = filterStr.split("=");
    if (key === "token" && value) {
        return listings.filter((l) => l.token.toUpperCase() === value.toUpperCase());
    }
    return listings;
}
function applySort(listings, sort) {
    const copy = [...listings];
    if (sort === "amount")
        return copy.sort((a, b) => Number(b.amount) - Number(a.amount));
    if (sort === "due")
        return copy.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    return copy.sort((a, b) => Number(b.yieldPct) - Number(a.yieldPct));
}
function printListingsTable(listings) {
    if (listings.length === 0) {
        console.log("No pending invoices match your criteria.");
        return;
    }
    const header = "ID".padEnd(16) + "Amount".padEnd(12) + "Token".padEnd(8) + "Yield%".padEnd(10) + "Due Date".padEnd(14) + "Reputation";
    console.log("\n" + header);
    console.log("─".repeat(header.length));
    for (const l of listings) {
        console.log(l.id.padEnd(16) +
            l.amount.padEnd(12) +
            l.token.padEnd(8) +
            l.yieldPct.padEnd(10) +
            l.dueDate.padEnd(14) +
            l.payerReputation);
    }
}
async function defaultFetcher() {
    return [
        { id: "INV-101", amount: "500", token: "USDC", yieldPct: "3.50", dueDate: "2025-12-31", payerReputation: "high" },
        { id: "INV-102", amount: "1200", token: "EURC", yieldPct: "4.10", dueDate: "2026-01-15", payerReputation: "medium" },
        { id: "INV-103", amount: "300", token: "USDC", yieldPct: "2.80", dueDate: "2025-11-30", payerReputation: "low" },
    ];
}
function makeMarketplaceCommand(fetchListings = defaultFetcher) {
    const cmd = new commander_1.Command("marketplace").description("List pending invoices available for funding");
    cmd
        .option("--sort <yield|amount|due>", "Sort order", "yield")
        .option("--filter <key=value>", "Filter (e.g. token=USDC)")
        .action(async (opts) => {
        try {
            let listings = await fetchListings();
            listings = applyFilter(listings, opts.filter);
            listings = applySort(listings, opts.sort);
            printListingsTable(listings);
        }
        catch (err) {
            console.error(`Marketplace error: ${err.message}`);
            process.exit(1);
        }
    });
    return cmd;
}
//# sourceMappingURL=marketplace.js.map