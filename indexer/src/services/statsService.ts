import type Database from 'better-sqlite3';

export interface ProtocolStats {
  totalInvoices: number;
  totalFunded: number;
  totalPaid: number;
  totalCancelled: number;
  totalExpired: number;
  totalDisputed: number;
  volumeByToken: Record<string, string>;
  avgDiscountRateBps: number;
  disputeRate: number;
  lastUpdatedAt: number;
}

export interface StatsHistoryEntry {
  date: string;
  totalInvoices: number;
  totalFunded: number;
  totalPaid: number;
  totalVolume: string;
  avgDiscountRateBps: number;
}

interface CachedStats {
  stats: ProtocolStats;
  cachedAt: number;
}

let cachedStats: CachedStats | null = null;

export function clearStatsCache(): void {
  cachedStats = null;
}

export function getProtocolStats(
  db: Database.Database,
  cacheTtlMs: number = 60000
): ProtocolStats {
  const now = Date.now();

  if (cachedStats && now - cachedStats.cachedAt < cacheTtlMs) {
    return cachedStats.stats;
  }

  const counts = db
    .prepare(
      `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'Funded' OR status = 'Paid' OR status = 'Defaulted' THEN 1 ELSE 0 END) as funded,
        SUM(CASE WHEN status = 'Paid' THEN 1 ELSE 0 END) as paid,
        SUM(CASE WHEN status = 'Cancelled' THEN 1 ELSE 0 END) as cancelled,
        SUM(CASE WHEN status = 'Expired' THEN 1 ELSE 0 END) as expired,
        SUM(CASE WHEN status = 'Disputed' THEN 1 ELSE 0 END) as disputed,
        AVG(CAST(discount_rate AS REAL)) as avg_discount
      FROM invoices
    `
    )
    .get() as {
    total: number;
    funded: number;
    paid: number;
    cancelled: number;
    expired: number;
    disputed: number;
    avg_discount: number;
  };

  const tokenVolumes = db
    .prepare(
      `
      SELECT token, COALESCE(SUM(CAST(amount_paid AS INTEGER)), 0) as volume
      FROM invoices
      WHERE CAST(amount_paid AS INTEGER) > 0
      GROUP BY token
    `
    )
    .all() as Array<{ token: string; volume: number }>;

  const volumeByToken: Record<string, string> = {};
  for (const row of tokenVolumes) {
    volumeByToken[row.token] = String(row.volume);
  }

  const disputeRate = counts.total > 0 ? counts.disputed / counts.total : 0;

  const stats: ProtocolStats = {
    totalInvoices: counts.total || 0,
    totalFunded: counts.funded || 0,
    totalPaid: counts.paid || 0,
    totalCancelled: counts.cancelled || 0,
    totalExpired: counts.expired || 0,
    totalDisputed: counts.disputed || 0,
    volumeByToken,
    avgDiscountRateBps: Math.round(counts.avg_discount || 0),
    disputeRate: Math.round(disputeRate * 10000) / 10000,
    lastUpdatedAt: now,
  };

  cachedStats = { stats, cachedAt: now };
  return stats;
}

export function getStatsHistory(
  db: Database.Database,
  period: '30d' | '90d' | 'all' = '30d'
): StatsHistoryEntry[] {
  let dateFilter = '';
  if (period === '30d') {
    dateFilter = "WHERE date >= date('now', '-30 days')";
  } else if (period === '90d') {
    dateFilter = "WHERE date >= date('now', '-90 days')";
  }

  const rows = db
    .prepare(
      `
      SELECT
        date,
        total_invoices,
        total_funded,
        total_paid,
        total_volume,
        avg_discount_rate_bps
      FROM stats_history
      ${dateFilter}
      ORDER BY date ASC
    `
    )
    .all() as StatsHistoryEntry[];

  return rows;
}

export function refreshStats(db: Database.Database): ProtocolStats {
  cachedStats = null;
  return getProtocolStats(db);
}
