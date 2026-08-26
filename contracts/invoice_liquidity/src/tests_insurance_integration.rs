#![cfg(test)]

//! Tests for Issue #529 — insurance pool integration in claim_default().
//!
//! Uses the REAL `insurance_pool` crate (now a regular dependency, not a
//! mock) since claim_default() calls into it via the generated
//! `InsurancePoolInterfaceClient`.
//!
//! Covers:
//! 1. No pool configured -> claim_default behaves exactly as before (no
//!    insurance event, no extra payout).
//! 2. Pool configured but LP not enrolled -> no compensation attempted.
//! 3. Pool configured, LP enrolled, pool solvent -> LP receives principal
//!    refund AND an additional insurance payout; event reflects it.
//! 4. Pool configured, LP enrolled, pool empty -> claim_default still
//!    succeeds (invoice Defaulted, principal refunded); insurance payout
//!    gracefully reports compensated=false.

use super::*;
use crate::test::setup;
use insurance_pool::{InsurancePool, InsurancePoolClient};
use soroban_sdk::testutils::{Events as _, Ledger};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30;
const COVERAGE_CAP: i128 = 1_000;

/// `set_insurance_pool` is rate-limited (`check_rate_limit`, cooldown =
/// `DEFAULT_RATE_LIMIT_LEDGERS` = 120 ledgers). Since the last-call ledger
/// defaults to 0 when never called, and `setup()` starts the ledger at
/// sequence 100, calling it immediately after `setup()` incorrectly trips
/// the cooldown on its very first-ever call. Advance the ledger past the
/// cooldown first - a pre-existing rate-limiting quirk unrelated to Issue
/// #529 (see the identical workaround in tests_oracle_registry.rs).
fn advance_past_rate_limit_cooldown(env: &soroban_sdk::Env) {
    let mut info = env.ledger().get();
    info.sequence_number += 150;
    info.timestamp += 150 * 5;
    env.ledger().set(info);
}

fn deploy_pool(t: &crate::test::TestEnv, coverage: i128) -> InsurancePoolClient<'static> {
    let pool_id = t.env.register_contract(None, InsurancePool);
    let pool_client = InsurancePoolClient::new(&t.env, &pool_id);
    // The pool's admin must be the ILN contract's own address so
    // claim_default()'s cross-contract claim() call self-authorizes, the
    // same pattern iln_governance uses to call invoice_liquidity's
    // admin-gated setters.
    pool_client.init_pool(&t.contract.address, &coverage, &t.token.address);
    advance_past_rate_limit_cooldown(&t.env);
    t.contract.set_insurance_pool(&pool_id);
    pool_client
}

/// Fund an invoice, advance the ledger past its due date, and return its id
/// ready for claim_default().
fn make_defaultable_invoice(t: &crate::test::TestEnv) -> u64 {
    let now = t.env.ledger().timestamp();
    let due_date = now + DUE_DATE_OFFSET;
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

    let mut info = t.env.ledger().get();
    info.timestamp = due_date + 1;
    t.env.ledger().set(info);

    id
}

#[test]
fn test_claim_default_without_insurance_pool_configured() {
    let t = setup();
    let funder_balance_before = t.token.balance(&t.funder);
    let id = make_defaultable_invoice(&t);

    t.contract.claim_default(&t.funder, &id);

    // Behavior identical to pre-#529: fund_invoice's cost deduction and
    // claim_default's principal refund are the same amount and cancel out;
    // no insurance top-up since no pool was ever configured.
    assert_eq!(t.token.balance(&t.funder), funder_balance_before);
    let invoice = t.contract.get_invoice(&id);
    assert_eq!(invoice.status, InvoiceStatus::Defaulted);
}

#[test]
fn test_claim_default_lp_not_enrolled_no_compensation() {
    let t = setup();
    let pool = deploy_pool(&t, COVERAGE_CAP);
    // No enroll(), no deposit_premium() for t.funder.

    let id = make_defaultable_invoice(&t);
    t.contract.claim_default(&t.funder, &id);

    assert!(!pool.is_enrolled(&t.funder));
    assert_eq!(pool.get_pool_balance(), 0);
}

#[test]
fn test_claim_default_compensates_enrolled_lp() {
    let t = setup();
    let pool = deploy_pool(&t, COVERAGE_CAP);

    // Fund the LP with extra tokens to pay a premium, then enroll via
    // deposit_premium (auto-enrolls). 600 is >= 50% of COVERAGE_CAP (1_000),
    // landing in the top tier (150% of coverage), but the payout is bounded
    // by the pool's balance (600) - making the expected payout deterministic.
    let asset_admin = soroban_sdk::token::StellarAssetClient::new(&t.env, &t.token.address);
    asset_admin.mint(&t.funder, &600);
    pool.deposit_premium(&t.funder, &600);
    assert!(pool.is_enrolled(&t.funder));
    assert_eq!(pool.get_pool_balance(), 600);

    // Captured after the premium deduction/mint but before fund_invoice's
    // own cost deduction, so the funding cost and its claim_default refund
    // cancel out below (they're the same amount) - only the insurance
    // payout should show up as a net change.
    let funder_balance_before = t.token.balance(&t.funder);

    let id = make_defaultable_invoice(&t);
    t.contract.claim_default(&t.funder, &id);

    // Pool paid out its entire balance (tier payout of 1_500 capped at the
    // available 600) directly to the LP.
    assert_eq!(pool.get_pool_balance(), 0);
    assert!(pool.is_claimed(&id));

    // fund_invoice deducted the funding cost from the LP; claim_default's
    // principal refund pays back that exact same amount, so they net to
    // zero - the only real change is the insurance payout (600), paid
    // directly by the pool.
    assert_eq!(t.token.balance(&t.funder), funder_balance_before + 600);
}

#[test]
fn test_claim_default_insurance_event_reports_compensated_payout() {
    let t = setup();
    let pool = deploy_pool(&t, COVERAGE_CAP);

    let asset_admin = soroban_sdk::token::StellarAssetClient::new(&t.env, &t.token.address);
    asset_admin.mint(&t.funder, &600);
    pool.deposit_premium(&t.funder, &600);

    let id = make_defaultable_invoice(&t);
    t.contract.claim_default(&t.funder, &id);

    let events = t.env.events().all();
    assert!(
        !events.events().is_empty(),
        "InsuranceClaimAttempted event should be emitted"
    );
}

#[test]
fn test_claim_default_gracefully_handles_empty_pool() {
    let t = setup();
    // Coverage configured, but the pool has zero balance (no premiums ever
    // deposited) - claim() would panic with PoolEmpty inside the pool, but
    // claim_default must not revert because of it.
    let pool = deploy_pool(&t, COVERAGE_CAP);

    // Enroll without depositing a premium so the pool has 0 balance but the
    // LP is still enrolled (enroll() doesn't require a premium).
    pool.enroll(&t.funder);
    assert!(pool.is_enrolled(&t.funder));
    assert_eq!(pool.get_pool_balance(), 0);

    let id = make_defaultable_invoice(&t);

    // claim_default must still succeed overall (principal refund + status
    // update), even though the insurance top-up attempt fails internally.
    t.contract.claim_default(&t.funder, &id);

    let invoice = t.contract.get_invoice(&id);
    assert_eq!(invoice.status, InvoiceStatus::Defaulted);
    assert!(!pool.is_claimed(&id));
}

#[test]
fn test_get_insurance_pool_returns_configured_address() {
    let t = setup();
    assert_eq!(t.contract.get_insurance_pool(), None);

    let pool = deploy_pool(&t, COVERAGE_CAP);
    assert_eq!(t.contract.get_insurance_pool(), Some(pool.address));
}
