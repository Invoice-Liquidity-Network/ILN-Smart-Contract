import { describe, it, expect } from 'vitest';
import {
  detectAnomalies,
  type EventVolumeBucket,
  type AnomalyConfig,
} from '../src/services/anomalyDetectionService.js';

function makeConfig(overrides: Partial<AnomalyConfig> = {}): AnomalyConfig {
  return {
    trailingWindowHours: 24,
    alertThresholdStdDevs: 2.0,
    minimumSampleSize: 6,
    ...overrides,
  };
}

function makeBuckets(
  eventType: string,
  counts: number[],
  startHourOffset = 0
): EventVolumeBucket[] {
  return counts.map((count, i) => ({
    eventType,
    hour: `2026-01-01T${String(startHourOffset + i).padStart(2, '0')}:00:00Z`,
    count,
  }));
}

describe('detectAnomalies', () => {
  it('returns normal when all values are within bounds', () => {
    const buckets = [
      ...makeBuckets('InvoiceSubmitted', [10, 12, 8, 11, 9, 10, 11]),
      ...makeBuckets('InvoiceFunded', [5, 6, 4, 5, 6, 5, 5]),
      ...makeBuckets('InvoicePaid', [3, 4, 3, 3, 4, 3, 3]),
      ...makeBuckets('InvoiceDisputed', [1, 0, 1, 0, 1, 0, 1]),
      ...makeBuckets('InvoiceCancelled', [2, 1, 2, 1, 2, 1, 2]),
      ...makeBuckets('InvoiceExpired', [0, 1, 0, 1, 0, 1, 0]),
    ];
    const results = detectAnomalies(buckets, makeConfig());
    const submitted = results.find((r) => r.eventType === 'InvoiceSubmitted');
    expect(submitted?.isAnomaly).toBe(false);
    expect(submitted?.direction).toBe('normal');
  });

  it('detects a spike when latest value exceeds upper bound', () => {
    const buckets = [
      ...makeBuckets('InvoiceSubmitted', [1, 1, 1, 1, 1, 1, 20]),
    ];
    const results = detectAnomalies(buckets, makeConfig());
    const submitted = results.find((r) => r.eventType === 'InvoiceSubmitted');
    expect(submitted?.isAnomaly).toBe(true);
    expect(submitted?.direction).toBe('spike');
    expect(submitted?.currentHourCount).toBe(20);
    expect(submitted?.trailingMean).toBe(1);
  });

  it('detects a drop when latest value falls below lower bound', () => {
    const buckets = [
      ...makeBuckets('InvoiceFunded', [10, 12, 11, 10, 13, 12, 0]),
    ];
    const results = detectAnomalies(buckets, makeConfig());
    const funded = results.find((r) => r.eventType === 'InvoiceFunded');
    expect(funded?.isAnomaly).toBe(true);
    expect(funded?.direction).toBe('drop');
    expect(funded?.currentHourCount).toBe(0);
  });

  it('requires minimum sample size before flagging', () => {
    const buckets = makeBuckets('InvoiceSubmitted', [100, 100]);
    const results = detectAnomalies(buckets, makeConfig({ minimumSampleSize: 6 }));
    const submitted = results.find((r) => r.eventType === 'InvoiceSubmitted');
    expect(submitted?.isAnomaly).toBe(false);
    expect(submitted?.trailingMean).toBe(0);
  });

  it('ignores event types not in monitored list', () => {
    const buckets: EventVolumeBucket[] = [
      { eventType: 'ReputationUpdated', hour: '2026-01-01T00:00:00Z', count: 500 },
    ];
    const results = detectAnomalies(buckets, makeConfig());
    expect(results.find((r) => r.eventType === 'ReputationUpdated')).toBeUndefined();
  });

  it('computes correct mean and std dev', () => {
    const buckets = makeBuckets('InvoicePaid', [10, 10, 10, 10, 10, 10, 10]);
    const results = detectAnomalies(buckets, makeConfig());
    const paid = results.find((r) => r.eventType === 'InvoicePaid');
    expect(paid?.trailingMean).toBe(10);
    expect(paid?.trailingStdDev).toBe(0);
    expect(paid?.upperBound).toBe(10);
    expect(paid?.lowerBound).toBe(10);
    expect(paid?.isAnomaly).toBe(false);
  });

  it('does not flag as drop when all historical values are zero', () => {
    const buckets = makeBuckets('InvoiceExpired', [0, 0, 0, 0, 0, 0, 0]);
    const results = detectAnomalies(buckets, makeConfig());
    const expired = results.find((r) => r.eventType === 'InvoiceExpired');
    expect(expired?.isAnomaly).toBe(false);
  });

  it('respects configurable threshold', () => {
    const strictConfig = makeConfig({ alertThresholdStdDevs: 0.5 });
    const buckets = makeBuckets('InvoiceSubmitted', [5, 6, 5, 6, 5, 6, 8]);
    const results = detectAnomalies(buckets, strictConfig);
    const submitted = results.find((r) => r.eventType === 'InvoiceSubmitted');
    expect(submitted?.isAnomaly).toBe(true);
    expect(submitted?.direction).toBe('spike');
  });

  it('includes all monitored event types in results', () => {
    const results = detectAnomalies([], makeConfig());
    const types = results.map((r) => r.eventType);
    expect(types).toContain('InvoiceSubmitted');
    expect(types).toContain('InvoiceFunded');
    expect(types).toContain('InvoicePaid');
    expect(types).toContain('InvoiceDisputed');
    expect(types).toContain('InvoiceCancelled');
    expect(types).toContain('InvoiceExpired');
    expect(types).toHaveLength(6);
  });
});
