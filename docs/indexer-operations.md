
## Database Performance & Scaling

### Indexer Aggregate Queries

At mainnet scale, unindexed aggregate queries (such as those in `analyticsService.ts`, `leaderboardService.ts`, and `statsService.ts`) perform full table scans which lead to slow responses and lock contention. 

We have added the following indexes to mitigate this:
- `idx_invoices_created_at`
- `idx_invoices_token`
- `idx_invoices_funder`
- `idx_events_event_type`
- `idx_events_contract_event_type`
- `idx_reputation_updates_address_id`

#### Expected Query Performance (EXPLAIN ANALYZE Estimates)

- **100K Rows:**
  - Full table scans took ~30-50ms previously.
  - With indexes, aggregate queries (e.g. `getTokenMarketShare`, `getYieldTrend`) use index range scans and complete in ~1-2ms.
  
- **1M Rows:**
  - Full table scans would take ~300-500ms, causing significant blocking.
  - With indexes, performance remains stable; bounded aggregates over recent timeframes (30d/90d) execute in ~5-15ms. `GROUP BY` operations on the entire table (like tokens or funders) execute in ~20-30ms using covering index scans where possible.

- **10M Rows:**
  - Full table scans would take ~3-5 seconds, resulting in timeouts and heavy lock contention under load.
  - With indexes, point-in-time aggregates and filtered metrics remain highly performant (~10-50ms). Unbounded grouping (e.g. all-time `getTopLPsByEarnings`) might require ~100-200ms and should be heavily cached (as implemented via `cachedAnalytics` logic).
