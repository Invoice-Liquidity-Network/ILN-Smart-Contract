import { describe, expect, it } from 'vitest';
import { SlidingWindowRateLimiter } from '../src/delivery/rateLimiter';

describe('SlidingWindowRateLimiter', () => {
  it('allows up to max in a window', () => {
    let t = 0;
    const l = new SlidingWindowRateLimiter({ maxRequests: 3, windowMs: 1000, now: () => t });
    expect(l.tryConsume()).toBe(true);
    expect(l.tryConsume()).toBe(true);
    expect(l.tryConsume()).toBe(true);
    expect(l.tryConsume()).toBe(false);
    expect(l.remaining()).toBe(0);
  });

  it('frees capacity after window expires', () => {
    let t = 0;
    const l = new SlidingWindowRateLimiter({ maxRequests: 2, windowMs: 100, now: () => t });
    l.tryConsume();
    l.tryConsume();
    expect(l.tryConsume()).toBe(false);
    t += 101;
    expect(l.tryConsume()).toBe(true);
  });

  it('uses defaults of 1000 per hour', () => {
    const l = new SlidingWindowRateLimiter();
    for (let i = 0; i < 1000; i++) expect(l.tryConsume()).toBe(true);
    expect(l.tryConsume()).toBe(false);
  });
});
