import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
/**
 * Tests for `iln marketplace` — listing (#230).
 */
import { makeMarketplaceCommand, applyFilter, applySort, printListingsTable } from "../../src/commands/marketplace";
import type { MarketplaceListing } from "../../src/commands/marketplace-types";

const LISTINGS: MarketplaceListing[] = [
  { id: "INV-A", amount: "500", token: "USDC", yieldPct: "3.50", dueDate: "2025-12-31", payerReputation: "high" },
  { id: "INV-B", amount: "1200", token: "EURC", yieldPct: "4.10", dueDate: "2026-01-15", payerReputation: "medium" },
  { id: "INV-C", amount: "300", token: "USDC", yieldPct: "2.80", dueDate: "2025-11-30", payerReputation: "low" },
];

describe("iln marketplace — list", () => {
  it("prints a table when listings are returned", async () => {
    const fetcher = vi.fn().mockResolvedValue(LISTINGS);
    const cmd = makeMarketplaceCommand(fetcher);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync([], { from: "user" });

    expect(fetcher).toHaveBeenCalled();
    expect(logs.some((l) => l.includes("INV-A"))).toBe(true);
    expect(logs.some((l) => l.includes("INV-B"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("prints no-results message when list is empty", async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const cmd = makeMarketplaceCommand(fetcher);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync([], { from: "user" });

    expect(logs.some((l) => l.toLowerCase().includes("no pending"))).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("applyFilter", () => {
  it("filters by token=USDC", () => {
    const result = applyFilter(LISTINGS, "token=USDC");
    expect(result.every((l) => l.token === "USDC")).toBe(true);
    expect(result).toHaveLength(2);
  });

  it("is case-insensitive for token filter", () => {
    expect(applyFilter(LISTINGS, "token=usdc")).toHaveLength(2);
  });

  it("returns all listings when no filter is given", () => {
    expect(applyFilter(LISTINGS)).toHaveLength(3);
  });
});

describe("applySort", () => {
  it("sorts by yield descending by default", () => {
    const result = applySort(LISTINGS);
    expect(Number(result[0].yieldPct)).toBeGreaterThanOrEqual(Number(result[1].yieldPct));
  });

  it("sorts by amount descending when sort=amount", () => {
    const result = applySort(LISTINGS, "amount");
    expect(Number(result[0].amount)).toBeGreaterThanOrEqual(Number(result[1].amount));
  });

  it("sorts by due date ascending when sort=due", () => {
    const result = applySort(LISTINGS, "due");
    expect(result[0].dueDate <= result[1].dueDate).toBe(true);
  });
});
