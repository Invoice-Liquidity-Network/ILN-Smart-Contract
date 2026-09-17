export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  dbPath: process.env.DB_PATH || './indexer.db',
  cacheTtlMs: parseInt(process.env.CACHE_TTL_MS || '60000', 10),
  maxLeaderboardLimit: 100,
  defaultLeaderboardLimit: 50,
  apiKeys: parseCsv(process.env.API_KEYS),
  horizonUrl: process.env.HORIZON_URL || 'http://localhost:8000',
  contractId: process.env.ILN_CONTRACT_ID || process.env.CONTRACT_ID || '',
};

function parseCsv(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
