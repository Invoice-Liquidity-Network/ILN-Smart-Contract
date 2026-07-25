import type Database from 'better-sqlite3';

export interface DailyYield {
  date: string;
  averageEffectiveYield: number;
}

export interface DailyDisputeRate {
  week: string;
  disputeRate: number;
  disputedInvoices: number;
  totalInvoices: number;
}

export interface TokenShare {
  token: string;
  volume: string;
  share: number;
}

export interface LPEarning {
  lp: string;
  earnings: string;
  fundedVolume: string;
  settledVolume: string;
}

export interface AnalyticsSnapshot {
  yieldTrend30d: DailyYield[];
  yieldTrend90d: DailyYield[];
  disputeRateTrend30d: DailyDisputeRate[];
  disputeRateTrend90d: DailyDisputeRate[];
  tokenMarketShare: TokenShare[];
  topLPsByEarnings: LPEarning[];
  lastUpdatedAt: number;
}

interface CacheSignature {
  invoiceCount: number;
  invoiceMaxCreatedAt: number;
  eventCount: number;
  eventMaxTimestamp: number;
}

interface CachedAnalytics {
  signature: CacheSignature;
  snapshot: AnalyticsSnapshot;
}

let cachedAnalytics: CachedAnalytics | null = null;

export function getYieldTrend(
  db: Database.Database,
  days: 30 | 90
): DailyYield[] {
  const sinceUnix = getSinceUnix(days);
  const rows = db
    .prepare(
      `
      SELECT
        date(datetime(e.timestamp, 'unixepoch')) AS date,
        AVG(
          CASE
            WHEN CAST(i.amount_funded AS REAL) > 0 AND CAST(i.amount_paid AS REAL) > 0
              THEN ((CAST(i.amount_paid AS REAL) - CAST(i.amount_funded AS REAL)) / CAST(i.amount_funded AS REAL)) * 100.0
            ELSE NULL
          END
        ) AS average_effective_yield
      FROM events e
      INNER JOIN invoices i ON i.id = e.invoice_id
      WHERE (
        e.contract_event_type = 'InvoicePaid'
        OR e.event_type = 'InvoicePaid'
        OR lower(e.event_type) = 'paid'
      )
      AND e.timestamp >= ?
      AND CAST(i.amount_funded AS REAL) > 0
      AND CAST(i.amount_paid AS REAL) > 0
      GROUP BY date(datetime(e.timestamp, 'unixepoch'))
      ORDER BY date ASC
    `
    )
    .all(sinceUnix) as Array<{
    date: string;
    average_effective_yield: number | null;
  }>;

  return rows.map((row) => ({
    date: row.date,
    averageEffectiveYield: roundMetric(row.average_effective_yield ?? 0),
  }));
}

export function getDisputeRateTrend(
  db: Database.Database,
  days: 30 | 90
): DailyDisputeRate[] {
  const sinceUnix = getSinceUnix(days);
  const rows = db
    .prepare(
      `
      SELECT
        strftime('%Y-%W', datetime(i.created_at, 'unixepoch')) AS week,
        COUNT(*) AS total_invoices,
        SUM(CASE WHEN i.status = 'Disputed' THEN 1 ELSE 0 END) AS disputed_invoices
      FROM invoices i
      WHERE i.created_at >= ?
      GROUP BY strftime('%Y-%W', datetime(i.created_at, 'unixepoch'))
      ORDER BY week ASC
    `
    )
    .all(sinceUnix) as Array<{
    week: string;
    total_invoices: number;
    disputed_invoices: number;
  }>;

  return rows.map((row) => ({
    week: row.week,
    disputeRate: row.total_invoices > 0 ? roundMetric(row.disputed_invoices / row.total_invoices) : 0,
    disputedInvoices: row.disputed_invoices,
    totalInvoices: row.total_invoices,
  }));
}

export function getTokenMarketShare(db: Database.Database): TokenShare[] {
  const rows = db
    .prepare(
      `
      SELECT token, COALESCE(SUM(CAST(amount_paid AS INTEGER)), 0) AS volume
      FROM invoices
      WHERE CAST(amount_paid AS INTEGER) > 0
      GROUP BY token
      ORDER BY volume DESC, token ASC
    `
    )
    .all() as Array<{ token: string; volume: number | string }>;

  const totalVolume = rows.reduce((sum, row) => sum + BigInt(row.volume), 0n);

  return rows.map((row) => {
    const volume = BigInt(row.volume);
    return {
      token: row.token,
      volume: volume.toString(),
      share: totalVolume > 0n ? roundMetric(Number((volume * 1_000_000n) / totalVolume) / 1_000_000) : 0,
    };
  });
}

export function getTopLPsByEarnings(
  db: Database.Database,
  limit: number
): LPEarning[] {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 10;
  const rows = db
    .prepare(
      `
      SELECT
        funder AS lp,
        COALESCE(SUM(CAST(amount_funded AS INTEGER)), 0) AS funded_volume,
        COALESCE(SUM(CAST(amount_paid AS INTEGER)), 0) AS settled_volume
      FROM invoices
      WHERE funder IS NOT NULL
        AND funder != ''
        AND status = 'Paid'
        AND CAST(amount_funded AS INTEGER) > 0
      GROUP BY funder
      ORDER BY (COALESCE(SUM(CAST(amount_paid AS INTEGER)), 0) - COALESCE(SUM(CAST(amount_funded AS INTEGER)), 0)) DESC,
               COALESCE(SUM(CAST(amount_paid AS INTEGER)), 0) DESC,
               funder ASC
      LIMIT ?
    `
    )
    .all(normalizedLimit) as Array<{
    lp: string;
    funded_volume: number | string;
    settled_volume: number | string;
  }>;

  return rows.map((row) => {
    const fundedVolume = BigInt(row.funded_volume);
    const settledVolume = BigInt(row.settled_volume);
    return {
      lp: row.lp,
      earnings: (settledVolume - fundedVolume).toString(),
      fundedVolume: fundedVolume.toString(),
      settledVolume: settledVolume.toString(),
    };
  });
}

export function getAnalyticsSnapshot(
  db: Database.Database,
  topLpsLimit: number = 10
): AnalyticsSnapshot {
  const signature = getCacheSignature(db);

  if (cachedAnalytics && signaturesMatch(cachedAnalytics.signature, signature)) {
    return cachedAnalytics.snapshot;
  }

  const snapshot: AnalyticsSnapshot = {
    yieldTrend30d: getYieldTrend(db, 30),
    yieldTrend90d: getYieldTrend(db, 90),
    disputeRateTrend30d: getDisputeRateTrend(db, 30),
    disputeRateTrend90d: getDisputeRateTrend(db, 90),
    tokenMarketShare: getTokenMarketShare(db),
    topLPsByEarnings: getTopLPsByEarnings(db, topLpsLimit),
    lastUpdatedAt: Date.now(),
  };

  cachedAnalytics = {
    signature,
    snapshot,
  };

  return snapshot;
}

export function refreshAnalyticsSnapshot(
  db: Database.Database,
  topLpsLimit: number = 10
): AnalyticsSnapshot {
  cachedAnalytics = null;
  return getAnalyticsSnapshot(db, topLpsLimit);
}

export function clearAnalyticsCache(): void {
  cachedAnalytics = null;
}

function getCacheSignature(db: Database.Database): CacheSignature {
  const invoiceState = db
    .prepare(
      `
      SELECT
        COUNT(*) AS invoice_count,
        COALESCE(MAX(created_at), 0) AS invoice_max_created_at
      FROM invoices
    `
    )
    .get() as { invoice_count: number; invoice_max_created_at: number };

  const eventState = db
    .prepare(
      `
      SELECT
        COUNT(*) AS event_count,
        COALESCE(MAX(timestamp), 0) AS event_max_timestamp
      FROM events
      WHERE contract_event_type IN ('InvoiceFunded', 'InvoicePaid', 'InvoiceDisputed')
         OR event_type IN ('InvoiceFunded', 'InvoicePaid', 'InvoiceDisputed')
         OR lower(event_type) IN ('funded', 'paid', 'disputed')
    `
    )
    .get() as { event_count: number; event_max_timestamp: number };

  return {
    invoiceCount: invoiceState.invoice_count,
    invoiceMaxCreatedAt: invoiceState.invoice_max_created_at,
    eventCount: eventState.event_count,
    eventMaxTimestamp: eventState.event_max_timestamp,
  };
}

function signaturesMatch(left: CacheSignature, right: CacheSignature): boolean {
  return (
    left.invoiceCount === right.invoiceCount &&
    left.invoiceMaxCreatedAt === right.invoiceMaxCreatedAt &&
    left.eventCount === right.eventCount &&
    left.eventMaxTimestamp === right.eventMaxTimestamp
  );
}

function getSinceUnix(days: 30 | 90): number {
  return Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
