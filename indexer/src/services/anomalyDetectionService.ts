import type Database from 'better-sqlite3';

export interface AnomalyConfig {
  trailingWindowHours: number;
  alertThresholdStdDevs: number;
  minimumSampleSize: number;
}

const DEFAULT_CONFIG: AnomalyConfig = {
  trailingWindowHours: 24,
  alertThresholdStdDevs: 2.0,
  minimumSampleSize: 6,
};

export interface EventVolumeBucket {
  eventType: string;
  hour: string;
  count: number;
}

export interface AnomalyResult {
  eventType: string;
  currentHourCount: number;
  trailingMean: number;
  trailingStdDev: number;
  upperBound: number;
  lowerBound: number;
  isAnomaly: boolean;
  direction: 'spike' | 'drop' | 'normal';
}

const MONITORED_EVENT_TYPES = [
  'InvoiceSubmitted',
  'InvoiceFunded',
  'InvoicePaid',
  'InvoiceDisputed',
  'InvoiceCancelled',
  'InvoiceExpired',
];

export function getEventVolumesByHour(
  db: Database.Database,
  hoursBack: number
): EventVolumeBucket[] {
  const sinceUnix = Math.floor(Date.now() / 1000) - hoursBack * 3600;
  const rows = db
    .prepare(
      `
      SELECT
        contract_event_type AS event_type,
        strftime('%Y-%m-%dT%H:00:00Z', datetime(timestamp, 'unixepoch')) AS hour,
        COUNT(*) AS count
      FROM events
      WHERE timestamp >= ?
        AND (
          contract_event_type IN ('InvoiceSubmitted', 'InvoiceFunded', 'InvoicePaid',
                                  'InvoiceDisputed', 'InvoiceCancelled', 'InvoiceExpired')
          OR event_type IN ('InvoiceSubmitted', 'InvoiceFunded', 'InvoicePaid',
                            'InvoiceDisputed', 'InvoiceCancelled', 'InvoiceExpired')
        )
      GROUP BY contract_event_type, hour
      ORDER BY event_type, hour ASC
    `
    )
    .all(sinceUnix) as Array<{
    event_type: string;
    hour: string;
    count: number;
  }>;

  return rows.map((row) => ({
    eventType: row.event_type,
    hour: row.hour,
    count: row.count,
  }));
}

export function detectAnomalies(
  buckets: EventVolumeBucket[],
  config: AnomalyConfig = DEFAULT_CONFIG
): AnomalyResult[] {
  const results: AnomalyResult[] = [];

  const grouped = new Map<string, number[]>();
  for (const bucket of buckets) {
    if (!MONITORED_EVENT_TYPES.includes(bucket.eventType)) continue;
    const existing = grouped.get(bucket.eventType);
    if (existing) {
      existing.push(bucket.count);
    } else {
      grouped.set(bucket.eventType, [bucket.count]);
    }
  }

  for (const eventType of MONITORED_EVENT_TYPES) {
    const counts = grouped.get(eventType) ?? [];
    let latestCount = 0;
    if (counts.length > 0) {
      latestCount = counts[counts.length - 1]!;
    }
    const historical = counts.slice(0, -1);

    if (historical.length < config.minimumSampleSize) {
      results.push({
        eventType,
        currentHourCount: latestCount,
        trailingMean: 0,
        trailingStdDev: 0,
        upperBound: 0,
        lowerBound: 0,
        isAnomaly: false,
        direction: 'normal',
      });
      continue;
    }

    const mean = historical.reduce((s, v) => s + v, 0) / historical.length;
    const variance =
      historical.reduce((s, v) => s + (v - mean) ** 2, 0) / historical.length;
    const stdDev = Math.sqrt(variance);

    const upperBound = mean + config.alertThresholdStdDevs * stdDev;
    const lowerBound = Math.max(0, mean - config.alertThresholdStdDevs * stdDev);

    let direction: 'spike' | 'drop' | 'normal' = 'normal';
    let isAnomaly = false;

    if (latestCount > upperBound) {
      isAnomaly = true;
      direction = 'spike';
    } else if (latestCount < lowerBound && historical.some((c) => c > 0)) {
      isAnomaly = true;
      direction = 'drop';
    }

    results.push({
      eventType,
      currentHourCount: latestCount,
      trailingMean: round6(mean),
      trailingStdDev: round6(stdDev),
      upperBound: round6(upperBound),
      lowerBound: round6(lowerBound),
      isAnomaly,
      direction,
    });
  }

  return results;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
