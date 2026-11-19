import { vi, describe, it, expect, afterEach } from 'vitest';
/**
 * Tests for the shared formatOutput / formatError / isJsonMode utilities.
 */
import { formatOutput, formatError, isJsonMode } from "../../src/format";

describe("isJsonMode", () => {
  it("returns true when parentOpts.json is true", () => {
    expect(isJsonMode({ json: true })).toBe(true);
  });

  it("returns false when parentOpts.json is false", () => {
    expect(isJsonMode({ json: false })).toBe(false);
  });

  it("returns false when parentOpts is undefined", () => {
    expect(isJsonMode(undefined)).toBe(false);
  });

  it("returns false when json key is absent", () => {
    expect(isJsonMode({ profile: "default" })).toBe(false);
  });
});

describe("formatOutput", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("outputs JSON string when json=true", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const data = { id: "INV-1", amount: "100" };

    formatOutput(data, true);

    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(data));
  });

  it("calls human callback when json=false", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const human = vi.fn();
    const data = { id: "INV-1" };

    formatOutput(data, false, human);

    expect(human).toHaveBeenCalledOnce();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("human callback is optional and does not throw", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    formatOutput({ ok: true }, false);

    expect(logSpy).not.toHaveBeenCalled();
  });

  it("outputs valid parseable JSON", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const data = { nested: { arr: [1, 2, 3] }, str: "hello" };

    formatOutput(data, true);

    const output = logSpy.mock.calls[0][0] as string;
    expect(() => JSON.parse(output)).not.toThrow();
    expect(JSON.parse(output)).toEqual(data);
  });
});

describe("formatError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("outputs structured JSON error when json=true", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

    formatError("something broke", "MY_ERROR", true);

    const output = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({ error: "something broke", code: "MY_ERROR" });
    expect(exitSpy).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });

  it("outputs plain text error when json=false", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

    formatError("something broke", "MY_ERROR", false);

    expect(errorSpy).toHaveBeenCalledWith("Error: something broke");
    expect(exitSpy).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });

  it("JSON error output is parseable", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

    formatError("fail & stuff", "X", true);

    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.error).toBe("fail & stuff");
    expect(parsed.code).toBe("X");
    vi.restoreAllMocks();
  });
});
