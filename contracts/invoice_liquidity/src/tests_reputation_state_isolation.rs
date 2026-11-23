#![cfg(test)]

//! ADR-011 — reputation state is independent across contracts.
//!
//! Asserts the documented relationship: `invoice_liquidity` and
//! `reputation_bonus` each maintain their own reputation storage for the
//! same address. Updating one never mutates the other (no sync, no
//! double-counting of a single protocol event).
//!
//! # Intra-contract isolation (LP / payer / invoice)
//!
//! The second half of this file pins the isolation rules *inside*
//! `invoice_liquidity` (verified against `invoice.rs` / `lib.rs`):
//!
//! * `LpScore(addr)`, `PayerScore(addr)` and `Reputation(addr)` are three
//!   separate persistent keys. An LP funding an invoice writes only the
//!   funder's `LpScore`; it never touches that address's `PayerScore` or
//!   `ReputationProfile`.
//! * `LpScore` is bumped (+1) only for the funder whose call *completes* the
//!   funding (`amount_funded == amount`). Earlier tranche providers are not
//!   credited.
//! * `mark_paid` writes the invoice's own payer (`PayerScore` + profile) and
//!   the invoice's freelancer (profile counter only). `claim_default` writes
//!   only the invoice's payer. No other address's state is read-modify-written.
//! * Replays (`mark_paid` on a `Paid` invoice, `claim_default` on a
//!   `Defaulted` one) and unauthorized callers (`claim_default` by a
//!   non-funder) revert and leave every score and profile untouched.
//!
//! Residual (not a finding): the freelancer's *score* is read from the same
//! `PayerScore` namespace as payers (`submitter_reputation`), so an address
//! acting as both freelancer and payer shares one score by design.

use super::*;
use crate::test::setup;
use reputation_bonus::{
    config::Config as RepBonusConfig, ReputationBonusContract, ReputationBonusContractClient,
};
use soroban_sdk::testutils::{Address as _, Ledger};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30;

#[test]
fn test_reputation_state_is_independent_across_contracts() {
    let t = setup();
    let address = t.payer.clone();

    // ── Deploy standalone reputation_bonus (own storage domain) ──────────
    let bonus_id = t.env.register_contract(None, ReputationBonusContract);
    let bonus = ReputationBonusContractClient::new(&t.env, &bonus_id);
    let bonus_admin = Address::generate(&t.env);
    bonus.init(&bonus_admin);
    bonus.set_config(&RepBonusConfig {
        high_rep_threshold: 80,
        bonus_bps: 200,
        min_discount_rate_bps: 100,
    });

    // Baseline: ILN ReputationProfile is zeroed until activity; payer_score
    // defaults to 50. Bonus module starts empty.
    let iln_before = t.contract.get_reputation(&address);
    let bonus_before = bonus.get_reputation(&address);
    assert_eq!(
        t.contract.payer_score(&address),
        50,
        "ILN default payer score"
    );
    assert_eq!(iln_before.score, 0, "ILN profile unset until first write");
    assert_eq!(bonus_before.score, 0, "bonus module empty profile");
    assert_eq!(bonus_before.invoices_submitted, 0);
    assert_eq!(iln_before.invoices_submitted, 0);

    // ── Mutate ILN only (submit + fund + mark paid) ───────────────────────
    let now = t.env.ledger().timestamp();
    let due_date = now + DUE_DATE_OFFSET;
    let id = t.contract.submit_invoice(
        &t.freelancer,
        &address,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);
    t.contract.mark_paid(&id, &INVOICE_AMOUNT);

    let iln_after_protocol = t.contract.get_reputation(&address);
    let bonus_unchanged = bonus.get_reputation(&address);
    assert_eq!(iln_after_protocol.invoices_paid, 1);
    assert_eq!(t.contract.payer_score(&address), 51);
    assert_eq!(
        bonus_unchanged, bonus_before,
        "reputation_bonus must ignore ILN lifecycle events (ADR-011)"
    );

    // ── Mutate reputation_bonus only ─────────────────────────────────────
    let freelancer = Address::generate(&t.env);
    let bonus_invoice = bonus.submit_invoice(
        &freelancer,
        &address,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
    );
    bonus.mark_paid(&bonus_invoice.id);

    let bonus_after = bonus.get_reputation(&address);
    let iln_after_bonus = t.contract.get_reputation(&address);
    let iln_payer_score_after_bonus = t.contract.payer_score(&address);

    assert_eq!(bonus_after.invoices_submitted, 1);
    assert_eq!(bonus_after.invoices_paid, 1);
    assert_eq!(bonus_after.score, 100);
    assert_eq!(
        iln_payer_score_after_bonus, 51,
        "ILN reputation must ignore reputation_bonus lifecycle events (ADR-011)"
    );
    assert_eq!(
        iln_after_bonus.invoices_paid, iln_after_protocol.invoices_paid,
        "ILN counters must not absorb bonus-module invoices"
    );

    // Same address, two stores, intentionally divergent — documented SoT split.
    assert_ne!(
        iln_payer_score_after_bonus, bonus_after.score,
        "divergence is expected; there is no reconciliation between contracts"
    );
}

/// Verify that multiple addresses' reputation states are independent across
/// contracts — updating address A in ILN does not touch address B in bonus.
#[test]
fn test_reputation_cross_address_independence() {
    let t = setup();
    let alice = Address::generate(&t.env);
    let bob = Address::generate(&t.env);

    let bonus_id = t.env.register_contract(None, ReputationBonusContract);
    let bonus = ReputationBonusContractClient::new(&t.env, &bonus_id);
    let bonus_admin = Address::generate(&t.env);
    bonus.init(&bonus_admin);
    bonus.set_config(&RepBonusConfig {
        high_rep_threshold: 80,
        bonus_bps: 200,
        min_discount_rate_bps: 100,
    });

    let now = t.env.ledger().timestamp();
    let due_date = now + DUE_DATE_OFFSET;

    // Submit + fund + pay an invoice for Alice in ILN
    let id = t.contract.submit_invoice(
        &t.freelancer,
        &alice,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);
    t.contract.mark_paid(&id, &INVOICE_AMOUNT);

    // Submit + pay an invoice for Bob in bonus module
    let bonus_invoice = bonus.submit_invoice(
        &t.freelancer,
        &bob,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
    );
    bonus.mark_paid(&bonus_invoice.id);

    // Verify isolation: ILN knows about Alice's payment, not Bob's
    let alice_iln = t.contract.get_reputation(&alice);
    let bob_iln = t.contract.get_reputation(&bob);
    assert_eq!(alice_iln.invoices_paid, 1, "ILN tracks Alice");
    assert_eq!(
        bob_iln.invoices_paid, 0,
        "ILN does NOT track Bob's bonus invoice"
    );

    // Verify isolation: bonus module knows about Bob's payment, not Alice's
    let alice_bonus = bonus.get_reputation(&alice);
    let bob_bonus = bonus.get_reputation(&bob);
    assert_eq!(
        alice_bonus.invoices_paid, 0,
        "bonus does NOT track Alice's ILN invoice"
    );
    assert_eq!(bob_bonus.invoices_paid, 1, "bonus tracks Bob");
}

/// Verify that the payer_score (used for protocol gates) reads exclusively
/// from invoice_liquidity, not from reputation_bonus.
#[test]
fn test_payer_score_reads_only_from_iln() {
    let t = setup();
    let address = t.payer.clone();

    let bonus_id = t.env.register_contract(None, ReputationBonusContract);
    let bonus = ReputationBonusContractClient::new(&t.env, &bonus_id);
    let bonus_admin = Address::generate(&t.env);
    bonus.init(&bonus_admin);
    bonus.set_config(&RepBonusConfig {
        high_rep_threshold: 80,
        bonus_bps: 200,
        min_discount_rate_bps: 100,
    });

    // Before any activity, payer_score defaults to 50
    assert_eq!(t.contract.payer_score(&address), 50);

    // Perform many successful payments in bonus module — should NOT affect ILN payer_score
    let now = t.env.ledger().timestamp();
    let due_date = now + DUE_DATE_OFFSET;
    for i in 0..10 {
        let inv_id = bonus.submit_invoice(
            &t.freelancer,
            &address,
            &INVOICE_AMOUNT,
            &due_date,
            &DISCOUNT_RATE,
        );
        bonus.mark_paid(&inv_id.id);
    }

    // bonus reputation should be 100 (10/10 paid)
    let bonus_rep = bonus.get_reputation(&address);
    assert_eq!(bonus_rep.score, 100);
    assert_eq!(bonus_rep.invoices_paid, 10);

    // But ILN payer_score must still be 50 (default, no ILN activity)
    assert_eq!(
        t.contract.payer_score(&address),
        50,
        "payer_score must not be influenced by reputation_bonus activity (ADR-011)"
    );
}

/// Verify that default/appeal events in ILN do not leak into reputation_bonus.
#[test]
fn test_iln_default_does_not_affect_bonus() {
    let t = setup();
    let address = t.payer.clone();

    let bonus_id = t.env.register_contract(None, ReputationBonusContract);
    let bonus = ReputationBonusContractClient::new(&t.env, &bonus_id);
    let bonus_admin = Address::generate(&t.env);
    bonus.init(&bonus_admin);
    bonus.set_config(&RepBonusConfig {
        high_rep_threshold: 80,
        bonus_bps: 200,
        min_discount_rate_bps: 100,
    });

    let now = t.env.ledger().timestamp();
    let due_date = now + DUE_DATE_OFFSET;

    // Submit an invoice in bonus module (to establish a non-zero baseline)
    let bonus_inv = bonus.submit_invoice(
        &t.freelancer,
        &address,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
    );
    bonus.mark_paid(&bonus_inv.id);
    let bonus_before = bonus.get_reputation(&address);
    assert_eq!(bonus_before.invoices_paid, 1);

    // Now submit + fund + default an invoice in ILN
    let iln_id = t.contract.submit_invoice(
        &t.freelancer,
        &address,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    t.contract
        .fund_invoice(&t.funder, &iln_id, &INVOICE_AMOUNT, &false);

    // Advance past due date to allow claiming default
    let mut ledger_info = t.env.ledger().get();
    ledger_info.timestamp = now + DUE_DATE_OFFSET + 1;
    t.env.ledger().set(ledger_info);

    t.contract.claim_default(&t.funder, &iln_id);

    // bonus module must be untouched by ILN default
    let bonus_after = bonus.get_reputation(&address);
    assert_eq!(
        bonus_after, bonus_before,
        "reputation_bonus must not be affected by ILN default events (ADR-011)"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Intra-contract isolation: one LP / payer / invoice cannot mutate another's
// reputation state.
// ─────────────────────────────────────────────────────────────────────────────

fn new_lp(t: &crate::test::TestEnv) -> Address {
    let lp = Address::generate(&t.env);
    soroban_sdk::token::StellarAssetClient::new(&t.env, &t.token.address)
        .mint(&lp, &(INVOICE_AMOUNT * 10));
    lp
}

fn new_payer(t: &crate::test::TestEnv) -> Address {
    let payer = Address::generate(&t.env);
    soroban_sdk::token::StellarAssetClient::new(&t.env, &t.token.address)
        .mint(&payer, &(INVOICE_AMOUNT * 10));
    payer
}

fn submit(t: &crate::test::TestEnv, payer: &Address) -> u64 {
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    t.contract.submit_invoice(
        &t.freelancer,
        payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    )
}

fn submit_and_fund(t: &crate::test::TestEnv, payer: &Address, lp: &Address) -> u64 {
    let id = submit(t, payer);
    t.contract.fund_invoice(lp, &id, &INVOICE_AMOUNT, &false);
    id
}

fn warp_past_due(t: &crate::test::TestEnv, id: u64) {
    let due = u64::from(t.contract.get_invoice(&id).due_date);
    let mut ledger_info = t.env.ledger().get();
    ledger_info.timestamp = due + 1;
    t.env.ledger().set(ledger_info);
}

/// Funding an invoice credits only the funding LP's `LpScore`.
#[test]
fn test_lp_funding_only_changes_that_lps_score() {
    let t = setup();
    let lp_a = new_lp(&t);
    let lp_b = new_lp(&t);
    let payer = new_payer(&t);

    submit_and_fund(&t, &payer, &lp_a);

    assert_eq!(t.contract.lp_score(&lp_a), 51, "funder is credited once");
    assert_eq!(t.contract.lp_score(&lp_b), 50, "other LP untouched");
    assert_eq!(t.contract.lp_score(&payer), 50, "payer's LP score untouched");
    assert_eq!(
        t.contract.lp_score(&t.freelancer),
        50,
        "freelancer's LP score untouched"
    );
}

/// `LpScore` is a separate namespace from `PayerScore` and `ReputationProfile`.
#[test]
fn test_lp_funding_does_not_touch_lp_payer_score_or_profile() {
    let t = setup();
    let lp = new_lp(&t);
    let payer = new_payer(&t);

    let profile_before = t.contract.get_reputation(&lp);
    submit_and_fund(&t, &payer, &lp);

    assert_eq!(t.contract.lp_score(&lp), 51);
    assert_eq!(
        t.contract.payer_score(&lp),
        50,
        "LP activity must not move the same address's payer score"
    );
    assert_eq!(
        t.contract.get_reputation(&lp),
        profile_before,
        "LP activity must not write the ReputationProfile"
    );
    // The payer on the funded invoice is not credited for being funded.
    assert_eq!(t.contract.payer_score(&payer), 50);
    assert_eq!(t.contract.get_reputation(&payer).invoices_paid, 0);
}

/// With split funding only the LP whose tranche completes the invoice is
/// credited; the earlier tranche provider is not.
#[test]
fn test_split_funding_credits_only_the_completing_lp() {
    let t = setup();
    let lp_a = new_lp(&t);
    let lp_b = new_lp(&t);
    let payer = new_payer(&t);

    let id = submit(&t, &payer);
    t.contract
        .fund_invoice(&lp_a, &id, &(INVOICE_AMOUNT / 2), &false);
    assert_eq!(t.contract.lp_score(&lp_a), 50, "partial tranche is not credited");
    assert_eq!(t.contract.lp_score(&lp_b), 50);

    t.contract
        .fund_invoice(&lp_b, &id, &(INVOICE_AMOUNT / 2), &false);
    assert_eq!(t.contract.lp_score(&lp_a), 50, "earlier tranche never retro-credited");
    assert_eq!(t.contract.lp_score(&lp_b), 51, "completing LP credited once");
}

/// Paying one payer's invoice mutates only that payer (score + profile) and
/// the invoice's freelancer counter; a different payer and LP are untouched.
#[test]
fn test_mark_paid_does_not_mutate_other_payers_or_lps() {
    let t = setup();
    let lp = new_lp(&t);
    let payer_a = new_payer(&t);
    let payer_b = new_payer(&t);

    let id_a = submit_and_fund(&t, &payer_a, &lp);
    let id_b = submit_and_fund(&t, &payer_b, &lp);

    let b_profile_before = t.contract.get_reputation(&payer_b);
    let lp_profile_before = t.contract.get_reputation(&lp);
    let lp_score_before = t.contract.lp_score(&lp);

    t.contract.mark_paid(&id_a, &INVOICE_AMOUNT);

    assert_eq!(t.contract.payer_score(&payer_a), 51);
    assert_eq!(t.contract.get_reputation(&payer_a).invoices_paid, 1);

    assert_eq!(t.contract.payer_score(&payer_b), 50, "other payer score untouched");
    assert_eq!(
        t.contract.get_reputation(&payer_b),
        b_profile_before,
        "other payer profile untouched"
    );
    assert_eq!(
        t.contract.get_reputation(&lp),
        lp_profile_before,
        "LP profile untouched by settlement"
    );
    assert_eq!(
        t.contract.lp_score(&lp),
        lp_score_before,
        "LP score is not re-credited at settlement"
    );
    // Invoice-level isolation: payer B's invoice is still open.
    assert_eq!(
        t.contract.get_invoice(&id_b).status,
        InvoiceStatus::Funded
    );
}

/// A default penalises only the defaulting invoice's payer and never the LP,
/// the freelancer's score, or another payer.
#[test]
fn test_default_only_penalises_the_invoices_payer() {
    let t = setup();
    let lp = new_lp(&t);
    let payer_a = new_payer(&t);
    let payer_b = new_payer(&t);

    let id_a = submit_and_fund(&t, &payer_a, &lp);
    let id_b = submit_and_fund(&t, &payer_b, &lp);
    let lp_score_before = t.contract.lp_score(&lp);
    let b_profile_before = t.contract.get_reputation(&payer_b);

    warp_past_due(&t, id_a);
    t.contract.claim_default(&lp, &id_a);

    assert_eq!(t.contract.payer_score(&payer_a), 45);
    assert_eq!(t.contract.get_reputation(&payer_a).invoices_defaulted, 1);

    assert_eq!(t.contract.payer_score(&payer_b), 50);
    assert_eq!(t.contract.get_reputation(&payer_b), b_profile_before);
    assert_eq!(t.contract.lp_score(&lp), lp_score_before, "LP not penalised");
    assert_eq!(t.contract.get_reputation(&lp).invoices_defaulted, 0);
    assert_eq!(
        t.contract.get_invoice(&id_b).status,
        InvoiceStatus::Funded,
        "other payer's invoice state untouched"
    );

    // Top-payer ranking tracks only the payer whose score changed.
    let top = t.contract.get_top_payers(&10);
    assert!(top.iter().any(|e| e.address == payer_a && e.score == 45));
    assert!(!top.iter().any(|e| e.address == payer_b));
}

/// Replayed settlement / default calls revert and leave reputation untouched.
#[test]
fn test_replayed_lifecycle_calls_do_not_double_update_reputation() {
    let t = setup();
    let lp = new_lp(&t);
    let payer_paid = new_payer(&t);
    let payer_default = new_payer(&t);

    let id_paid = submit_and_fund(&t, &payer_paid, &lp);
    t.contract.mark_paid(&id_paid, &INVOICE_AMOUNT);
    let paid_profile = t.contract.get_reputation(&payer_paid);
    assert!(t.contract.try_mark_paid(&id_paid, &INVOICE_AMOUNT).is_err());
    assert_eq!(t.contract.payer_score(&payer_paid), 51);
    assert_eq!(t.contract.get_reputation(&payer_paid), paid_profile);

    let id_def = submit_and_fund(&t, &payer_default, &lp);
    warp_past_due(&t, id_def);
    t.contract.claim_default(&lp, &id_def);
    let default_profile = t.contract.get_reputation(&payer_default);
    assert!(t.contract.try_claim_default(&lp, &id_def).is_err());
    assert_eq!(t.contract.payer_score(&payer_default), 45, "penalty applied once");
    assert_eq!(t.contract.get_reputation(&payer_default), default_profile);
}

/// An LP that did not fund the invoice cannot trigger its default (and so
/// cannot mutate the payer's reputation).
#[test]
fn test_non_funder_cannot_default_another_lps_invoice() {
    let t = setup();
    let lp = new_lp(&t);
    let outsider = new_lp(&t);
    let payer = new_payer(&t);

    let id = submit_and_fund(&t, &payer, &lp);
    warp_past_due(&t, id);
    let profile_before = t.contract.get_reputation(&payer);

    assert!(t.contract.try_claim_default(&outsider, &id).is_err());

    assert_eq!(t.contract.payer_score(&payer), 50);
    assert_eq!(t.contract.get_reputation(&payer), profile_before);
    assert_eq!(t.contract.lp_score(&outsider), 50);
    assert_eq!(t.contract.get_invoice(&id).status, InvoiceStatus::Funded);
}

/// Pure reads are stable: querying scores/profiles repeatedly (no ledger
/// advance, so no decay) never changes them.
#[test]
fn test_reputation_reads_are_stable_and_side_effect_free() {
    let t = setup();
    let lp = new_lp(&t);
    let payer = new_payer(&t);
    let id = submit_and_fund(&t, &payer, &lp);
    t.contract.mark_paid(&id, &INVOICE_AMOUNT);

    let score = t.contract.payer_score(&payer);
    let profile = t.contract.get_reputation(&payer);
    let lp_score = t.contract.lp_score(&lp);
    for _ in 0..3 {
        assert_eq!(t.contract.payer_score(&payer), score);
        assert_eq!(t.contract.get_reputation(&payer), profile);
        assert_eq!(t.contract.lp_score(&lp), lp_score);
    }
}
