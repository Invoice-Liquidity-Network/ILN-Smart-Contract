import { describe, expect, it } from 'vitest';
import {
  PerRecipientRateLimiter,
  SlidingWindowRateLimiter,
} from '../src/delivery/rateLimiter';

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

describe('PerRecipientRateLimiter', () => {
  it('keeps a separate budget per recipient key', () => {
    const l = new PerRecipientRateLimiter({ maxRequests: 2, windowMs: 1000, now: () => 0 });

    expect(l.tryConsume('recipient-a')).toBe(true);
    expect(l.tryConsume('recipient-a')).toBe(true);
    expect(l.tryConsume('recipient-a')).toBe(false);

    // A different recipient is unaffected by A exhausting its budget.
    expect(l.tryConsume('recipient-b')).toBe(true);
    expect(l.tryConsume('recipient-b')).toBe(true);
    expect(l.remaining('recipient-a')).toBe(0);
    expect(l.remaining('recipient-b')).toBe(0);
  });

  it('frees a recipient budget after its window expires', () => {
    let t = 0;
    const l = new PerRecipientRateLimiter({ maxRequests: 1, windowMs: 100, now: () => t });

    expect(l.tryConsume('a')).toBe(true);
    expect(l.tryConsume('a')).toBe(false);
    t += 101;
    expect(l.tryConsume('a')).toBe(true);
  });
});
