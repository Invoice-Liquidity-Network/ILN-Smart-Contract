/**
 * Tests for retry utility
 */

import { describe, it, expect, vi } from "vitest";
import { retry, withRetry } from "./retry.js";

describe("retry", () => {
  it("should return result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("success");
    const result = await retry(fn);
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should retry on transient timeout error", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValue("success");
    
    const result = await retry(fn, { maxRetries: 2, initialDelayMs: 10 });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should retry on connection error", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue("success");
    
    const result = await retry(fn, { maxRetries: 2, initialDelayMs: 10 });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should retry on HTTP 429 rate limit error", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockResolvedValue("success");
    
    const result = await retry(fn, { maxRetries: 2, initialDelayMs: 10 });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should retry on HTTP 503 service unavailable error", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("503 Service Unavailable"))
      .mockResolvedValue("success");
    
    const result = await retry(fn, { maxRetries: 2, initialDelayMs: 10 });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should use exponential back-off", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValue("success");
    
    const startTime = Date.now();
    await retry(fn, { maxRetries: 3, initialDelayMs: 50, backoffMultiplier: 2 });
    const elapsed = Date.now() - startTime;
    
    // Should wait at least 50ms + 100ms = 150ms for retries
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("should not retry on contract error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Error(Contract, 1)"));
    
    await expect(retry(fn, { maxRetries: 3 })).rejects.toThrow("Error(Contract, 1)");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should not retry on user rejection error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("User rejected transaction"));
    
    await expect(retry(fn, { maxRetries: 3 })).rejects.toThrow("User rejected transaction");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should not retry on validation error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Invalid address"));
    
    await expect(retry(fn, { maxRetries: 3 })).rejects.toThrow("Invalid address");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should not retry on authentication error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Unauthorized"));
    
    await expect(retry(fn, { maxRetries: 3 })).rejects.toThrow("Unauthorized");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should throw after max retries exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
    
    await expect(retry(fn, { maxRetries: 2, initialDelayMs: 10 }))
      .rejects.toThrow("ETIMEDOUT");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("should log retry attempts when verbose", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValue("success");
    
    await retry(fn, { maxRetries: 2, initialDelayMs: 10, verbose: true });
    
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[retry]"),
      expect.stringContaining("ETIMEDOUT")
    );
    consoleWarnSpy.mockRestore();
  });

  it("should handle multiple transient failures before success", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("503 Service Unavailable"))
      .mockResolvedValue("success");
    
    const result = await retry(fn, { maxRetries: 4, initialDelayMs: 10 });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(4);
  });
});

describe("withRetry", () => {
  it("should create a retryable function", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValue("success");
    
    const retryableFn = withRetry(fn, { maxRetries: 2, initialDelayMs: 10 });
    const result = await retryableFn();
    
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should pass arguments to the wrapped function", async () => {
    const fn = vi.fn().mockResolvedValue("success");
    const retryableFn = withRetry(fn);
    
    await retryableFn("arg1", "arg2", 123);
    
    expect(fn).toHaveBeenCalledWith("arg1", "arg2", 123);
  });

  it("should preserve function return type", async () => {
    const fn = async (x: number) => x * 2;
    const retryableFn = withRetry(fn);
    
    const result = await retryableFn(5);
    expect(result).toBe(10);
  });
});
