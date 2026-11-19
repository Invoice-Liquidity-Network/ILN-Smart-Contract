import { vi, describe, it, expect } from "vitest";
/**
 * Tests for `iln distribution` — accrual, claim (#460).
 */
vi.mock("@iln/sdk", () => ({
  ILNClient: { testnet: vi.fn() },
}));
import { makeDistributionCommand } from "../../src/commands/distribution";

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const PARTICIPANT = "GBR7RT4MZTLKK2JNZPOSWVY74VFDR4HVR24QZNH2WONHPQFJZPKHWOTP";

describe("iln distribution", () => {
  it("accrual prints the accrued token amount for a given address", async () => {
    const fetchAccrual = vi.fn().mockResolvedValue(1250);
    const cmd = makeDistributionCommand(fetchAccrual, vi.fn());

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync(["accrual", "--contract", CONTRACT, "--address", PARTICIPANT], { from: "user" });

    expect(fetchAccrual).toHaveBeenCalledWith(CONTRACT, PARTICIPANT);
    expect(logs.some((l) => l.includes("1250"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("claim submits and prints the tx hash", async () => {
    const executeClaim = vi.fn().mockResolvedValue({ txHash: "TXCLAIMD1", amount: 500 });
    const cmd = makeDistributionCommand(vi.fn(), executeClaim);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync(["claim", "--contract", CONTRACT], { from: "user" });

    expect(executeClaim).toHaveBeenCalledWith(CONTRACT);
    expect(logs.some((l) => l.includes("TXCLAIMD1"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("accrual exits with error when fetcher throws", async () => {
    const fetchAccrual = vi.fn().mockRejectedValue(new Error("simulation failed"));
    const cmd = makeDistributionCommand(fetchAccrual, vi.fn());
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await cmd.parseAsync(["accrual", "--contract", CONTRACT, "--address", PARTICIPANT], { from: "user" });

    expect(exit).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });
});
