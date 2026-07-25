import { vi, describe, it, expect, beforeEach } from 'vitest';
import { makePauseCommand, makeUnpauseCommand } from "../../src/commands/pause";
import { resolveProfile } from "../../src/config";

vi.mock("../../src/config", async () => {
  const actual = await vi.importActual<typeof import("../../src/config")>("../../src/config");
  return {
    ...actual,
    resolveProfile: vi.fn(),
  };
});

const mockResolveProfile = resolveProfile as any;

describe("iln pause", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProfile.mockReturnValue({ name: "default", publicKey: "GADMIN" });
  });

  it("fails if no active wallet/profile is found", async () => {
    mockResolveProfile.mockReturnValue(null);
    const stateChecker = vi.fn().mockResolvedValue(false);
    const executor = vi.fn();
    const cmd = makePauseCommand(stateChecker, executor);

    const errLogs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => errLogs.push(a.join(" ")));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

    await cmd.parseAsync([], { from: "user" });

    expect(errLogs.some((l) => l.includes("No connected wallet found"))).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });

  it("skips pause if already paused", async () => {
    const stateChecker = vi.fn().mockResolvedValue(true);
    const executor = vi.fn();
    const cmd = makePauseCommand(stateChecker, executor);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync([], { from: "user" });

    expect(executor).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("already paused"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("pauses contract when user confirms", async () => {
    const stateChecker = vi.fn().mockResolvedValue(false);
    const executor = vi.fn().mockResolvedValue({ txHash: "TXPAUSE001", paused: true });
    const confirm = vi.fn().mockResolvedValue(true);
    const cmd = makePauseCommand(stateChecker, executor, confirm);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync([], { from: "user" });

    expect(executor).toHaveBeenCalled();
    expect(logs.some((l) => l.includes("paused"))).toBe(true);
    expect(logs.some((l) => l.includes("TXPAUSE001"))).toBe(true);
    expect(logs.some((l) => l.includes("State: Paused"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("skips confirmation with --yes flag", async () => {
    const stateChecker = vi.fn().mockResolvedValue(false);
    const executor = vi.fn().mockResolvedValue({ txHash: "TXPAUSE002", paused: true });
    const confirm = vi.fn();
    const cmd = makePauseCommand(stateChecker, executor, confirm);

    vi.spyOn(console, "log").mockImplementation(() => {});

    await cmd.parseAsync(["--yes"], { from: "user" });

    expect(confirm).not.toHaveBeenCalled();
    expect(executor).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("aborts when user declines", async () => {
    const stateChecker = vi.fn().mockResolvedValue(false);
    const executor = vi.fn();
    const confirm = vi.fn().mockResolvedValue(false);
    const cmd = makePauseCommand(stateChecker, executor, confirm);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync([], { from: "user" });

    expect(executor).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("Aborted"))).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("iln unpause", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProfile.mockReturnValue({ name: "default", publicKey: "GADMIN" });
  });

  it("fails if no active wallet/profile is found", async () => {
    mockResolveProfile.mockReturnValue(null);
    const stateChecker = vi.fn().mockResolvedValue(true);
    const executor = vi.fn();
    const cmd = makeUnpauseCommand(stateChecker, executor);

    const errLogs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => errLogs.push(a.join(" ")));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

    await cmd.parseAsync([], { from: "user" });

    expect(errLogs.some((l) => l.includes("No connected wallet found"))).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });

  it("skips unpause if already active", async () => {
    const stateChecker = vi.fn().mockResolvedValue(false);
    const executor = vi.fn();
    const cmd = makeUnpauseCommand(stateChecker, executor);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync([], { from: "user" });

    expect(executor).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("already unpaused"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("unpauses contract when user confirms", async () => {
    const stateChecker = vi.fn().mockResolvedValue(true);
    const executor = vi.fn().mockResolvedValue({ txHash: "TXUNPAUSE001", paused: false });
    const confirm = vi.fn().mockResolvedValue(true);
    const cmd = makeUnpauseCommand(stateChecker, executor, confirm);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync([], { from: "user" });

    expect(executor).toHaveBeenCalled();
    expect(logs.some((l) => l.includes("unpaused"))).toBe(true);
    expect(logs.some((l) => l.includes("TXUNPAUSE001"))).toBe(true);
    expect(logs.some((l) => l.includes("State: Active"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("skips confirmation with --yes flag", async () => {
    const stateChecker = vi.fn().mockResolvedValue(true);
    const executor = vi.fn().mockResolvedValue({ txHash: "TXUNPAUSE002", paused: false });
    const confirm = vi.fn();
    const cmd = makeUnpauseCommand(stateChecker, executor, confirm);

    vi.spyOn(console, "log").mockImplementation(() => {});

    await cmd.parseAsync(["--yes"], { from: "user" });

    expect(confirm).not.toHaveBeenCalled();
    expect(executor).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("aborts when user declines", async () => {
    const stateChecker = vi.fn().mockResolvedValue(true);
    const executor = vi.fn();
    const confirm = vi.fn().mockResolvedValue(false);
    const cmd = makeUnpauseCommand(stateChecker, executor, confirm);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

    await cmd.parseAsync([], { from: "user" });

    expect(executor).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("Aborted"))).toBe(true);
    vi.restoreAllMocks();
  });
});
