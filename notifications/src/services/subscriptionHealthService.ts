/**
 * SubscriptionHealthService — monitors subscriber delivery health and
 * auto-suspends subscriptions whose failure rates exceed a configurable
 * threshold.
 *
 * Works with DeliveryAnalyticsService to read failure metrics and
 * produces suspension events that downstream code can use to disable
 * webhook delivery or notify operators (#874).
 */

import type { DeliveryAnalyticsService } from "./deliveryAnalyticsService.js";

export interface HealthConfig {
  /** Failure rate (0-1) above which a subscriber is auto-suspended. */
  failureThreshold: number;
  /** Minimum number of delivery attempts before the threshold applies. */
  minAttempts: number;
  /** How often (ms) to re-evaluate subscriber health. */
  checkIntervalMs: number;
}

export type SuspensionReason =
  | "high_failure_rate"
  | "manual"
  | "operator_override";

export interface SuspensionEvent {
  subscriberId: string;
  reason: SuspensionReason;
  suspendedAt: number;
  stats: {
    totalAttempts: number;
    failures: number;
    successRate: number;
  };
}

export type SuspensionHandler = (event: SuspensionEvent) => void | Promise<void>;

const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  failureThreshold: 0.5,
  minAttempts: 10,
  checkIntervalMs: 60_000,
};

export class SubscriptionHealthService {
  private readonly suspended = new Map<string, SuspensionEvent>();
  private readonly config: HealthConfig;
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly analytics: DeliveryAnalyticsService,
    private readonly onSuspend: SuspensionHandler,
    config?: Partial<HealthConfig>,
  ) {
    this.config = { ...DEFAULT_HEALTH_CONFIG, ...config };
  }

  /** Start periodic health checks. */
  start(): void {
    if (this.checkTimer) return;
    this.checkTimer = setInterval(() => {
      this.evaluateAll();
    }, this.config.checkIntervalMs);
  }

  /** Stop periodic health checks. */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * Manually suspend a subscriber (e.g. operator action).
   * Returns the suspension event.
   */
  suspend(subscriberId: string, reason: SuspensionReason = "manual"): SuspensionEvent {
    const stats = this.analytics.getStats(subscriberId);
    const event: SuspensionEvent = {
      subscriberId,
      reason,
      suspendedAt: Date.now(),
      stats: {
        totalAttempts: stats.totalAttempts,
        failures: stats.failures,
        successRate: stats.successRate,
      },
    };
    this.suspended.set(subscriberId, event);
    return event;
  }

  /**
   * Manually re-enable a suspended subscriber (operator override).
   * Returns true if the subscriber was previously suspended.
   */
  reinstate(subscriberId: string): boolean {
    return this.suspended.delete(subscriberId);
  }

  /** Check if a subscriber is currently suspended. */
  isSuspended(subscriberId: string): boolean {
    return this.suspended.has(subscriberId);
  }

  /** Get all currently suspended subscribers. */
  getSuspended(): SuspensionEvent[] {
    return [...this.suspended.values()];
  }

  /** Evaluate all tracked subscribers and suspend those exceeding the threshold. */
  evaluateAll(): void {
    const stats = this.analytics.getAllStats();
    for (const stat of stats) {
      if (this.suspended.has(stat.subscriberId)) continue;
      if (stat.totalAttempts < this.config.minAttempts) continue;
      if (stat.recentFailureRate >= this.config.failureThreshold) {
        this.suspend(stat.subscriberId, "high_failure_rate");
        void this.onSuspend(this.suspended.get(stat.subscriberId)!);
      }
    }
  }
}
