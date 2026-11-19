import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../src/delivery/circuitBreaker';

function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => (t += ms),
  };
}

describe('CircuitBreaker', () => {
  it('starts closed and stays closed under threshold failures', () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 1000, now: clock.now });
    for (let i = 0; i < 4; i++) cb.recordFailure();
    expect(cb.getState()).toBe('closed');
    expect(cb.canAttempt()).toBe(true);
  });

  it('opens after threshold consecutive failures', () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 1000, now: clock.now });
    for (let i = 0; i < 5; i++) cb.recordFailure();
    expect(cb.getState()).toBe('open');
    expect(cb.canAttempt()).toBe(false);
  });

  it('transitions to half-open after cooldown and allows one probe', () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 500, now: clock.now });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    clock.advance(500);
    expect(cb.getState()).toBe('half-open');
    expect(cb.canAttempt()).toBe(true);
    expect(cb.canAttempt()).toBe(false);
  });

  it('closes after a successful probe', () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100, now: clock.now });
    cb.recordFailure();
    cb.recordFailure();
    clock.advance(100);
    cb.canAttempt();
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
    expect(cb.snapshot().consecutiveFailures).toBe(0);
  });

  it('reopens on probe failure', () => {
    const clock = fakeClock();
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100, now: clock.now });
    cb.recordFailure();
    cb.recordFailure();
    clock.advance(100);
    cb.canAttempt();
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
  });

  it('emits a log when opening', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    const logs: string[] = [];
    cb.recordFailure((m) => logs.push(m));
    expect(logs.some((l) => l.startsWith('circuit_breaker_open'))).toBe(true);
  });
});
