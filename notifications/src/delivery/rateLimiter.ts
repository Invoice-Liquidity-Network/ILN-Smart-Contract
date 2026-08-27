export interface RateLimiterOptions {
  maxRequests?: number | undefined;
  windowMs?: number | undefined;
  now?: (() => number) | undefined;
}

const DEFAULT_MAX = 1000;
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

export class SlidingWindowRateLimiter {
  private readonly timestamps: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: RateLimiterOptions = {}) {
    this.maxRequests = opts.maxRequests ?? DEFAULT_MAX;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = opts.now ?? Date.now;
  }

  tryConsume(): boolean {
    this.prune();
    if (this.timestamps.length >= this.maxRequests) return false;
    this.timestamps.push(this.now());
    return true;
  }

  remaining(): number {
    this.prune();
    return Math.max(0, this.maxRequests - this.timestamps.length);
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.timestamps.length && this.timestamps[0]! <= cutoff) {
      this.timestamps.shift();
    }
  }
}

/**
 * A sliding-window rate limiter keyed by recipient (webhook URL, email
 * address, Slack channel, ...) so one high-volume destination can never
 * starve delivery to everyone else (Issue #728). Each key gets its own
 * bucket with the same window policy; buckets are created lazily and held
 * for the lifetime of the limiter.
 */
export class PerRecipientRateLimiter {
  private readonly buckets = new Map<string, SlidingWindowRateLimiter>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: RateLimiterOptions = {}) {
    this.maxRequests = opts.maxRequests ?? DEFAULT_MAX;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Attempt to consume one slot for the given recipient key.
   *
   * @returns true if the request is allowed, false when this recipient has
   * exhausted its own window budget (other recipients are unaffected).
   */
  tryConsume(key: string): boolean {
    return this.bucketFor(key).tryConsume();
  }

  /** Remaining budget for a recipient within the current window. */
  remaining(key: string): number {
    return this.bucketFor(key).remaining();
  }

  private bucketFor(key: string): SlidingWindowRateLimiter {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new SlidingWindowRateLimiter({
        maxRequests: this.maxRequests,
        windowMs: this.windowMs,
        now: this.now,
      });
      this.buckets.set(key, bucket);
    }
    return bucket;
  }
}
