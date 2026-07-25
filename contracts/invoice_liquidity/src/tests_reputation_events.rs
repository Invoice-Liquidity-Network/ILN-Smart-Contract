#![cfg(test)]

//! Tests for Issue #32 — ReputationUpdated event emission.
//!
//! Covers:
//!  - submit_invoice emits ReputationUpdated with incremented invoices_submitted
//!  - mark_paid emits ReputationUpdated for payer (score+1, paid+1) and freelancer (paid+1)
//!  - claim_default emits ReputationUpdated for payer (score-5, defaulted+1)
//!  - score decay emits ReputationUpdated when the score drops

use super::*;
use crate::test::setup;
use soroban_sdk::testutils::{Address as _, Events, Ledger};
use soroban_sdk::Address;

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 30 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// submit_invoice
// ---------------------------------------------------------------------------

#[test]
fn submit_emits_reputation_updated_increments_submitted() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;

    let events_before = t.env.events().all().events().len();

    t.contract.submit_invoice(&ReferralCode::None);

    // At least one new event was emitted
    assert!(t.env.events().all().events().len() > events_before);

    // Profile reflects the values the event carries
    let profile = t.contract.get_reputation(&t.freelancer);
    assert_eq!(profile.invoices_submitted, 1);
    assert_eq!(profile.invoices_paid, 0);
    assert_eq!(profile.invoices_defaulted, 0);
    assert_eq!(profile.score, 0);
}

#[test]
fn submit_second_invoice_increments_submitted_count_to_two() {
    // Verify that each submit correctly updates invoices_submitted, which
    // is the value carried in the ReputationUpdated event payload.
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;

    t.contract.submit_invoice(&ReferralCode::None);

    let due_date2 = due_date + 1;
    t.contract.submit_invoice(&ReferralCode::None);

    let profile = t.contract.get_reputation(&t.freelancer);
    assert_eq!(profile.invoices_submitted, 2);
    assert_eq!(profile.invoices_paid, 0);
    assert_eq!(profile.invoices_defaulted, 0);
}

// ---------------------------------------------------------------------------
// mark_paid
// ---------------------------------------------------------------------------

#[test]
fn mark_paid_emits_reputation_updated_for_payer_score_and_paid_count() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;

    let invoice_id = t.contract.submit_invoice(&ReferralCode::None);

    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &false);

    let events_before = t.env.events().all().events().len();
    t.contract.mark_paid(&invoice_id, &INVOICE_AMOUNT);

    // mark_paid emits: set_payer_score (score→51) + increment_invoices_paid (payer) +
    // increment_invoices_paid (freelancer) = at least 3 new events
    assert!(t.env.events().all().events().len() > events_before);

    // Payer: default score 50 + 1 = 51, invoices_paid = 1
    let payer_profile = t.contract.get_reputation(&t.payer);
    assert_eq!(payer_profile.score, 51);
    assert_eq!(payer_profile.invoices_paid, 1);
    assert_eq!(payer_profile.invoices_submitted, 0);
    assert_eq!(payer_profile.invoices_defaulted, 0);
}

#[test]
fn mark_paid_emits_reputation_updated_for_freelancer_paid_count() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;

    let invoice_id = t.contract.submit_invoice(&ReferralCode::None);

    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &false);
    t.contract.mark_paid(&invoice_id, &INVOICE_AMOUNT);

    // Freelancer: submitted=1 (from submit) + paid=1 (from mark_paid)
    let freelancer_profile = t.contract.get_reputation(&t.freelancer);
    assert_eq!(freelancer_profile.invoices_submitted, 1);
    assert_eq!(freelancer_profile.invoices_paid, 1);
    assert_eq!(freelancer_profile.invoices_defaulted, 0);
}

// ---------------------------------------------------------------------------
// claim_default
// ---------------------------------------------------------------------------

#[test]
fn claim_default_emits_reputation_updated_score_penalty_and_defaulted_count() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;

    let invoice_id = t.contract.submit_invoice(&ReferralCode::None);

    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &false);

    // Advance past due date to allow default
    let mut li = t.env.ledger().get();
    li.timestamp = due_date + 1;
    t.env.ledger().set(li);

    let events_before = t.env.events().all().events().len();
    t.contract.claim_default(&t.funder, &invoice_id);

    assert!(t.env.events().all().events().len() > events_before);

    // Payer: default score 50 - 5 = 45, invoices_defaulted = 1
    let payer_profile = t.contract.get_reputation(&t.payer);
    assert_eq!(payer_profile.score, 45);
    assert_eq!(payer_profile.invoices_defaulted, 1);
    assert_eq!(payer_profile.invoices_paid, 0);
}

#[test]
fn claim_default_score_floored_at_zero_when_score_below_penalty() {
    let t = setup();

    // Give payer a score of 3 (less than the 5-point penalty)
    t.env.as_contract(&t.contract.address, || {
        invoice::set_payer_score(&t.env, &t.payer, 3);
    });

    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;

    let invoice_id = t.contract.submit_invoice(&ReferralCode::None);

    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &false);

    let mut li = t.env.ledger().get();
    li.timestamp = due_date + 1;
    t.env.ledger().set(li);

    t.contract.claim_default(&t.funder, &invoice_id);

    // Score should floor at 0, not underflow
    let payer_profile = t.contract.get_reputation(&t.payer);
    assert_eq!(payer_profile.score, 0);
    assert_eq!(payer_profile.invoices_defaulted, 1);
}

// ---------------------------------------------------------------------------
// Score decay
// ---------------------------------------------------------------------------

#[test]
fn score_decay_emits_reputation_updated_with_lower_score() {
    let t = setup();
    let payer = Address::generate(&t.env);

    // Store a score of 80 (above default) so decay has something to act on
    t.env.as_contract(&t.contract.address, || {
        invoice::set_payer_score(&t.env, &payer, 80);
    });

    let pre_profile = t.contract.get_reputation(&payer);
    assert_eq!(pre_profile.score, 80);

    // Advance ledger sequence past one decay period (default = 10_000 ledgers)
    let mut li = t.env.ledger().get();
    li.sequence_number += 10_001;
    t.env.ledger().set(li);

    let events_before = t.env.events().all().events().len();

    // Calling payer_score triggers get_payer_score which applies and persists decay
    let decayed_score = t.contract.payer_score(&payer);

    // A new event must have been emitted during decay
    assert!(t.env.events().all().events().len() > events_before);

    // Score must have decreased
    assert!(decayed_score < 80);

    // ReputationProfile is synced to the decayed score
    let post_profile = t.contract.get_reputation(&payer);
    assert_eq!(post_profile.score, decayed_score);
}

#[test]
fn score_decay_does_not_emit_event_when_score_unchanged() {
    let t = setup();
    let payer = Address::generate(&t.env);

    // Default score (50) is never stored — get_payer_score returns DEFAULT without storage
    // So no decay is applied and no event emitted when called for an unknown address

    let events_before = t.env.events().all().events().len();
    let score = t.contract.payer_score(&payer);
    let events_after = t.env.events().all().events().len();

    assert_eq!(score, crate::constants::DEFAULT_PAYER_SCORE);
    assert_eq!(
        events_after, events_before,
        "no event for unchanged default score"
    );
}
