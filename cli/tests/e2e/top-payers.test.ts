import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTopPayersCommand } from "../../src/commands/top-payers";

describe("iln top-payers", () => {
  afterEach(() => vi.restoreAllMocks());

  it("defaults to ten and renders results by descending score", async () => {
    const fetcher = vi.fn().mockResolvedValue([
      { address: "GLOW", score: 12 },
      { address: "GHIGH", score: 91 },
    ]);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));

    await makeTopPayersCommand(fetcher).parseAsync([], { from: "user" });

    expect(fetcher).toHaveBeenCalledWith(10);
    expect(logs.join("\n").indexOf("GHIGH")).toBeLessThan(logs.join("\n").indexOf("GLOW"));
  });

  it("accepts a validated custom limit", async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await makeTopPayersCommand(fetcher).parseAsync(["--limit", "50"], { from: "user" });
    expect(fetcher).toHaveBeenCalledWith(50);
  });

  it("rejects limits outside 1-50 before querying", async () => {
    const fetcher = vi.fn();
    await expect(
      makeTopPayersCommand(fetcher).parseAsync(["--limit", "51"], { from: "user" }),
    ).rejects.toThrow("between 1 and 50");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
