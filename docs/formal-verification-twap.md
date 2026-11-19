# Formal Verification Specification — TWAP Accumulator

**Status:** Specification complete; implementation in `contracts/invoice_liquidity/src/twap_accumulator.rs`

**Target Contract:** `contracts/invoice_liquidity/src/twap_accumulator.rs`

---

## 1. Overview

This document defines formal invariants, valid state transitions, and safety properties for the Time-Weighted Average Price (TWAP) accumulator used for precise, manipulation-resistant price sampling across multiple tokens in the Invoice Liquidity contract.

The TWAP accumulator serves as a foundational building block for:
- Risk-adjusted premium calculation in the insurance pool (Issue #528).
- Payer credit scoring based on historical price movements.
- Governance parameter adjustment based on network conditions.

---

## 2. State Machine Specification

### 2.1 TWAP State

```rust
pub struct TWAPState {
    pub accumulated_price: i128,           // Sum of (price * time_delta)
    pub observation_count: u32,             // Number of observations recorded
    pub window_start_timestamp: u64,        // Oldest observation in window
    pub last_update_timestamp: u64,         // Most recent observation time
    pub last_ledger_sequence: u32,          // Ledger sequence of last update
}
```

### 2.2 Valid State Transitions

| From State | Action | To State | Guards |
|---|---|---|---|
| Empty | `record_observation` | With 1 observation | Observation validates all invariants |
| N observations | `record_observation` | N+1 observations | Ledger seq strictly increasing |
| Any | `get_twap` | (no state change) | Query only; read-only |

### 2.3 Prohibited Transitions (Enforced)

| Condition | Action | Error | Reason |
|---|---|---|---|
| `price < 0` | `record_observation` | `NegativePrice` | Invariant I1 |
| `ledger_sequence <= last_ledger_sequence` | `record_observation` | `MonotonicOrderViolation` | Invariant I2 |
| `timestamp < last_update + MIN_INTERVAL` | `record_observation` | `InsufficientObservationInterval` | Spam prevention |

---

## 3. Formal Invariants

### Invariant I1: Non-Negative Accumulated Price

**Formal Property:**
$$\forall t, \text{ token } \tau, \quad \text{accumulated\_price}(t, \tau) \geq 0$$

**Rationale:** Negative prices are not economically meaningful and could cause arithmetic underflow in downstream calculations.

**Enforcement:**
- At `record_observation()` entry point: `if price < 0 { return Err(NegativePrice) }`
- All arithmetic uses `saturating_add` / `saturating_mul` to prevent overflow.
- Test: `test_invariant_i1_rejects_negative_price()`

---

### Invariant I2: Monotonic Ledger-Sequence Ordering

**Formal Property:**
$$\forall i < j, \quad \text{ledger\_sequence}(o_i) < \text{ledger\_sequence}(o_j)$$

where $o_i, o_j$ are consecutive observations.

**Rationale:** Ledger sequence is a global causality clock. Observing prices out of order allows adversarial reordering and timestamp manipulation attacks.

**Enforcement:**
- At `record_observation()`: `if current_ledger_sequence <= state.last_ledger_sequence { return Err(...) }`
- Every observation increments ledger_sequence; no two observations share the same sequence.
- Test: `test_invariant_i2_enforces_monotonic_ledger_sequence()`

**Corollary I2a: Strict Timestamp Ordering**
$$\forall i < j, \quad \text{timestamp}(o_i) < \text{timestamp}(o_j)$$

Timestamps must also be strictly increasing to prevent replay and ordering attacks.

---

### Invariant I3: Sample Average Within Min/Max Bounds

**Formal Property:**
$$\forall \text{ window } W, \quad \min(P_W) \leq \text{TWAP}(W) \leq \max(P_W)$$

where $P_W$ is the set of raw prices in window $W$.

**Rationale:** If TWAP ever ventures outside the observed price range, it indicates arithmetic corruption or an attacker injecting invalid samples.

**Enforcement:**
- `get_twap()` calculates: `twap = accumulated_price / lookback_seconds`
- Since prices are non-negative (I1) and accumulated in order (I2), the TWAP is always between observed extremes.
- Test: `test_twap_calculation()` validates the formula over a 2-observation window.

---

### Invariant I4: Deterministic Accumulation

**Formal Property:**
Given identical sequences of observations (same prices, timestamps, ledger sequences), the resulting `accumulated_price` is deterministic.

$$\text{accumulated\_price}(O_1) = \text{accumulated\_price}(O_1') \quad \forall O_1, O_1' \text{ with identical elements}$$

**Rationale:** Non-determinism allows adversarial observers to inject randomness into critical calculations. For reproducibility in audits and formal verification, accumulation must be deterministic.

**Enforcement:**
- Accumulation formula: `accumulated_price += price * time_delta` (using saturating arithmetic).
- No reliance on random state, hash tables, or externalities.
- Test: `test_invariant_i4_deterministic_accumulation()` records identical sequences in two separate instances and verifies `accumulated_price` matches exactly.

---

## 4. Price Observation Specification

### 4.1 Observation Record

```rust
pub struct PriceObservation {
    pub timestamp: u64,              // Unix epoch seconds
    pub ledger_sequence: u32,        // Ledger sequence number
    pub price: i128,                 // Stroops per unit
}
```

### 4.2 Observation Constraints

| Field | Min | Max | Rationale |
|---|---|---|---|
| `price` | 0 | i128::MAX | Non-negative (I1); limited by contract arithmetic |
| `timestamp` | Strictly increasing | current_timestamp | Monotonicity; no future timestamps |
| `ledger_sequence` | Strictly increasing | Ledger consensus | Causality; no reordering |

### 4.3 Observation Rate Limiting

**Spam Prevention:** Minimum `MIN_OBSERVATION_INTERVAL_SECS = 60` between consecutive observations.

**Rationale:** Prevents adversaries from flooding the accumulator with stale samples, diluting the time weighting and making TWAP manipulation easier.

---

## 5. TWAP Calculation Specification

### 5.1 Formula

$$\text{TWAP} = \frac{\sum_{i=0}^{n-1} (\text{price}_i \times \Delta t_i)}{\text{lookback\_seconds}}$$

where:
- $\Delta t_i = \text{timestamp}_{i+1} - \text{timestamp}_i$
- $\text{lookback\_seconds}$ is the query window (e.g., 24 hours).

### 5.2 Edge Cases

| Condition | Behavior |
|---|---|
| No observations recorded | Return 0 |
| All observations older than lookback window | Return 0 |
| Division by zero (lookback_seconds == 0) | Return 0 |

### 5.3 Precision Loss & Rounding

- All arithmetic uses `i128` (128-bit signed integers).
- Division is integer division; fractional stroops are truncated (not rounded).
- Rationale: Truncation is deterministic and prevents rounding attack vectors.

---

## 6. Attack Vectors & Mitigations

### A1: Price Manipulation via Out-of-Order Observation

**Attack:** Adversary submits observations with decreasing ledger sequence to reorder price history.

**Mitigation (I2):** Strict monotonic ledger-sequence check; any out-of-order observation is rejected.

**Test:** `test_invariant_i2_enforces_monotonic_ledger_sequence()`

---

### A2: Timestamp Replay

**Attack:** Adversary submits same timestamp repeatedly to artificially zero time deltas and freeze TWAP.

**Mitigation (I2 + rate limit):** Timestamps must be strictly increasing, and minimum interval enforced.

**Test:** `test_observation_interval_spam_prevention()`

---

### A3: Negative Price Injection

**Attack:** Adversary submits negative price to cause underflow in downstream calculations.

**Mitigation (I1):** Explicit check at observation entry; any negative price rejected.

**Test:** `test_invariant_i1_rejects_negative_price()`

---

### A4: Arithmetic Overflow

**Attack:** Adversary submits extremely large prices or time deltas to cause overflow.

**Mitigation:** All multiplications use `saturating_mul`; overflow caps at i128::MAX, never wraps.

**Code:** `price.saturating_mul(time_delta as i128)`

---

## 7. Coverage & Testing

| Invariant | Test | Coverage |
|---|---|---|
| I1 (non-negative) | `test_invariant_i1_rejects_negative_price` | Directly tests rejection |
| I2 (monotonic) | `test_invariant_i2_enforces_monotonic_ledger_sequence` | Tests both ≤ and > violations |
| I3 (min/max bounds) | `test_twap_calculation` | Validates formula across multi-observation window |
| I4 (determinism) | `test_invariant_i4_deterministic_accumulation` | Runs identical sequences in separate instances |
| Rate limiting | `test_observation_interval_spam_prevention` | Ensures MIN_OBSERVATION_INTERVAL_SECS enforced |
| Edge cases | `test_twap_calculation` | Tests zero lookback and historical queries |

---

## 8. Fuzz Testing Specification (Issue #823)

Property-based fuzzing via `proptest` in `contracts/fuzz/src/lib.rs` covers:

### F1: Adversarial Observation Sequences

**Property:**
$$\forall \text{ sequences } O, \quad \text{record\_observation}(O) \text{ never panics}$$

**Test Strategy:** Generate random observation sequences with:
- Random prices in [0, i128::MAX]
- Random timestamps (monotonically increasing)
- Random ledger sequences (monotonically increasing)
- Variable time deltas

**Expected Outcome:** No panics; invariants hold for all sequences.

---

### F2: Out-of-Order Injection Resistance

**Property:** Fuzz inject out-of-order observations; all rejections succeed.

**Test:** Generate sequence [o1, o3, o2] (o2 out of order); confirm rejection.

---

### F3: TWAP Calculation Stability

**Property:** TWAP(W) never overflows or underflows regardless of price magnitudes.

**Test:** Fuzz with extreme prices (near i128::MAX) and verify results use saturating arithmetic.

---

## 9. Formal Verification Roadmap

### Phase 1 (Current)
- Invariant specification (this document).
- Unit tests covering all invariants.
- Fuzz tests for adversarial sequences.

### Phase 2 (Future)
- Automated theorem prover (e.g., Coq, F*) proof of invariants.
- Formal model of ledger sequence causality.
- Formal proof that TWAP(W) is always in [min, max] bounds.

---

## 10. Summary

The TWAP accumulator enforces four critical invariants:
1. **I1**: Non-negative prices (prevents underflow).
2. **I2**: Monotonic ledger sequence (prevents reordering).
3. **I3**: TWAP bounded by observed min/max (prevents arithmetic corruption).
4. **I4**: Deterministic accumulation (prevents adversarial randomness).

These invariants collectively ensure that the TWAP is a reliable, tamper-resistant price signal for downstream insurance premiums, credit scoring, and governance calculations.
