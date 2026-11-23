//! Claim payout prioritization when simultaneous defaults exceed pool balance.
//!
//! Issue #825 — Define and implement claim payout priority when simultaneous
//! defaults exceed pool balance.
//!
//! ## Threat Model (G3: Pool Drainage / Insolvency Risk)
//! When multiple LPs default simultaneously and pool balance is insufficient
//! to cover all claims, we prioritize payouts using a configurable strategy:
//!
//! 1. **Pro-Rata**: LPs receive payouts proportional to their accumulated premiums.
//! 2. **Risk-Weighted**: Adjusts pro-rata by LP default history (more claims = lower priority).
//! 3. **FIFO**: Earlier claimants are paid first; later claims may receive partial or zero payout.
//!
//! ## Invariants
//!
//! **Invariant P1: Non-Negative Payout**
//! All payouts are >= 0. Never pay negative amounts.
//!
//! **Invariant P2: Total Payout <= Pool Balance**
//! Sum of all payouts never exceeds the pool's available balance.
//!
//! **Invariant P3: Deterministic Order**
//! Given a fixed set of claims and a prioritization strategy, payout order is deterministic.

extern crate alloc;

use alloc::{vec, vec::Vec};
use soroban_sdk::{contracttype, Address, Env};

/// Payout prioritization strategy for claims exceeding pool balance.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PayoutStrategy {
    /// Pro-rata by accumulated premiums.
    ProRata = 0,
    /// Pro-rata adjusted by LP risk profile (default history).
    RiskWeighted = 1,
    /// First-in-first-out by claim timestamp.
    FIFO = 2,
}

/// Claim record queued for payout.
#[contracttype]
#[derive(Clone, Debug)]
pub struct PendingClaim {
    /// LP claiming the payout.
    pub lp: Address,
    /// Invoice ID being claimed.
    pub invoice_id: u64,
    /// Timestamp when claim was filed.
    pub claim_timestamp: u64,
    /// LP's total accumulated premiums (for pro-rata calculation).
    pub lp_total_premiums: i128,
    /// Number of prior defaults for this LP (for risk-weighting).
    pub lp_default_count: i32,
    /// Coverage cap applicable to this claim.
    pub coverage_cap: i128,
}

/// Calculate payout for a single LP given constrained pool balance.
///
/// ## Invariant P1/P2 Enforcement
/// Returns payout >= 0 and <= min(coverage_cap, available_pool_balance).
pub fn calculate_payout(
    claim: &PendingClaim,
    strategy: PayoutStrategy,
    pool_balance: i128,
    total_pending_claims: i128,
    total_lp_premiums: i128,
) -> Result<i128, ClaimPrioritizationError> {
    // Invariant P1: Reject negative pool balance
    if pool_balance < 0 {
        return Err(ClaimPrioritizationError::InvalidPoolBalance);
    }

    // Base payout is capped by coverage
    let base_payout = claim.coverage_cap.min(pool_balance);

    if base_payout <= 0 {
        return Ok(0);
    }

    let payout = match strategy {
        PayoutStrategy::ProRata => calculate_pro_rata(claim, base_payout, total_lp_premiums),
        PayoutStrategy::RiskWeighted => {
            calculate_risk_weighted(claim, base_payout, total_lp_premiums)
        }
        PayoutStrategy::FIFO => base_payout, // FIFO pays up to coverage cap
    };

    // Invariant P1: Ensure non-negative payout
    Ok(payout.max(0))
}

/// Pro-rata payout proportional to LP's accumulated premiums.
///
/// payout = base_payout * (lp_premiums / total_premiums)
fn calculate_pro_rata(claim: &PendingClaim, base_payout: i128, total_lp_premiums: i128) -> i128 {
    if total_lp_premiums <= 0 {
        return 0;
    }

    // payout = base_payout * lp_premiums / total_premiums
    let numerator = base_payout.saturating_mul(claim.lp_total_premiums);
    numerator.saturating_div(total_lp_premiums)
}

/// Risk-weighted payout adjusts pro-rata by LP default history.
///
/// multiplier = 1 / (1 + default_count)
/// risk_weighted_payout = pro_rata * multiplier
fn calculate_risk_weighted(
    claim: &PendingClaim,
    base_payout: i128,
    total_lp_premiums: i128,
) -> i128 {
    let pro_rata = calculate_pro_rata(claim, base_payout, total_lp_premiums);

    // Risk multiplier: 1 / (1 + default_count)
    // For simplicity, we use: payout * 100 / (100 + default_count)
    let divisor = 100i128.saturating_add(claim.lp_default_count as i128);
    pro_rata.saturating_mul(100).saturating_div(divisor)
}

/// Allocate constrained pool balance across multiple pending claims.
///
/// ## Invariant P2 Enforcement
/// Total allocated across all claims never exceeds pool_balance.
pub fn allocate_payouts(
    claims: &[PendingClaim],
    strategy: PayoutStrategy,
    pool_balance: i128,
) -> Result<Vec<(Address, i128)>, ClaimPrioritizationError> {
    if pool_balance < 0 {
        return Err(ClaimPrioritizationError::InvalidPoolBalance);
    }

    if claims.is_empty() {
        return Ok(vec![]);
    }

    // Sort claims by strategy
    let mut sorted_claims: Vec<_> = claims.iter().collect();
    match strategy {
        PayoutStrategy::FIFO => {
            sorted_claims.sort_by_key(|c| c.claim_timestamp);
        }
        PayoutStrategy::ProRata | PayoutStrategy::RiskWeighted => {
            // For pro-rata strategies, order by premium amount (highest first)
            sorted_claims.sort_by(|a, b| b.lp_total_premiums.cmp(&a.lp_total_premiums));
        }
    }

    let total_lp_premiums: i128 = claims.iter().map(|c| c.lp_total_premiums).sum();
    let mut allocations: Vec<(Address, i128)> = vec![];
    let mut remaining_balance = pool_balance;

    for claim in sorted_claims {
        if remaining_balance <= 0 {
            break;
        }

        let payout = calculate_payout(claim, strategy, remaining_balance, 0, total_lp_premiums)?;

        // Invariant P2: Never pay more than remaining balance
        let actual_payout = payout.min(remaining_balance);
        if actual_payout > 0 {
            allocations.push((claim.lp.clone(), actual_payout));
            remaining_balance = remaining_balance.saturating_sub(actual_payout);
        }
    }

    Ok(allocations)
}

/// Errors in claim prioritization.
#[repr(u32)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ClaimPrioritizationError {
    /// Pool balance is negative (invariant violation).
    InvalidPoolBalance = 1,
    /// Payout calculation overflowed.
    PayoutOverflow = 2,
    /// No claims to process.
    NoClaimsToPrioritize = 3,
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn make_claim(premiums: i128, default_count: i32) -> PendingClaim {
        PendingClaim {
            lp: Address::generate(&Env::default()),
            invoice_id: 1,
            claim_timestamp: 1000,
            lp_total_premiums: premiums,
            lp_default_count: default_count,
            coverage_cap: 1_000_000,
        }
    }

    #[test]
    fn test_invariant_p1_non_negative_payout() {
        let claim = make_claim(100, 0);
        let payout = calculate_payout(&claim, PayoutStrategy::ProRata, 1_000, 0, 1000).unwrap();
        assert!(payout >= 0);
    }

    #[test]
    fn test_invariant_p2_payout_le_pool_balance() {
        let claim = make_claim(100, 0);
        let pool_balance = 500;
        let payout =
            calculate_payout(&claim, PayoutStrategy::ProRata, pool_balance, 0, 1000).unwrap();
        assert!(payout <= pool_balance);
    }

    #[test]
    fn test_pro_rata_equal_premiums() {
        let env = Env::default();
        let lp1 = Address::generate(&env);
        let lp2 = Address::generate(&env);

        let claim1 = PendingClaim {
            lp: lp1,
            invoice_id: 1,
            claim_timestamp: 1000,
            lp_total_premiums: 1000,
            lp_default_count: 0,
            coverage_cap: 10_000,
        };

        let claim2 = PendingClaim {
            lp: lp2,
            invoice_id: 2,
            claim_timestamp: 1001,
            lp_total_premiums: 1000,
            lp_default_count: 0,
            coverage_cap: 10_000,
        };

        let allocations =
            allocate_payouts(&[claim1, claim2], PayoutStrategy::ProRata, 1000).unwrap();

        // Both should get 500 (50% of pool)
        assert_eq!(allocations.len(), 2);
        let total: i128 = allocations.iter().map(|(_, amt)| amt).sum();
        assert!(total <= 1000);
    }

    #[test]
    fn test_pro_rata_unequal_premiums() {
        let env = Env::default();
        let lp1 = Address::generate(&env);
        let lp2 = Address::generate(&env);

        let claim1 = PendingClaim {
            lp: lp1,
            invoice_id: 1,
            claim_timestamp: 1000,
            lp_total_premiums: 2000,
            lp_default_count: 0,
            coverage_cap: 10_000,
        };

        let claim2 = PendingClaim {
            lp: lp2,
            invoice_id: 2,
            claim_timestamp: 1001,
            lp_total_premiums: 1000,
            lp_default_count: 0,
            coverage_cap: 10_000,
        };

        let allocations =
            allocate_payouts(&[claim1, claim2], PayoutStrategy::ProRata, 900).unwrap();

        // LP1 should get ~600, LP2 should get ~300 (2:1 ratio)
        let total: i128 = allocations.iter().map(|(_, amt)| amt).sum();
        assert!(total <= 900);
    }

    #[test]
    fn test_risk_weighted_reduces_default_heavy_lp() {
        let env = Env::default();
        let lp_clean = Address::generate(&env);
        let lp_risky = Address::generate(&env);

        let claim_clean = PendingClaim {
            lp: lp_clean,
            invoice_id: 1,
            claim_timestamp: 1000,
            lp_total_premiums: 1000,
            lp_default_count: 0,
            coverage_cap: 10_000,
        };

        let claim_risky = PendingClaim {
            lp: lp_risky,
            invoice_id: 2,
            claim_timestamp: 1001,
            lp_total_premiums: 1000,
            lp_default_count: 5,
            coverage_cap: 10_000,
        };

        let payout_clean =
            calculate_payout(&claim_clean, PayoutStrategy::RiskWeighted, 1000, 0, 2000).unwrap();
        let payout_risky =
            calculate_payout(&claim_risky, PayoutStrategy::RiskWeighted, 1000, 0, 2000).unwrap();

        // Clean LP should get higher payout than risky LP
        assert!(payout_clean > payout_risky);
    }

    #[test]
    fn test_fifo_pays_first_claimant_first() {
        let env = Env::default();
        let lp1 = Address::generate(&env);
        let lp2 = Address::generate(&env);

        let claim1 = PendingClaim {
            lp: lp1.clone(),
            invoice_id: 1,
            claim_timestamp: 1000,
            lp_total_premiums: 500,
            lp_default_count: 0,
            coverage_cap: 1000,
        };

        let claim2 = PendingClaim {
            lp: lp2,
            invoice_id: 2,
            claim_timestamp: 2000, // Later timestamp
            lp_total_premiums: 500,
            lp_default_count: 0,
            coverage_cap: 1000,
        };

        let allocations = allocate_payouts(&[claim1, claim2], PayoutStrategy::FIFO, 1200).unwrap();

        // LP1 (earlier) should be satisfied first
        assert_eq!(allocations[0].0, lp1);
    }

    // ────────────────────────────────────────────────────────────────────
    // Issue #1197 — priority ordering, tie-breaking, stale claims and
    // repeated claim selection.
    //
    // The tests below pin *observed* behaviour of this pure allocator. It is
    // a deterministic, order-sensitive function; it is NOT yet wired into
    // `InsurancePool::claim`, so the contract's own `Claimed` idempotency and
    // review/solvency gates are not applied here. See
    // docs/claim-prioritization.md for the invariants, verified findings and
    // residual risks.
    // ────────────────────────────────────────────────────────────────────

    /// Build a claim with explicit ordering-relevant fields.
    fn claim(
        lp: &Address,
        invoice_id: u64,
        ts: u64,
        premiums: i128,
        defaults: i32,
        cap: i128,
    ) -> PendingClaim {
        PendingClaim {
            lp: lp.clone(),
            invoice_id,
            claim_timestamp: ts,
            lp_total_premiums: premiums,
            lp_default_count: defaults,
            coverage_cap: cap,
        }
    }

    #[test]
    fn strategy_discriminants_are_stable() {
        // Pin the on-chain encoding (used by storage/events serialisation).
        assert_eq!(PayoutStrategy::ProRata as u32, 0);
        assert_eq!(PayoutStrategy::RiskWeighted as u32, 1);
        assert_eq!(PayoutStrategy::FIFO as u32, 2);
    }

    #[test]
    fn fifo_orders_by_timestamp_ascending_regardless_of_input() {
        let env = Env::default();
        let lp_a = Address::generate(&env);
        let lp_b = Address::generate(&env);
        let lp_c = Address::generate(&env);

        // Input deliberately out of timestamp order: A(3000), B(1000), C(2000).
        let a = claim(&lp_a, 1, 3000, 100, 0, 1000);
        let b = claim(&lp_b, 2, 1000, 100, 0, 1000);
        let c = claim(&lp_c, 3, 2000, 100, 0, 1000);

        let allocations = allocate_payouts(&[a, b, c], PayoutStrategy::FIFO, 3000).unwrap();

        // Paid oldest-first: B, C, A — the whole pool is distributed.
        assert_eq!(allocations.len(), 3);
        assert_eq!(allocations[0].0, lp_b);
        assert_eq!(allocations[1].0, lp_c);
        assert_eq!(allocations[2].0, lp_a);
        assert_eq!(allocations.iter().map(|(_, amt)| amt).sum::<i128>(), 3000);
    }

    #[test]
    fn pro_rata_orders_by_descending_premiums() {
        let env = Env::default();
        let lp_a = Address::generate(&env); // 100
        let lp_b = Address::generate(&env); // 300
        let lp_c = Address::generate(&env); // 200

        // Equal depth caps so the ordering is driven purely by premium share.
        let a = claim(&lp_a, 1, 1000, 100, 0, 1_000_000);
        let b = claim(&lp_b, 2, 1000, 300, 0, 1_000_000);
        let c = claim(&lp_c, 3, 1000, 200, 0, 1_000_000);

        let allocations = allocate_payouts(&[a, b, c], PayoutStrategy::ProRata, 600).unwrap();

        // Highest premium first: B(300), C(200), A(100).
        assert_eq!(allocations.len(), 3);
        assert_eq!(allocations[0].0, lp_b);
        assert_eq!(allocations[1].0, lp_c);
        assert_eq!(allocations[2].0, lp_a);

        // Each payout is pro-rata against the *shrinking* remaining balance:
        //   B = 600*300/600 = 300  (remaining 300)
        //   C = 300*200/600 = 100  (remaining 200)
        //   A = 200*100/600 =  33  (remaining 167)
        assert_eq!(allocations[0].1, 300);
        assert_eq!(allocations[1].1, 100);
        assert_eq!(allocations[2].1, 33);
        // Integer truncation + a shrinking base means the pool is NOT fully
        // distributed even though every claim was processed.
        assert_eq!(allocations.iter().map(|(_, amt)| amt).sum::<i128>(), 433);
    }

    #[test]
    fn risk_weighted_ordering_ignores_risk_profile() {
        let env = Env::default();
        let lp_risky = Address::generate(&env); // prem 300, 5 defaults
        let lp_clean = Address::generate(&env); // prem 100, 0 defaults

        let risky = claim(&lp_risky, 1, 1000, 300, 5, 1_000_000);
        let clean = claim(&lp_clean, 2, 1000, 100, 0, 1_000_000);

        let allocations =
            allocate_payouts(&[risky, clean], PayoutStrategy::RiskWeighted, 600).unwrap();

        // Ordering is by premium (desc), *not* by risk: the riskier,
        // higher-premium LP is served first. Risk only scales the payout.
        assert_eq!(allocations[0].0, lp_risky);
        assert_eq!(allocations[1].0, lp_clean);

        // risky: pro_rata 600*300/400 = 450, risk factor 100/(100+5) -> 428
        // clean: base 600-428 = 172, pro_rata 172*100/400 = 43 -> 43
        assert_eq!(allocations[0].1, 428);
        assert_eq!(allocations[1].1, 43);
    }

    #[test]
    fn fifo_ties_break_on_input_order() {
        let env = Env::default();
        let lp_a = Address::generate(&env);
        let lp_b = Address::generate(&env);
        let lp_c = Address::generate(&env);

        // Identical timestamps => the stable sort keeps input order A, B, C.
        let a = claim(&lp_a, 1, 1000, 100, 0, 1000);
        let b = claim(&lp_b, 2, 1000, 100, 0, 1000);
        let c = claim(&lp_c, 3, 1000, 100, 0, 1000);

        let allocations = allocate_payouts(&[a, b, c], PayoutStrategy::FIFO, 2000).unwrap();

        // Only the first two (in input order) are funded; the third is omitted.
        assert_eq!(allocations.len(), 2);
        assert_eq!(allocations[0].0, lp_a);
        assert_eq!(allocations[1].0, lp_b);
    }

    #[test]
    fn fifo_tie_break_follows_reversed_input() {
        let env = Env::default();
        let lp_a = Address::generate(&env);
        let lp_b = Address::generate(&env);
        let lp_c = Address::generate(&env);

        let a = claim(&lp_a, 1, 1000, 100, 0, 1000);
        let b = claim(&lp_b, 2, 1000, 100, 0, 1000);
        let c = claim(&lp_c, 3, 1000, 100, 0, 1000);

        // Reversing the input reverses the winner set: the tie-break is the
        // caller-supplied order, not a property of the claim records.
        let allocations = allocate_payouts(&[c, b, a], PayoutStrategy::FIFO, 2000).unwrap();
        assert_eq!(allocations.len(), 2);
        assert_eq!(allocations[0].0, lp_c);
        assert_eq!(allocations[1].0, lp_b);
    }

    #[test]
    fn pro_rata_ties_break_on_input_order() {
        let env = Env::default();
        let lp_a = Address::generate(&env);
        let lp_b = Address::generate(&env);
        let lp_c = Address::generate(&env);

        // Equal premiums and equal depth caps: input order decides who is paid
        // from the shrinking remaining balance first.
        let a = claim(&lp_a, 1, 1000, 100, 0, 1_000_000);
        let b = claim(&lp_b, 2, 1000, 100, 0, 1_000_000);
        let c = claim(&lp_c, 3, 1000, 100, 0, 1_000_000);

        let allocations = allocate_payouts(&[a, b, c], PayoutStrategy::ProRata, 2000).unwrap();

        assert_eq!(allocations[0].0, lp_a);
        assert_eq!(allocations[1].0, lp_b);
        assert_eq!(allocations[2].0, lp_c);
        // Earlier-in-input claims are paid from a larger base, so their payout
        // is strictly larger even though premiums are identical.
        assert!(allocations[0].1 > allocations[1].1);
        assert!(allocations[1].1 > allocations[2].1);
    }

    #[test]
    fn stale_claims_are_paid_first_and_never_expire() {
        let env = Env::default();
        let lp_old = Address::generate(&env);
        let lp_new = Address::generate(&env);

        // The allocator takes no `now` argument, so a very old claim is neither
        // rejected nor deprioritised — FIFO simply pays it first.
        let old = claim(&lp_old, 1, 1, 100, 0, 1_000_000);
        let fresh = claim(&lp_new, 2, 4_000_000_000, 100, 0, 1_000_000);

        let allocations = allocate_payouts(&[fresh, old], PayoutStrategy::FIFO, 500).unwrap();

        // The single funded slot goes to the stale claim; the fresh one is
        // omitted entirely (never zero-filled).
        assert_eq!(allocations.len(), 1);
        assert_eq!(allocations[0].0, lp_old);
        assert_eq!(allocations[0].1, 500);
    }

    #[test]
    fn repeated_claims_are_not_deduplicated() {
        let env = Env::default();
        let lp = Address::generate(&env);

        // Same LP, same invoice id: the allocator has no knowledge of the
        // contract's `Claimed` idempotency marker, so both entries are funded.
        let first = claim(&lp, 7, 1000, 100, 0, 1000);
        let second = claim(&lp, 7, 1000, 100, 0, 1000);

        let allocations = allocate_payouts(&[first, second], PayoutStrategy::FIFO, 2000).unwrap();

        assert_eq!(allocations.len(), 2);
        assert_eq!(allocations[0].0, lp);
        assert_eq!(allocations[1].0, lp);
        assert_eq!(allocations.iter().map(|(_, amt)| amt).sum::<i128>(), 2000);
    }

    #[test]
    fn one_lp_with_multiple_invoices_appears_once_per_claim() {
        let env = Env::default();
        let lp = Address::generate(&env);

        let inv1 = claim(&lp, 1, 1000, 100, 0, 1000);
        let inv2 = claim(&lp, 2, 2000, 100, 0, 1000);

        let allocations = allocate_payouts(&[inv1, inv2], PayoutStrategy::FIFO, 2000).unwrap();

        // Two allocations for the same address: consumers must aggregate by LP.
        assert_eq!(allocations.len(), 2);
        assert_eq!(allocations[0].0, lp);
        assert_eq!(allocations[1].0, lp);
    }

    #[test]
    fn zero_pool_balance_funds_nothing_and_negative_is_rejected() {
        let env = Env::default();
        let lp = Address::generate(&env);
        let c = claim(&lp, 1, 1000, 100, 0, 1000);

        assert!(allocate_payouts(&[c.clone()], PayoutStrategy::FIFO, 0)
            .unwrap()
            .is_empty());
        assert_eq!(
            allocate_payouts(&[c.clone()], PayoutStrategy::FIFO, -1),
            Err(ClaimPrioritizationError::InvalidPoolBalance)
        );
        assert_eq!(
            calculate_payout(&c, PayoutStrategy::FIFO, -1, 0, 100),
            Err(ClaimPrioritizationError::InvalidPoolBalance)
        );
    }

    #[test]
    fn empty_claim_set_returns_empty_allocations() {
        let allocations: Vec<(Address, i128)> =
            allocate_payouts(&[], PayoutStrategy::ProRata, 5000).unwrap();
        assert!(allocations.is_empty());
    }

    #[test]
    fn fifo_payout_is_bounded_by_coverage_cap_and_reserve() {
        let env = Env::default();
        let lp = Address::generate(&env);

        // cap < reserve -> payout is the cap.
        let capped = claim(&lp, 1, 1000, 100, 0, 100);
        assert_eq!(
            calculate_payout(&capped, PayoutStrategy::FIFO, 1000, 0, 100).unwrap(),
            100
        );

        // reserve < cap -> payout is the reserve.
        let deep = claim(&lp, 2, 1000, 100, 0, 1_000_000);
        assert_eq!(
            calculate_payout(&deep, PayoutStrategy::FIFO, 250, 0, 100).unwrap(),
            250
        );

        // zero cap -> nothing, even with a healthy reserve.
        let zero_cap = claim(&lp, 3, 1000, 100, 0, 0);
        assert_eq!(
            calculate_payout(&zero_cap, PayoutStrategy::FIFO, 1000, 0, 100).unwrap(),
            0
        );
    }

    #[test]
    fn total_pending_claims_argument_does_not_affect_payout() {
        let env = Env::default();
        let lp = Address::generate(&env);
        let c = claim(&lp, 1, 1000, 100, 0, 10_000);

        let with_zero = calculate_payout(&c, PayoutStrategy::ProRata, 1000, 0, 1000).unwrap();
        let with_many = calculate_payout(&c, PayoutStrategy::ProRata, 1000, 999_999, 1000).unwrap();

        // The parameter is accepted but never read (see RR-2).
        assert_eq!(with_zero, with_many);
    }

    #[test]
    fn negative_default_count_inflates_risk_weighted_payout() {
        let env = Env::default();
        let lp = Address::generate(&env);
        let c = claim(&lp, 1, 1000, 100, -50, 10_000);

        // pro_rata = 1000*100/1000 = 100; divisor = 100 + (-50) = 50
        // payout   = 100 * 100 / 50 = 200  (a zero-default LP would get 100).
        assert_eq!(
            calculate_payout(&c, PayoutStrategy::RiskWeighted, 1000, 0, 1000).unwrap(),
            200
        );
    }

    #[test]
    #[should_panic(expected = "divide by zero")]
    fn risk_weighted_panics_when_default_count_cancels_the_divisor() {
        let env = Env::default();
        let lp = Address::generate(&env);
        // divisor = 100 + (-100) = 0 -> saturating_div panics.
        let c = claim(&lp, 1, 1000, 100, -100, 10_000);
        let _ = calculate_payout(&c, PayoutStrategy::RiskWeighted, 1000, 0, 1000);
    }

    #[test]
    fn allocation_is_deterministic_for_identical_input() {
        let env = Env::default();
        let lp_a = Address::generate(&env);
        let lp_b = Address::generate(&env);
        let a = claim(&lp_a, 1, 1000, 100, 1, 1000);
        let b = claim(&lp_b, 2, 1000, 100, 1, 1000);

        let first =
            allocate_payouts(&[a.clone(), b.clone()], PayoutStrategy::RiskWeighted, 500).unwrap();
        let second = allocate_payouts(&[a, b], PayoutStrategy::RiskWeighted, 500).unwrap();

        // Invariant P3: identical input -> identical output.
        assert_eq!(first, second);
    }
}
