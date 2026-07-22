import { afterEach, describe, expect, it, vi } from "vitest";
import { makeNftCommand, type NftQueries } from "../../src/commands/nft";

const queries: NftQueries = {
  metadata: vi.fn().mockResolvedValue({
    amount: 250_0000000n,
    dueDate: 1_800_000_000n,
    discountRate: 350,
    token: "CUSDC",
    owner: "GOWNER",
    mintedAt: 1_700_000_000n,
  }),
  owner: vi.fn().mockResolvedValue("GOWNER"),
};

describe("iln nft", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prints readable metadata", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
    await makeNftCommand(queries).parseAsync(["metadata", "--invoice-id", "42"], {
      from: "user",
    });
    expect(queries.metadata).toHaveBeenCalledWith(42n);
    expect(logs.join("\n")).toContain("Discount rate");
    expect(logs.join("\n")).toContain("GOWNER");
  });

  it("prints the current owner", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await makeNftCommand(queries).parseAsync(["owner", "--invoice-id", "42"], {
      from: "user",
    });
    expect(queries.owner).toHaveBeenCalledWith(42n);
    expect(log).toHaveBeenCalledWith("GOWNER");
  });
});
