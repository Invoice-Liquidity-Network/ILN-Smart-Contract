import { vi, describe, it, expect } from "vitest";
/**
 * Tests for `iln insurance` — enroll, deposit, claim, status (#459).
 */
vi.mock("@iln/sdk", () => ({
  ILNClient: { testnet: vi.fn() },
}));
import { makeInsuranceCommand } from "../../src/commands/insurance";

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const LP = "GBR7RT4MZTLKK2JNZPOSWVY74VFDR4HVR24QZNH2WONHPQFJZPKHWOTP";

describe("iln insurance", () => {
  it("status prints pool info for a given address", async () => {
    const fetchStatus = vi.fn().mockResolvedValue({
      poolBalance: 5000n,
      coverage: 1000n,
      isEnrolled: true,
      premiumsPaid: 200n,
    });
    const cmd = makeInsuranceCommand(fetchStatus, vi.fn(), vi.fn(), vi.fn());

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync(["status", "--contract", CONTRACT, "--address", LP], { from: "user" });

    expect(fetchStatus).toHaveBeenCalledWith(CONTRACT, LP);
    expect(logs.some((l) => l.includes("Enrolled:"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("enroll submits and prints the tx hash", async () => {
    const executeEnroll = vi.fn().mockResolvedValue({ txHash: "TXENROLL1" });
    const cmd = makeInsuranceCommand(vi.fn(), executeEnroll, vi.fn(), vi.fn());

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync(["enroll", "--contract", CONTRACT], { from: "user" });

    expect(executeEnroll).toHaveBeenCalledWith(CONTRACT);
    expect(logs.some((l) => l.includes("TXENROLL1"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("deposit submits the given amount", async () => {
    const executeDeposit = vi.fn().mockResolvedValue({ txHash: "TXDEP1" });
    const cmd = makeInsuranceCommand(vi.fn(), vi.fn(), executeDeposit, vi.fn());
    vi.spyOn(console, "log").mockImplementation(() => {});

    await cmd.parseAsync(["deposit", "--contract", CONTRACT, "--amount", "50"], { from: "user" });

    expect(executeDeposit).toHaveBeenCalledWith(CONTRACT, 50);
    vi.restoreAllMocks();
  });

  it("claim submits against the given invoice", async () => {
    const executeClaim = vi.fn().mockResolvedValue({ txHash: "TXCLAIM1" });
    const cmd = makeInsuranceCommand(vi.fn(), vi.fn(), vi.fn(), executeClaim);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await cmd.parseAsync(
      ["claim", "--contract", CONTRACT, "--invoice", "42", "--lp", LP],
      { from: "user" }
    );

    expect(executeClaim).toHaveBeenCalledWith(CONTRACT, "42", LP);
    vi.restoreAllMocks();
  });

  it("health shows pool solvency metrics", async () => {
    const fetchHealth = vi.fn().mockResolvedValue({
      balance: 100000n,
      enrolledLpCount: 42,
      estimatedMonthlyClaimRate: 500n,
      monthsOfCoverage: 200,
    });
    const cmd = makeInsuranceCommand(vi.fn(), vi.fn(), vi.fn(), vi.fn(), fetchHealth);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync(["health", "--contract", CONTRACT], { from: "user" });

    expect(fetchHealth).toHaveBeenCalledWith(CONTRACT);
    expect(logs.some((l) => l.includes("Pool Balance"))).toBe(true);
    expect(logs.some((l) => l.includes("Enrolled LPs"))).toBe(true);
    vi.restoreAllMocks();
  });
});
