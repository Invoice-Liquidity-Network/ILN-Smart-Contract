# Storage Layout Optimization Analysis for Invoice Liquidity Contract

**Date:** 2026-07-26
**Status:** Implementation Plan

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
| **Instance** | 1x | Permanent | Contract state, config, counters |
| **Persistent** | 1.5x | ~100 years | Invoices, scores, queues, stats |
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
2. → Implement Phase 1 (Hot/Cold Separation)
3. Run gas benchmarks
4. Evaluate Phase 2 based on Phase 1 results
5. Deploy with testing

---

**Document prepared by:** Storage Optimization Analysis
**Last updated:** 2026-07-26
