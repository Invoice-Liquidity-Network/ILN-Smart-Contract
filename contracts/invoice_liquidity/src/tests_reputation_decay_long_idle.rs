#![cfg(test)]

//! ADR-004 — lazy reputation decay multi-year idle coverage.
//!
//! Tests that simulate long idle periods (years of ledger time) to verify
//! no overflow, correct floor convergence, and proper decay behavior.
//!
//! The second half of the file audits **update conservation** of the payer
//! reputation paths in `lib.rs` (see `docs/reputation-update-conservation-audit.md`):
//!
//! * submission, payment and default each apply their update exactly once per
//!   lifecycle transition; replays revert before reaching the score code;
//! * score arithmetic is saturating / clamped (cap 100 on payment, floor 0 on
//!   default) and counter decrements saturate, so nothing underflows;
//! * partial payments never award score or `invoices_paid`;
//! * `resolve_appeal(upheld)` restores the *absolute* pre-default snapshot
//!   (verified residual behavior: interim score changes made after that
//!   snapshot are overwritten — pinned below, not changed).

use super::*;
use crate::constants::MAX_REPUTATION_DECAY_PERIODS;
use crate::test::setup;
use soroban_sdk::testutils::{Address as _, Ledger};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30;

/// Helper: submit, fund, and mark an invoice paid to establish a non-zero reputation.
fn establish_reputation(t: &crate::test::TestEnv, payer: &soroban_sdk::Address) {
    let now = t.env.ledger().timestamp();
    let due_date = now + DUE_DATE_OFFSET;
    let id = t.contract.submit_invoice(
        &t.freelancer,
        payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);
    t.contract.mark_paid(&id, &INVOICE_AMOUNT);
}

/// Helper: advance the ledger by `ledgers` sequences.
fn advance_ledgers(t: &crate::test::TestEnv, ledgers: u32) {
    let mut ledger_info = t.env.ledger().get();
    ledger_info.sequence_number += ledgers;
    t.env.ledger().set(ledger_info);
}

/// 1 year idle: ~63 periods (365 days * 24h * 12ledgers/h ≈ 105,120 ledgers
/// at 5s/ledger; decay_period = 259,200 ledgers ≈ 15 days).
/// 1 year ≈ 365/15 ≈ 24.3 periods.
/// Score should decay noticeably but not reach floor.
#[test]
fn test_one_year_idle_partial_decay() {
    let t = setup();
    let payer = t.payer.clone();

    establish_reputation(&t, &payer);
    let score_before = t.contract.payer_score(&payer);
    assert!(
        score_before > 50,
        "score should have increased after payment"
    );

    // Advance 1 year: ~24 decay periods
    let one_year_ledgers = (365 * 24 * 60 * 60 / 5) as u32; // ~6,307,200
    advance_ledgers(&t, one_year_ledgers);

    let score_after = t.contract.payer_score(&payer);
    assert!(
        score_after < score_before,
        "score should decay after 1 year idle"
    );
    assert!(
        score_after > 0,
        "score should not reach floor after just 1 year"
    );
}

/// 3 years idle: ~73 periods. Score should be significantly reduced.
#[test]
fn test_three_year_idle_significant_decay() {
    let t = setup();
    let payer = t.payer.clone();

    establish_reputation(&t, &payer);
    let score_before = t.contract.payer_score(&payer);

    // Advance 3 years: ~73 decay periods
    let three_year_ledgers = (3 * 365 * 24 * 60 * 60 / 5) as u32;
    advance_ledgers(&t, three_year_ledgers);

    let score_after = t.contract.payer_score(&payer);
    assert!(
        score_after < score_before,
        "score should decay after 3 years"
    );
    // With 0.5% decay per period, after 73 periods: 0.995^73 ≈ 0.69
    // So score should be roughly 69% of original.
    assert!(
        score_after > 0,
        "score should still be positive after 3 years"
    );
}

/// 10 years idle: ~244 periods. Score should be very low but still non-negative.
#[test]
fn test_ten_year_idle_deep_decay() {
    let t = setup();
    let payer = t.payer.clone();

    establish_reputation(&t, &payer);
    let score_before = t.contract.payer_score(&payer);

    // Advance 10 years: ~244 decay periods
    let ten_year_ledgers = (10 * 365 * 24 * 60 * 60 / 5) as u32;
    advance_ledgers(&t, ten_year_ledgers);

    let score_after = t.contract.payer_score(&payer);
    assert!(
        score_after < score_before,
        "score should decay heavily after 10 years"
    );
    // 0.995^244 ≈ 0.29 — score should be around 29% of original
    assert!(
        score_after < score_before / 2,
        "score should be less than half after 10 years"
    );
}

/// 100 years idle: ~2443 periods. Should hit the MAX_REPUTATION_DECAY_PERIODS
/// cap (1000) and short-circuit to 0.
#[test]
fn test_hundred_year_idle_floor() {
    let t = setup();
    let payer = t.payer.clone();

    establish_reputation(&t, &payer);

    // Advance 100 years: ~2,443,200 ledgers — way beyond MAX_REPUTATION_DECAY_PERIODS
    let hundred_year_ledgers = (100u64 * 365 * 24 * 60 * 60 / 5) as u32;
    advance_ledgers(&t, hundred_year_ledgers);

    let score_after = t.contract.payer_score(&payer);
    assert_eq!(
        score_after, 0,
        "score must converge to 0 after extreme idle (100 years)"
    );
}

/// Verify no overflow: even with maximum initial score (100) and the most
/// aggressive decay, the arithmetic never panics.
#[test]
fn test_decay_no_overflow_at_max_score() {
    let t = setup();
    let payer = t.payer.clone();

    establish_reputation(&t, &payer);

    // Manually set score to 100 (max)
    set_payer_score(&t.env, &payer, 100);
    assert_eq!(t.contract.payer_score(&payer), 100);

    // Advance 10 years — should not panic
    let ledgers = (10 * 365 * 24 * 60 * 60 / 5) as u32;
    advance_ledgers(&t, ledgers);

    let score = t.contract.payer_score(&payer);
    assert!(score <= 100, "score must never exceed 100");
    // score: u32 — cannot go negative (clippy absurd_extreme_comparisons)
}

/// Verify decay converges to 0 correctly (not stuck at 1).
/// With 0.5% decay per period, the score approaches 0 asymptotically.
/// The minimum-decay-of-1 rule ensures it eventually reaches 0.
#[test]
fn test_decay_converges_to_zero_not_stuck_at_one() {
    let t = setup();
    let payer = t.payer.clone();

    // Set score to 1 (the minimum non-zero score)
    set_payer_score(&t.env, &payer, 1);
    assert_eq!(t.contract.payer_score(&payer), 1);

    // Advance 1 period (decay_period_ledgers = 259,200)
    advance_ledgers(&t, 259_200);

    let score = t.contract.payer_score(&payer);
    // With score=1, decay_amount = 1 * 50 / 10000 = 0, but the minimum
    // decay of 1 kicks in, so score goes to 0.
    assert_eq!(
        score, 0,
        "score of 1 must decay to 0 in one period (min decay = 1)"
    );
}

/// Verify that a second activity resets the decay clock.
#[test]
fn test_activity_resets_decay_clock() {
    let t = setup();
    let payer = t.payer.clone();

    establish_reputation(&t, &payer);
    let score_after_first = t.contract.payer_score(&payer);

    // Advance 1 year — score decays
    let one_year = (365 * 24 * 60 * 60 / 5) as u32;
    advance_ledgers(&t, one_year);
    let score_after_idle = t.contract.payer_score(&payer);
    assert!(
        score_after_idle < score_after_first,
        "score should decay after idle"
    );

    // Perform another payment — score should increase and decay clock resets
    establish_reputation(&t, &payer);
    let score_after_second = t.contract.payer_score(&payer);
    assert!(
        score_after_second >= score_after_idle,
        "new activity should restore or increase score"
    );

    // Advance another year — should decay from the new baseline
    advance_ledgers(&t, one_year);
    let score_after_second_idle = t.contract.payer_score(&payer);
    assert!(
        score_after_second_idle < score_after_second,
        "score should decay again after second idle period"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Update conservation: underflow, duplicate updates, appeal restoration
// ─────────────────────────────────────────────────────────────────────────────

fn conservation_hash(env: &soroban_sdk::Env) -> soroban_sdk::BytesN<32> {
    soroban_sdk::BytesN::from_array(env, &[9u8; 32])
}

fn open_funded_invoice(t: &crate::test::TestEnv) -> u64 {
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);
    id
}

fn set_score_directly(t: &crate::test::TestEnv, score: u32) {
    t.env.as_contract(&t.contract.address, || {
        crate::invoice::set_payer_score(&t.env, &t.payer, score);
    });
}

fn warp_to_after_due(t: &crate::test::TestEnv, id: u64) {
    let due = u64::from(t.contract.get_invoice(&id).due_date);
    let mut ledger_info = t.env.ledger().get();
    ledger_info.timestamp = due + 1;
    t.env.ledger().set(ledger_info);
}

/// Payment at the score cap cannot overflow past 100; the counter still moves.
#[test]
fn test_payment_at_score_cap_stays_clamped() {
    let t = setup();
    set_score_directly(&t, 100);
    let id = open_funded_invoice(&t);

    t.contract.mark_paid(&id, &INVOICE_AMOUNT);

    assert_eq!(t.contract.payer_score(&t.payer), 100);
    let profile = t.contract.get_reputation(&t.payer);
    assert_eq!(profile.score, 100);
    assert_eq!(profile.invoices_paid, 1);
}

/// Default at or below the 5-point penalty floors at 0 (no u32 underflow),
/// and repeated defaults on distinct invoices keep it at 0.
#[test]
fn test_default_penalty_floors_at_zero_without_underflow() {
    let t = setup();
    set_score_directly(&t, 3);

    let first = open_funded_invoice(&t);
    warp_to_after_due(&t, first);
    t.contract.claim_default(&t.funder, &first);
    assert_eq!(t.contract.payer_score(&t.payer), 0);
    assert_eq!(t.contract.get_reputation(&t.payer).invoices_defaulted, 1);

    let second = open_funded_invoice(&t);
    warp_to_after_due(&t, second);
    t.contract.claim_default(&t.funder, &second);
    assert_eq!(t.contract.payer_score(&t.payer), 0);
    let profile = t.contract.get_reputation(&t.payer);
    assert_eq!(profile.invoices_defaulted, 2);
    assert_eq!(profile.score, 0);
}

/// A partial payment neither awards score nor counts as a paid invoice; only
/// the settling payment does, and only once.
#[test]
fn test_partial_payment_does_not_award_score_until_settled() {
    let t = setup();
    let id = open_funded_invoice(&t);

    t.contract.mark_paid(&id, &(INVOICE_AMOUNT / 2));
    assert_eq!(t.contract.payer_score(&t.payer), 50);
    assert_eq!(t.contract.get_reputation(&t.payer).invoices_paid, 0);
    assert_eq!(t.contract.get_reputation(&t.freelancer).invoices_paid, 0);

    t.contract.mark_paid(&id, &(INVOICE_AMOUNT / 2));
    assert_eq!(t.contract.payer_score(&t.payer), 51);
    assert_eq!(t.contract.get_reputation(&t.payer).invoices_paid, 1);
    assert_eq!(t.contract.get_reputation(&t.freelancer).invoices_paid, 1);

    // Replay after settlement reverts and awards nothing further.
    assert!(t.contract.try_mark_paid(&id, &1).is_err());
    assert_eq!(t.contract.payer_score(&t.payer), 51);
    assert_eq!(t.contract.get_reputation(&t.payer).invoices_paid, 1);
}

/// Invalid inputs revert before any reputation write.
#[test]
fn test_rejected_calls_leave_reputation_untouched() {
    let t = setup();
    let id = open_funded_invoice(&t);
    let payer_before = t.contract.get_reputation(&t.payer);
    let freelancer_before = t.contract.get_reputation(&t.freelancer);

    assert!(t.contract.try_mark_paid(&id, &0).is_err(), "zero amount");
    assert!(
        t.contract
            .try_mark_paid(&id, &(INVOICE_AMOUNT + 1))
            .is_err(),
        "overpayment"
    );
    // Default before the due date is rejected.
    assert!(t.contract.try_claim_default(&t.funder, &id).is_err());

    assert_eq!(t.contract.get_reputation(&t.payer), payer_before);
    assert_eq!(t.contract.get_reputation(&t.freelancer), freelancer_before);
    assert_eq!(t.contract.payer_score(&t.payer), 50);
}

/// Self-invoices are rejected, so a single address can never receive both the
/// payer and the freelancer counter update for one event.
#[test]
fn test_self_invoice_cannot_double_count_reputation() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let res = t.contract.try_submit_invoice(
        &t.payer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    assert!(res.is_err());
    assert_eq!(t.contract.get_reputation(&t.payer).invoices_submitted, 0);
}

/// An appeal can be filed once and resolved once; replays revert and the
/// restore / decrement is not applied a second time.
#[test]
fn test_appeal_resolution_is_applied_exactly_once() {
    let t = setup();
    let id = open_funded_invoice(&t);
    warp_to_after_due(&t, id);
    t.contract.claim_default(&t.funder, &id);
    assert_eq!(t.contract.payer_score(&t.payer), 45);

    t.contract.appeal_default(&id, &conservation_hash(&t.env));
    assert!(t
        .contract
        .try_appeal_default(&id, &conservation_hash(&t.env))
        .is_err());

    t.contract.resolve_appeal(&id, &true);
    assert_eq!(t.contract.payer_score(&t.payer), 50);
    assert_eq!(t.contract.get_reputation(&t.payer).invoices_defaulted, 0);

    assert!(t.contract.try_resolve_appeal(&id, &true).is_err());
    assert!(t.contract.try_claim_default(&t.funder, &id).is_err());
    assert_eq!(t.contract.payer_score(&t.payer), 50);
    assert_eq!(
        t.contract.get_reputation(&t.payer).invoices_defaulted,
        0,
        "defaulted counter must not underflow or re-decrement"
    );
}

/// Verified residual (pinned, not changed): an upheld appeal restores the
/// absolute pre-default snapshot, so a score gained *after* the default is
/// overwritten.
#[test]
fn test_upheld_appeal_overwrites_interim_score_gain() {
    let t = setup();
    let defaulted = open_funded_invoice(&t);
    let paid_later = open_funded_invoice(&t);
    warp_to_after_due(&t, defaulted);

    t.contract.claim_default(&t.funder, &defaulted);
    assert_eq!(t.contract.payer_score(&t.payer), 45);

    t.contract.mark_paid(&paid_later, &INVOICE_AMOUNT);
    assert_eq!(t.contract.payer_score(&t.payer), 46);

    t.contract.appeal_default(&defaulted, &conservation_hash(&t.env));
    t.contract.resolve_appeal(&defaulted, &true);

    assert_eq!(
        t.contract.payer_score(&t.payer),
        50,
        "snapshot (50) replaces 46; the interim +1 is not preserved (45 + 5 + 1 = 51)"
    );
    let profile = t.contract.get_reputation(&t.payer);
    assert_eq!(profile.score, 50);
    assert_eq!(profile.invoices_paid, 1, "history counters are unaffected");
    assert_eq!(profile.invoices_defaulted, 0);
}

/// Verified residual (pinned, not changed): with two defaults the restored
/// score depends on resolution order because each appeal stores its own
/// absolute snapshot (A: 50, B: 45). Counters stay exact in either order.
#[test]
fn test_two_upheld_appeals_restore_snapshots_in_resolution_order() {
    let t = setup();
    let a = open_funded_invoice(&t);
    let b = open_funded_invoice(&t);
    warp_to_after_due(&t, a);

    t.contract.claim_default(&t.funder, &a);
    t.contract.claim_default(&t.funder, &b);
    assert_eq!(t.contract.payer_score(&t.payer), 40);
    assert_eq!(t.contract.get_reputation(&t.payer).invoices_defaulted, 2);

    t.contract.appeal_default(&a, &conservation_hash(&t.env));
    t.contract.appeal_default(&b, &conservation_hash(&t.env));

    t.contract.resolve_appeal(&a, &true);
    assert_eq!(t.contract.payer_score(&t.payer), 50, "A snapshot");
    assert_eq!(t.contract.get_reputation(&t.payer).invoices_defaulted, 1);

    t.contract.resolve_appeal(&b, &true);
    assert_eq!(t.contract.payer_score(&t.payer), 45, "B snapshot");
    assert_eq!(t.contract.get_reputation(&t.payer).invoices_defaulted, 0);
}
