//! Issue #1196 — edge-case coverage for the insurance pool's *coverage gate*.
//!
//! The existing `test` suite exercises the happy paths of every gate
//! (tiered coverage, solvency circuit, review window, backstop, balance
//! cap). This module pins the *boundaries* and the interactions the happy
//! paths don't reach:
//!
//!   * **Test coverage thresholds** — tier selection at (and just below)
//!     the 10%/25%/50% brackets, and the truncation that occurs when the
//!     governance-set coverage cap is smaller than 10 stroops.
//!   * **Pool availability** — `claim` payout is `min(tiered_cap, reserve)`
//!     across the `tier < reserve`, `tier == reserve` and `tier > reserve`
//!     cases, including a backstop-only reserve.
//!   * **Stale insurance state** — the review-window/evidence gate reads the
//!     *current* window against the *stored* submission time, so raising or
//!     lowering the window after evidence is submitted re-times the payout;
//!     the solvency breaker is sticky until an explicit governance reset and
//!     a reset below the threshold buys exactly one more payout.
//!   * **Denied funding / claims** — `deposit_premium`, `enroll` and the
//!     backstop keep working while the breaker is open, a denied claim moves
//!     no state, and a balance-cap rejection rolls the whole deposit back.
//!
//! See `docs/insurance-coverage-gate.md` for the gate inventory, invariants
//! (INV-CG*), verified findings (VF-*) and residual risks (RR-*).
//!
//! Note: every assertion below is against *observed* contract behaviour, not
//! an assumed one — the module is a regression net, and the accompanying doc
//! separates verified findings from residual risk.

#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    Address, BytesN, Env,
};

/// Flat per-claim coverage cap used by the default fixture (100 units @ 1e7).
const COVERAGE: i128 = 1_000_000_000;

struct GateEnv {
    env: Env,
    client: InsurancePoolClient<'static>,
    token: TokenClient<'static>,
    token_admin: StellarAssetClient<'static>,
    lp: Address,
}

fn setup_gate() -> GateEnv {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, InsurancePool);
    let client = InsurancePoolClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let lp = Address::generate(&env);

    let token_admin_addr = Address::generate(&env);
    let token_contract_id = env.register_stellar_asset_contract_v2(token_admin_addr);
    let token_address = token_contract_id.address();
    let token = TokenClient::new(&env, &token_address);
    let token_admin = StellarAssetClient::new(&env, &token_address);

    client.initialize(&admin, &COVERAGE, &token_address);

    GateEnv {
        env,
        client,
        token,
        token_admin,
        lp,
    }
}

/// Mint `amount` to the shared LP and deposit it as a premium.
fn fund_and_deposit(t: &GateEnv, amount: i128) {
    t.token_admin.mint(&t.lp, &amount);
    t.client.deposit_premium(&t.lp, &amount);
}

fn evidence(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

// ─────────────────────────────────────────────────────────────────────────
// Coverage thresholds
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn zero_premium_lp_defaults_to_base_tier_at_normal_coverage() {
    let t = setup_gate();
    let stranger = Address::generate(&t.env);

    // An LP that never paid a premium is still "entitled" to the base 50%
    // tier at a normal coverage cap — the tier is derived purely from
    // premiums-paid vs coverage, with no enrollment gate in the math.
    assert_eq!(t.client.get_premiums_paid(&stranger), 0);
    assert_eq!(t.client.get_tiered_coverage(&stranger), COVERAGE / 2);
}

#[test]
fn tier_thresholds_collapse_below_ten_stroops() {
    let t = setup_gate();
    let zero = Address::generate(&t.env);

    // coverage == 10: thresholds are 1 / 2 / 5, so a zero-premium LP is
    // still correctly the 50% tier — the last coverage value at which the
    // bracket arithmetic behaves as designed.
    t.client.set_coverage_via_governance(&10);
    assert_eq!(t.client.get_tiered_coverage(&zero), 5);

    // coverage == 9: threshold_10 truncates to 0, so a *zero-premium* LP now
    // clears the >= threshold_10 arm and is placed in the 75% tier.
    t.client.set_coverage_via_governance(&9);
    assert_eq!(t.client.get_tiered_coverage(&zero), (9 * 75) / 100);

    // coverage == 3: threshold_25 also truncates to 0 -> 100% tier.
    t.client.set_coverage_via_governance(&3);
    assert_eq!(t.client.get_tiered_coverage(&zero), 3);

    // coverage == 1: every threshold is 0 -> the top (150%) tier.
    t.client.set_coverage_via_governance(&1);
    assert_eq!(t.client.get_tiered_coverage(&zero), (1 * 150) / 100);
}

#[test]
fn exact_threshold_values_select_the_upper_tier() {
    let t = setup_gate();
    t.client.set_coverage_via_governance(&1000);

    // `>=` semantics: the threshold value itself belongs to the tier *above*
    // it. Each case uses a fresh LP so the deposit amounts stay isolated.
    let cases: [(i128, i128); 6] = [
        (99, (1000 * 50) / 100),   // below threshold_10 (100) -> 50% tier
        (100, (1000 * 75) / 100),  // exactly threshold_10 -> 75% tier
        (249, (1000 * 75) / 100),  // below threshold_25 (250) -> 75% tier
        (250, 1000),               // exactly threshold_25 -> 100% tier
        (499, 1000),               // below threshold_50 (500) -> 100% tier
        (500, (1000 * 150) / 100), // exactly threshold_50 -> 150% tier
    ];

    for &(premium, expected) in cases.iter() {
        let lp = Address::generate(&t.env);
        t.token_admin.mint(&lp, &premium);
        t.client.deposit_premium(&lp, &premium);
        assert_eq!(
            t.client.get_tiered_coverage(&lp),
            expected,
            "premium={premium} must map to the expected tier"
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Pool availability
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn claim_rejects_on_empty_pool_even_for_entitled_lp() {
    let t = setup_gate();

    // Enrolled, entitled to the base tier, but the pool has zero reserve:
    // availability — not entitlement — decides whether a payout happens.
    t.client.enroll(&t.lp);
    assert_eq!(t.client.get_pool_balance(), 0);
    assert_eq!(t.client.get_tiered_coverage(&t.lp), COVERAGE / 2);

    let res = t.client.try_claim(&1, &t.lp);
    assert_eq!(
        res,
        Err(Ok(soroban_sdk::Error::from(InsuranceError::PoolEmpty)))
    );
}

#[test]
fn payout_is_minimum_of_tier_cap_and_available_reserve() {
    let t = setup_gate();
    t.client.set_coverage_via_governance(&1000);

    // 3000 premium (> 50% of a 1000 cap) -> 150% tier = 1500; reserve = 3000.
    fund_and_deposit(&t, 3000);
    assert_eq!(t.client.get_tiered_coverage(&t.lp), 1500);

    // tier (1500) < reserve (3000): payout is bounded by the tier cap.
    assert_eq!(t.client.claim(&1, &t.lp), 1500);
    assert_eq!(t.client.get_pool_balance(), 1500);

    // tier (1500) == reserve (1500): payout equals both.
    assert_eq!(t.client.claim(&2, &t.lp), 1500);
    assert_eq!(t.client.get_pool_balance(), 0);

    // No reserve left -> the next claim is denied as PoolEmpty.
    let res = t.client.try_claim(&3, &t.lp);
    assert_eq!(
        res,
        Err(Ok(soroban_sdk::Error::from(InsuranceError::PoolEmpty)))
    );
}

#[test]
fn payout_is_capped_by_available_reserve_when_tier_exceeds_it() {
    let t = setup_gate();
    t.client.set_coverage_via_governance(&1000);

    // 100 premium is exactly threshold_10 -> a 750 tier, but only 100 of
    // reserve exists, so the payout is floored to the reserve.
    fund_and_deposit(&t, 100);
    assert_eq!(t.client.get_tiered_coverage(&t.lp), 750);
    assert_eq!(t.client.claim(&1, &t.lp), 100);
    assert_eq!(t.client.get_pool_balance(), 0);
}

#[test]
fn claim_draws_from_backstop_when_liquid_balance_is_zero() {
    let t = setup_gate();
    t.client.set_coverage_via_governance(&1000);
    t.client.set_backstop_funding_bps(&10_000); // route 100% to the backstop

    fund_and_deposit(&t, 500);
    assert_eq!(t.client.get_pool_balance(), 0);
    assert_eq!(t.client.get_backstop_balance(), 500);
    assert_eq!(t.client.get_tiered_coverage(&t.lp), 1500);

    // available = 0 (liquid) + 500 (backstop); tier 1500 is capped to 500 and
    // drawn entirely from the backstop.
    assert_eq!(t.client.claim(&1, &t.lp), 500);
    assert_eq!(t.client.get_pool_balance(), 0);
    assert_eq!(t.client.get_backstop_balance(), 0);
    assert_eq!(t.token.balance(&t.lp), 500);
}

#[test]
fn claim_gate_precedence_is_claimed_then_solvency_then_review() {
    let t = setup_gate();

    // A tiny reserve trips the breaker on the first pay-out.
    fund_and_deposit(&t, 100);
    t.client.set_min_reserve_ratio_bps(&5000);
    let _ = t.client.claim(&1, &t.lp);
    assert!(t.client.is_solvency_circuit_open());

    // Review gate is also enabled and unsatisfied for a fresh invoice.
    t.client.set_review_window_seconds(&100);

    // Idempotency is checked before every other gate: a replayed invoice
    // reports AlreadyClaimed even with the breaker open and no evidence.
    let res = t.client.try_claim(&1, &t.lp);
    assert_eq!(
        res,
        Err(Ok(soroban_sdk::Error::from(
            InsuranceError::AlreadyClaimed
        )))
    );

    // For a fresh invoice the solvency gate wins over the review gate.
    let res = t.client.try_claim(&2, &t.lp);
    assert_eq!(
        res,
        Err(Ok(soroban_sdk::Error::from(
            InsuranceError::SolvencyCircuitOpen
        )))
    );
}

#[test]
fn review_gate_precedes_pool_availability_check() {
    let t = setup_gate();

    // The review gate runs before reserve is inspected, so an empty pool with
    // the gate enabled reports EvidenceRequired, not PoolEmpty.
    t.client.set_review_window_seconds(&100);
    let res = t.client.try_claim(&1, &t.lp);
    assert_eq!(
        res,
        Err(Ok(soroban_sdk::Error::from(
            InsuranceError::EvidenceRequired
        )))
    );
}

// ─────────────────────────────────────────────────────────────────────────
// Stale insurance state
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn raising_review_window_after_evidence_submission_delays_payout() {
    let t = setup_gate();
    fund_and_deposit(&t, COVERAGE);

    t.client.set_review_window_seconds(&100);
    t.client.submit_claim_evidence(&1, &evidence(&t.env, 0x11)); // t = 0

    // Governance raises the window *after* evidence was submitted. The gate
    // recomputes the maturity from the stored submission time, so the
    // original 100s no longer satisfies it.
    t.client.set_review_window_seconds(&1000);

    t.env.ledger().set_timestamp(100);
    assert_eq!(
        t.client.try_claim(&1, &t.lp),
        Err(Ok(soroban_sdk::Error::from(
            InsuranceError::ReviewWindowNotElapsed
        )))
    );

    t.env.ledger().set_timestamp(999);
    assert_eq!(
        t.client.try_claim(&1, &t.lp),
        Err(Ok(soroban_sdk::Error::from(
            InsuranceError::ReviewWindowNotElapsed
        )))
    );

    // Only at the recomputed maturity does the payout proceed.
    t.env.ledger().set_timestamp(1000);
    assert!(t.client.claim(&1, &t.lp) > 0);
}

#[test]
fn lowering_review_window_after_evidence_submission_expedites_payout() {
    let t = setup_gate();
    fund_and_deposit(&t, COVERAGE);

    t.client.set_review_window_seconds(&10_000);
    t.client.submit_claim_evidence(&1, &evidence(&t.env, 0x22)); // t = 0

    // Governance shortens the window; the same evidence now matures far
    // sooner than the window configured at submission time.
    t.client.set_review_window_seconds(&10);
    t.env.ledger().set_timestamp(10);
    assert!(t.client.claim(&1, &t.lp) > 0);
}

#[test]
fn review_window_evidence_is_scoped_per_invoice() {
    let t = setup_gate();
    fund_and_deposit(&t, COVERAGE);
    t.client.set_review_window_seconds(&100);

    // Evidence recorded for invoice 1 must not unlock invoice 2.
    t.client.submit_claim_evidence(&1, &evidence(&t.env, 0x33));
    assert_eq!(
        t.client.try_claim(&2, &t.lp),
        Err(Ok(soroban_sdk::Error::from(
            InsuranceError::EvidenceRequired
        )))
    );
}

#[test]
fn disabling_review_window_restores_automatic_payout_flow() {
    let t = setup_gate();
    fund_and_deposit(&t, COVERAGE);

    t.client.set_review_window_seconds(&100);
    assert_eq!(
        t.client.try_claim(&1, &t.lp),
        Err(Ok(soroban_sdk::Error::from(
            InsuranceError::EvidenceRequired
        )))
    );

    // Setting the window back to 0 disables the gate entirely: the automatic
    // flow (no evidence required) returns.
    t.client.set_review_window_seconds(&0);
    assert!(t.client.claim(&1, &t.lp) > 0);
}

#[test]
fn solvency_circuit_is_sticky_until_admin_reset() {
    let t = setup_gate();
    fund_and_deposit(&t, 100);
    t.client.set_min_reserve_ratio_bps(&5000);
    let _ = t.client.claim(&1, &t.lp);
    assert!(t.client.is_solvency_circuit_open());

    // Additional funding does not clear the breaker — only governance can.
    fund_and_deposit(&t, 500);
    assert!(t.client.is_solvency_circuit_open());
    assert_eq!(t.client.get_pool_balance(), 500);

    t.client.reset_solvency_circuit();
    assert!(!t.client.is_solvency_circuit_open());

    // Resetting an already-closed breaker is a safe no-op.
    assert!(t.client.try_reset_solvency_circuit().is_ok());
}

#[test]
fn circuit_never_trips_while_min_reserve_ratio_is_zero() {
    let t = setup_gate();
    fund_and_deposit(&t, 100);

    // The default minimum is 0, which disables automatic tripping entirely —
    // an under-reserved pool is never auto-paused unless governance opts in.
    assert_eq!(t.client.get_min_reserve_ratio_bps(), 0);
    assert!(t.client.claim(&1, &t.lp) > 0);
    assert!(!t.client.is_solvency_circuit_open());
}

#[test]
fn reset_below_threshold_allows_one_payout_then_re_trips() {
    let t = setup_gate();
    fund_and_deposit(&t, 100);
    t.client.set_min_reserve_ratio_bps(&5000);
    let _ = t.client.claim(&1, &t.lp);
    assert!(t.client.is_solvency_circuit_open());

    // Manual override while the ratio is *still* below the threshold.
    t.client.reset_solvency_circuit();
    assert!(!t.client.is_solvency_circuit_open());

    // It buys exactly one more payout, after which the breaker re-trips.
    fund_and_deposit(&t, 200);
    assert!(t.client.claim(&2, &t.lp) > 0);
    assert!(t.client.is_solvency_circuit_open());

    assert_eq!(
        t.client.try_claim(&3, &t.lp),
        Err(Ok(soroban_sdk::Error::from(
            InsuranceError::SolvencyCircuitOpen
        )))
    );
}

// ─────────────────────────────────────────────────────────────────────────
// Denied funding / claims
// ─────────────────────────────────────────────────────────────────────────

#[test]
fn circuit_open_denies_claims_without_moving_state_but_allows_funding() {
    let t = setup_gate();
    fund_and_deposit(&t, 100);
    t.client.set_min_reserve_ratio_bps(&5000);
    let _ = t.client.claim(&1, &t.lp);
    assert!(t.client.is_solvency_circuit_open());

    // Funding continues while the breaker is open.
    let new_lp = Address::generate(&t.env);
    t.client.enroll(&new_lp);
    t.token_admin.mint(&new_lp, &250);
    t.client.deposit_premium(&new_lp, &250);
    assert_eq!(t.client.get_pool_balance(), 250);

    // A denied claim leaves pool balance, the claimed flag and the pool's
    // token balance untouched.
    let balance_before = t.client.get_pool_balance();
    let pool_tokens_before = t.token.balance(&t.client.address);
    assert_eq!(
        t.client.try_claim(&99, &t.lp),
        Err(Ok(soroban_sdk::Error::from(
            InsuranceError::SolvencyCircuitOpen
        )))
    );
    assert_eq!(t.client.get_pool_balance(), balance_before);
    assert_eq!(t.token.balance(&t.client.address), pool_tokens_before);
    assert!(!t.client.is_claimed(&99));
}

#[test]
fn balance_cap_rejection_rolls_back_all_state() {
    let t = setup_gate();
    t.client.set_balance_cap(&100);
    fund_and_deposit(&t, 100);
    assert_eq!(t.client.get_pool_balance(), 100);
    assert_eq!(t.client.get_premiums_paid(&t.lp), 100);

    // One more stroop would breach the cap.
    t.token_admin.mint(&t.lp, &1);
    assert!(t.client.try_deposit_premium(&t.lp, &1).is_err());

    // The whole deposit rolled back: pool balance, LP premium accounting and
    // both token balances are exactly as before the rejected call.
    assert_eq!(t.client.get_pool_balance(), 100);
    assert_eq!(t.client.get_premiums_paid(&t.lp), 100);
    assert_eq!(t.token.balance(&t.client.address), 100);
    assert_eq!(t.token.balance(&t.lp), 1);
}

#[test]
fn balance_cap_bounds_liquid_balance_only_not_backstop() {
    let t = setup_gate();
    t.client.set_balance_cap(&100);

    // With all premium routed to the backstop the liquid balance stays 0, so
    // the cap never binds — even for a deposit far above it.
    t.client.set_backstop_funding_bps(&10_000);
    fund_and_deposit(&t, 1000);
    assert_eq!(t.client.get_pool_balance(), 0);
    assert_eq!(t.client.get_backstop_balance(), 1000);
    assert_eq!(t.client.get_balance_cap(), Some(100));

    // A partial split that pushes the liquid balance past the cap is still
    // rejected, and the rejection rolls back the early `Premiums` write too.
    let t2 = setup_gate();
    t2.client.set_balance_cap(&100);
    t2.client.set_backstop_funding_bps(&5_000); // 50/50 split
    t2.token_admin.mint(&t2.lp, &1000);
    assert!(t2.client.try_deposit_premium(&t2.lp, &1000).is_err());

    assert_eq!(t2.client.get_pool_balance(), 0);
    assert_eq!(t2.client.get_backstop_balance(), 0);
    assert_eq!(t2.client.get_premiums_paid(&t2.lp), 0);
}
