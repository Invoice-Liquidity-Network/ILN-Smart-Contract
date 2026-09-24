/**
 * DeliveryAnalyticsService — tracks delivery success/failure rates per
 * subscriber and exposes metrics for alerting and operational visibility.
 *
 * Feeds into SubscriptionHealthService to trigger auto-suspension when
 * failure rates exceed configured thresholds (#874).
 */

export interface DeliveryRecord {
  subscriberId: string;
  eventType: string;
  success: boolean;
  statusCode?: number;
  error?: string;
  timestamp: number;
}

export interface SubscriberStats {
  subscriberId: string;
  totalAttempts: number;
  failures: number;
  successRate: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  recentFailureRate: number;
}

export interface AnalyticsConfig {
  /** Time window in milliseconds for computing recent failure rates. */
  recentWindowMs: number;
}

const DEFAULT_ANALYTICS_CONFIG: AnalyticsConfig = {
  recentWindowMs: 3600_000, // 1 hour
};

export class DeliveryAnalyticsService {
  private readonly records: DeliveryRecord[] = [];
  private readonly config: AnalyticsConfig;

  constructor(config?: Partial<AnalyticsConfig>) {
    this.config = { ...DEFAULT_ANALYTICS_CONFIG, ...config };
  }

  /** Record a delivery attempt (success or failure). */
  record(delivery: DeliveryRecord): void {
    this.records.push(delivery);
  }

  /** Get aggregate stats for a specific subscriber. */
  getStats(subscriberId: string): SubscriberStats {
    const all = this.records.filter((r) => r.subscriberId === subscriberId);
    const failures = all.filter((r) => !r.success);
    const successes = all.filter((r) => r.success);
    const now = Date.now();
    const recentCutoff = now - this.config.recentWindowMs;
    const recentFailures = failures.filter(
      (r) => r.timestamp >= recentCutoff,
    );

    return {
      subscriberId,
      totalAttempts: all.length,
      failures: failures.length,
      successRate: all.length > 0 ? successes.length / all.length : 1,
      lastFailureAt: failures.length > 0 ? failures[failures.length - 1].timestamp : null,
      lastSuccessAt: successes.length > 0 ? successes[successes.length - 1].timestamp : null,
      recentFailureRate: recentFailures.length / Math.max(all.filter((r) => r.timestamp >= recentCutoff).length, 1),
    };
  }

  /** Get stats for all tracked subscribers. */
  getAllStats(): SubscriberStats[] {
    const ids = [...new Set(this.records.map((r) => r.subscriberId))];
    return ids.map((id) => this.getStats(id));
  }

  /** Total records tracked. */
  get totalRecords(): number {
    return this.records.length;
  }

  /** Clear all tracked records. */
  reset(): void {
    this.records.length = 0;
  }
}
