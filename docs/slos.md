# Service Level Objectives (SLOs)

Concrete, pre-agreed performance targets for the ILN indexer and notifications services. These SLOs remove subjective judgment from incident severity classification and are referenced directly in the [incident response runbook](incident-response-runbook.md) severity table and the [monitoring runbook](monitoring-runbook.md) alert thresholds.

---

## 1. Indexer SLOs

| SLO | Target | Measurement Window | Monitoring Signal | Breach Severity |
|-----|--------|-------------------|-------------------|-----------------|
| **Ingestion lag** | ≤ 50 ledgers behind chain tip | 5-minute rolling | `ingestion.lagLedgers` from `/health` ([monitoring-runbook.md §2](monitoring-runbook.md#2-recommended-external-monitoring)) | Critical when > `HEALTH_MAX_LAG_LEDGERS` for 5 min; Warning when > 25 for 5 min |
| **API p99 latency** | < 500 ms | 5-minute rolling | HTTP response time on `/health`, `/invoices`, `/events` endpoints (apdex or percentile from APM) | Warning when p99 > 500 ms for 5 min; Critical when p99 > 2 s for 5 min |
| **API p95 latency** | < 250 ms | 5-minute rolling | Same as above | Warning when p95 > 250 ms for 5 min |
| **API availability (uptime)** | ≥ 99.9% (excludes scheduled maintenance) | 30-day rolling error budget | Multi-region uptime probe on `/health` every 30–60 s ([monitoring-runbook.md §2](monitoring-runbook.md#2-recommended-external-monitoring)) | Critical when non-200 for 2+ consecutive probes |
| **Data accuracy (reconciliation)** | ≥ 99% of sampled invoices match on-chain state | Per reconciliation run (15 min default) | `indexer_drift_detected` alert from [reconciliation job](indexer-reconciliation.md) | Critical when drift > 1% of sampled invoices |
| **Backup success rate** | ≥ 99% of scheduled backup runs succeed | Daily | Backup failure notification via webhooks ([indexer-operations.md §2](indexer-operations.md#2-backup-procedure)) | Critical on any backup failure |
| **Restore RTO** | ≤ 30 minutes (restore + verification) | Quarterly drill | Manual timing during restore drill against staging ([indexer-operations.md §4](indexer-operations.md#4-rpo--rto-targets)) | Informational (drill finding) |
| **Restore RPO** | ≤ 1 hour for recent state | Per backup cycle | Hourly backup cron; newest archive always survives retention pruning | Informational |

### Indexer alert-to-SLO mapping

| Alert | SLO it protects | Reference |
|-------|-----------------|-----------|
| `/health` degraded > 5 min | API availability | [monitoring-runbook.md §2](monitoring-runbook.md#2-recommended-external-monitoring) |
| `ingestion.lagLedgers` > threshold | Ingestion lag | [monitoring-runbook.md §2](monitoring-runbook.md#2-recommended-external-monitoring) |
| HTTP 5xx > 5% for 5 min | API availability + p99 latency | [monitoring-runbook.md §2](monitoring-runbook.md#2-recommended-external-monitoring) |
| `indexer_drift_detected` | Data accuracy | [indexer-reconciliation.md](indexer-reconciliation.md) |
| Backup job failure | Backup success rate | [indexer-operations.md §2](indexer-operations.md#2-backup-procedure) |

---

## 2. Notifications SLOs

| SLO | Target | Measurement Window | Monitoring Signal | Breach Severity |
|-----|--------|-------------------|-------------------|-----------------|
| **Webhook delivery success rate** | > 99.9% (excluding open circuits) | 5-minute rolling | Webhook error rate from delivery logs ([notifications-operations.md §5](notifications-operations.md#5-monitoring-alerting--incident-response)) | Warning when error rate > 1% for 5 min; Critical when > 5% for 5 min |
| **P95 delivery latency** | < 150 ms | 5-minute rolling | Downstream latency percentiles from burst test baseline and live metrics | Warning when P95 > 300 ms for 5 min |
| **P99 delivery latency** | < 250 ms | 5-minute rolling | Same as above | Critical when P99 > 500 ms for 5 min |
| **Retry queue pending lag** | < 100 items pending | Continuous | `RetryQueue.getPending()` count from SQLite | Warning when backlog > 500 items |
| **Circuit breaker open state** | < 5% of active endpoints open | Continuous | Circuit breaker state across all registered endpoints | Critical when > 10 endpoints open simultaneously |
| **Email delivery success rate** | > 99.5% | 5-minute rolling | Email delivery logs + Resend API bounce rate | Warning when bounce rate > 2% for 15 min |
| **Notification service availability** | ≥ 99.9% | 30-day rolling error budget | Uptime probe on notifications `/health` endpoint | Critical when non-200 for 2+ consecutive probes |
| **HMAC verification failure rate** | < 0.1% of inbound webhooks | 5-minute rolling | HMAC signature verification failure count in logs | Warning when > 0.5% for 10 min (potential abuse) |

### Notifications alert-to-SLO mapping

| Alert | SLO it protects | Reference |
|-------|-----------------|-----------|
| `NotificationCircuitBreakerOpen` | Circuit breaker open state | [notifications-operations.md §5](notifications-operations.md#5-monitoring-alerting--incident-response) |
| `RetryQueueDepthHigh` | Retry queue pending lag | [notifications-operations.md §5](notifications-operations.md#5-monitoring-alerting--incident-response) |
| `RateLimitExceededSpike` | Webhook delivery success rate | [notifications-operations.md §5](notifications-operations.md#5-monitoring-alerting--incident-response) |
| HMAC verification failures spike | HMAC verification failure rate | [notifications-operations.md §3](notifications-operations.md#3-fault-tolerance--security-controls) |

---

## 3. Cross-Service SLOs

| SLO | Target | Measurement Window | Monitoring Signal | Breach Severity |
|-----|--------|-------------------|-------------------|-----------------|
| **End-to-end event processing latency** (chain event → notification delivered) | < 5 seconds p95 | 5-minute rolling | Correlation ID tracing from ingestion to delivery ([observability-standards.md](observability-standards.md)) | Warning when p95 > 5 s for 5 min |
| **Contract RPC reachability** | ≥ 99.9% | 30-day rolling | `contract_rpc` check from [check-contract-health.ts](../scripts/check-contract-health.ts) | Critical when RPC unreachable for > 1 min |
| **Full stack health** | All critical checks passing | Continuous | `check-contract-health.ts` exit code (0 = healthy) | Critical on any critical check failure |

---

## 4. Error budget policy

| SLO | Error budget (30-day) | Action when budget exhausted |
|-----|----------------------|------------------------------|
| API availability ≥ 99.9% | ≤ 43.2 min downtime | Freeze non-critical deploys; focus on reliability |
| Webhook delivery > 99.9% | ≤ 43.2 min failed deliveries | Halt feature work; dedicated delivery reliability sprint |
| Ingestion lag ≤ 50 ledgers | ≤ 43.2 min above threshold | Scale ingestion workers; review Horizon connection pool |

---

## 5. SLO review cadence

- **Monthly:** Review SLO compliance dashboards, error budget consumption, and alert noise ratio.
- **Quarterly:** Re-evaluate targets against actual traffic patterns and user expectations. Adjust thresholds if needed via a documented ADR.
- **Post-incident:** Any SLO breach that triggers a Severity 1 or 2 incident must be reviewed in the post-incident report ([postmortem-template.md](postmortem-template.md)) with a recommendation to tighten, maintain, or relax the target.

---

## 6. Relationship to launch checklist

These SLOs must be documented and their monitoring signals verified before mainnet sign-off on the **Monitoring configured** row of [mainnet-launch-checklist.md](mainnet-launch-checklist.md). The [alert-to-incident-channel integration test](../tests/e2e/alert-integration.test.ts) (Issue #779) validates that SLO-breach alerts actually reach the configured incident channel.
