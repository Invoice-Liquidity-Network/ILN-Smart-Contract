# Storage Layout Optimization Analysis for Invoice Liquidity Contract

**Date:** 2026-07-26
**Status:** Phase 1 (hot/cold split) implemented; Phases 2-3 not implemented. See "Layout audit" below for what is verified against the code.

---

## Layout audit (verified against the code)

Audited against `src/invoice.rs`, `src/storage.rs`, `src/constants.rs`. Regression
test: `tests/storage_layout_audit.rs` (keeps this section and the code in sync).

**Storage version: 3** (`constants::CURRENT_STORAGE_VERSION`). `migrate()` only
backfills bootstrap token decimals for v3; it does **not** copy legacy `Invoice(id)`
records into the split format.

| Field | Tier | Stored in |
|-------|------|-----------|
| `id` | hot | `InvoiceCore(id)` |
| `freelancer` | hot | `InvoiceCore(id)` |
| `payer` | hot | `InvoiceCore(id)` |
| `token` | hot | `InvoiceCore(id)` |
| `amount` | hot | `InvoiceCore(id)` |
| `due_date` | hot | `InvoiceCore(id)` |
| `discount_rate` | hot | `InvoiceCore(id)` |
| `status` | hot | `InvoiceCore(id)` |
| `amount_funded` | hot | `InvoiceCore(id)` |
| `amount_paid` | hot | `InvoiceCore(id)` |
| `funder` | cold | `InvoiceMetadata(id)` |
| `funded_at` | cold | `InvoiceMetadata(id)` |
| `referral_code` | cold | `InvoiceMetadata(id)` |
| `submitter_reputation` | cold | `InvoiceMetadata(id)` |

Verified findings:

1. **Split matches Section 4.1.** `Invoice` = `InvoiceCore` + `InvoiceMetadata`, with no
   field in both and none missing.
2. **Writes use only the split keys.** `save_invoice` writes `InvoiceCore` and
   `InvoiceMetadata` and never the legacy `Invoice(id)` key. Section 7's "new saves use
   both keys / old keys remain" refers to core+metadata, not the legacy key. Reads
   fall back to a legacy `Invoice(id)` record when the split pair is absent, so
   pre-split invoices still load.
3. **Rollback is not free.** Because new invoices have no legacy copy, rolling the WASM
   back to a pre-split build cannot read them. `rehearse_rollback()` reports this
   (`orphaned_count`, `rollback_safe`); run it before any downgrade. Section 7's
   "Risk level: Low" holds for upgrade, not for downgrade.
4. **Section 1.1 TTL column was wrong.** Persistent and instance entries are *not*
   permanent or ~100 years: invoice records are extended to 2,000,000 ledgers on
   write (about 115 days at 5 s/ledger) and archive afterwards if untouched. See
   `docs/storage-ttl-audit.md`.
5. **Section 4.2 (field reordering) has no storage effect.** `#[contracttype]` structs
   are stored as maps keyed by field name, so declaration order does not change the
   serialized layout or padding. Treat Phase 2 as not applicable.
6. **Gas percentages are estimates**, not measurements. Measured numbers live in
   `BENCHMARKS.md` / `docs/benchmarks.json`.

Residual risks (not changed): the funder list (`InvoiceFunders`) is outside the split
and has no TTL extension (`docs/storage-ttl-audit.md` F1); the Section 3.3 reputation
key consolidation was not audited here.

---

## Executive Summary

This document analyzes the invoice_liquidity contract's storage patterns and proposes optimizations to reduce gas costs. The main findings indicate opportunities for:

1. **Struct field reordering** (~5-10% savings) - Align frequently-accessed fields
2. **Hot/Cold data separation** (~15-20% savings) - Split Invoice into core + metadata
3. **Storage key consolidation** (~10% savings) - Combine related small reads
4. **Type size optimization** (~5% savings) - Use smaller types where possible

**Estimated total gas savings: 20-35% on hot paths** (submit_invoice, fund_invoice, mark_paid)

---

## 1. Current Storage Architecture

### 1.1 Storage Tiers in Soroban

| Tier | Cost | TTL | Use Case |
|------|------|-----|----------|
| **Instance** | 1x | Finite (must be extended; see audit item 4) | Contract state, config, counters |
| **Persistent** | 1.5x | Finite per entry (invoices extended to 2M ledgers on write) | Invoices, scores, queues, stats |
| **Temporary** | 0.1x | ~1 month | Rarely used, not relevant here |

**Key insight:** Persistent storage has 50% overhead vs instance. Minimize reads/writes here.

### 1.2 Storage Operation Costs

| Operation | Cost | Notes |
|-----------|------|-------|
| Read entry | 1 unit | Fetch data by key |
| Write entry | 1 unit | Store data by key |
| Extend TTL | 0.5 units | Refresh expiry time |
| Update field | ~1.5-2 units | Full RMW cycle |

**Key insight:** Update cost is 50% higher than write cost because Soroban must read-modify-write.

---

## 2. Hot Path Analysis

### 2.1 Submit Invoice (HIGH FREQUENCY)

```
Access Pattern:
  1. READ: Config (token validation, decay params)
  2. READ: PayerScore (freelancer reputation)
  3. WRITE: Invoice
  4. WRITE: SubmitterInvoices index
  5. WRITE: TotalInvoices counter
  6. WRITE: Reputation profile
  7. WRITE: ReferralCount (if present)

Total Persistent Reads: 1
Total Persistent Writes: 4-5
Estimated Cost: 5-6 units
```

**Bottleneck:** RMW pattern for stats. StatsAccumulator mitigates this.

### 2.2 Fund Invoice (HIGHEST FREQUENCY - Critical Path)

```
Access Pattern:
  1. READ: Invoice *** CRITICAL
  2. READ: QueueResolution (if exists)
  3. READ: Config (oracle check)
  4. READ: PayerScore (reputation check)
  5. READ: InvoiceFunders *** CRITICAL
  6. READ: LpScore
  7. WRITE: Invoice *** CRITICAL
  8. WRITE: InvoiceFunders *** CRITICAL
  9. WRITE: LpScore
  10. WRITE: LpInvoices index
  11. WRITE: TotalFunded counter
  12. WRITE: TokenVolume

Total Persistent Operations: 12 (5 reads, 7 writes)
Estimated Cost: 14-16 units
```

**Bottlenecks:**
- Invoice is read AND written (full RMW)
- InvoiceFunders is read AND written
- Multiple independent reads

### 2.3 Mark Paid (HIGH FREQUENCY)

```
Access Pattern:
  1. READ: Invoice *** CRITICAL
  2. READ: InvoiceFunders *** CRITICAL
  3. READ: AdminAddress
  4. WRITE: Invoice *** CRITICAL
  5. WRITE: PayerScore
  6. WRITE: TotalPaid counter
  7. WRITE: Reputation profiles

Total Persistent Operations: 10+
Estimated Cost: 12-14 units
```

**Bottlenecks:** Invoice RMW cycle, InvoiceFunders read, multiple reputation writes.

---

## 3. Storage Layout Issues

### 3.1 Invoice Struct Analysis

**Current Invoice fields (hot vs cold classification):**

```rust
pub struct Invoice {
    pub id: u64,                              // HOT — key in every operation
    pub freelancer: Address,                  // HOT — accessed frequently
    pub payer: Address,                       // HOT — accessed frequently
    pub token: Address,                       // HOT — token checks
    pub amount: i128,                         // HOT — financial ops
    pub due_date: u32,                        // HOT — expiry checks
    pub discount_rate: u32,                   // HOT — payout calculations
    pub status: InvoiceStatus,                // HOT — checked in every operation
    pub funder: Option<Address>,              // COLD — only on full funding
    pub funded_at: Option<u32>,               // COLD — metadata only
    pub amount_funded: i128,                  // HOT — financial tracking
    pub amount_paid: i128,                    // HOT — settlement tracking
    pub referral_code: ReferralCode,          // COLD — at submission only
    pub submitter_reputation: u32,            // COLD — at submission only
}
```

**Problem:** Cold fields (60+ bytes) mixed with hot fields → full deserialization required.

---

## 4. Optimization Strategies

### 4.1 Strategy 1: Hot/Cold Data Separation (RECOMMENDED - Phase 1)

**Goal:** Split Invoice to only deserialize hot data on frequent operations.

**Implementation:**

```rust
// Hot data — accessed in 95%+ of invoice operations
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceCore {
    pub id: u64,
    pub freelancer: Address,
    pub payer: Address,
    pub token: Address,
    pub amount: i128,
    pub amount_funded: i128,
    pub amount_paid: i128,
    pub status: InvoiceStatus,
    pub due_date: u32,
    pub discount_rate: u32,
}

// Cold data — accessed rarely
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceMetadata {
    pub funder: Option<Address>,
    pub funded_at: Option<u32>,
    pub referral_code: ReferralCode,
    pub submitter_reputation: u32,
}

// Storage keys:
InvoiceCore(u64),
InvoiceMetadata(u64),
```

**Benefits:**
- Smaller deserialization: ~60 byte reduction per hot path
- Only load metadata when needed (appeals, disputes)
- Gas savings: 10-15% on fund_invoice and mark_paid

**Backwards compatibility:** Load both, present unified Invoice type to callers.

---

### 4.2 Strategy 2: Field Reordering (Phase 2 - Optional)

**Goal:** Order fields to minimize padding and group by access pattern.

**Optimized order (within InvoiceCore):**

```rust
pub struct InvoiceCore {
    // Tier 1: Identifiers (read-only, high frequency)
    pub id: u64,
    pub status: InvoiceStatus,

    // Tier 2: Financial amounts (read/write frequently)
    pub amount: i128,
    pub amount_funded: i128,
    pub amount_paid: i128,

    // Tier 3: Parties (high frequency)
    pub payer: Address,
    pub freelancer: Address,
    pub token: Address,

    // Tier 4: Parameters (medium frequency)
    pub due_date: u32,
    pub discount_rate: u32,
}
```

**Gas impact:** 5-8% additional savings.

---

### 4.3 Strategy 3: Storage Key Consolidation (Phase 3 - Lower Priority)

**Problem:** Reputation data split across two keys:
```
PayerScore(Address) → ReputationScore (score, last_activity_ledger)
Reputation(Address) → ReputationProfile (invoices_submitted, paid, defaulted, score)
```

**Solution:** Single consolidated key with all reputation data.

**Gas impact:** 5-10% savings on fund_invoice operations.

---

## 5. Benchmarking Strategy

### 5.1 Measurement Plan

**Before optimization:**
1. Run integration tests, record fund_invoice cost (baseline)
2. Run integration tests, record mark_paid cost (baseline)
3. Run integration tests, record submit_invoice cost (baseline)

**After optimization:**
1. Repeat same tests
2. Calculate % improvement per function
3. Document in BENCHMARKS.md

### 5.2 Test Cases

```
1. Single invoice flow:
   - submit_invoice() → baseline
   - fund_invoice() → baseline
   - mark_paid() → baseline

2. Partial funding (2 LPs):
   - submit_invoice()
   - fund_invoice(0.5 by LP1)
   - fund_invoice(0.5 by LP2)
   - mark_paid()

3. High-volume batch:
   - submit_invoice * 10
   - fund_invoice * 10
   - mark_paid * 10
```

---

## 6. Implementation Roadmap

| Phase | Task | Priority | Estimated Effort | Gas Savings |
|-------|------|----------|------------------|-------------|
| 1 | Hot/Cold separation | Critical | 4-6 hrs | 10-15% |
| 2 | Field reordering | High | 2-3 hrs | 5-8% |
| 3 | Key consolidation | Medium | 6-8 hrs | 5-10% |

---

## 7. Migration Strategy

**For hot/cold separation:**
1. Add new storage keys: `InvoiceCore(u64)`, `InvoiceMetadata(u64)`
2. Keep old `Invoice(u64)` key for backwards compatibility
3. Add migration function to copy old→new format
4. New saves use both keys; old key eventually deprecated

**Risk level:** Low (additive; old keys remain until explicitly deleted)

---

## 8. Next Steps

1. ✓ Analysis complete
2. ✓ Phase 1 (Hot/Cold Separation) implemented
3. Run gas benchmarks
4. Evaluate Phase 2 based on Phase 1 results
5. Deploy with testing

---

**Document prepared by:** Storage Optimization Analysis
**Last updated:** 2026-07-26
