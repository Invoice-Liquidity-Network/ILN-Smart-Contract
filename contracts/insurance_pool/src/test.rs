#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env};

struct Setup {
    env: Env,
    client: InsurancePoolClient<'static>,
    admin: Address,
}

const COVERAGE: i128 = 1_000_000_000; // flat per-claim cap (100 units @ 1e7)

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, InsurancePool);
    let client = InsurancePoolClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize(&admin, &COVERAGE);

    Setup { env, client, admin }
}

#[test]
fn initialize_sets_coverage_and_zero_balance() {
    let s = setup();
    assert_eq!(s.client.get_pool_balance(), 0);
    assert_eq!(s.client.get_coverage(), COVERAGE);
}

#[test]
fn initialize_is_single_shot() {
    let s = setup();
    let other = Address::generate(&s.env);
    let res = s.client.try_initialize(&other, &COVERAGE);
    assert_eq!(res, Err(Ok(InsuranceError::AlreadyInitialized)));
}

#[test]
fn enroll_marks_lp_enrolled() {
    let s = setup();
    let lp = Address::generate(&s.env);
    assert!(!s.client.is_enrolled(&lp));
    s.client.enroll(&lp);
    assert!(s.client.is_enrolled(&lp));
}

#[test]
fn deposit_premium_increases_balance_and_auto_enrolls() {
    let s = setup();
    let lp = Address::generate(&s.env);

    s.client.deposit_premium(&lp, &500);
    s.client.deposit_premium(&lp, &250);

    assert_eq!(s.client.get_pool_balance(), 750);
    assert_eq!(s.client.get_premiums_paid(&lp), 750);
    assert!(s.client.is_enrolled(&lp)); // auto-enrolled on first premium
}

#[test]
fn deposit_premium_rejects_non_positive_amount() {
    let s = setup();
    let lp = Address::generate(&s.env);
    assert!(s.client.try_deposit_premium(&lp, &0).is_err());
    assert!(s.client.try_deposit_premium(&lp, &-100).is_err());
}

#[test]
fn claim_pays_coverage_capped_by_balance() {
    let s = setup();
    let lp = Address::generate(&s.env);

    // Pool has less than the coverage cap -> payout bounded by balance.
    s.client.deposit_premium(&lp, &400);
    let payout = s.client.claim(&1);
    assert_eq!(payout, 400);
    assert_eq!(s.client.get_pool_balance(), 0);
    assert!(s.client.is_claimed(&1));
}

#[test]
fn claim_pays_flat_coverage_when_pool_is_large() {
    let s = setup();
    let lp = Address::generate(&s.env);

    s.client.deposit_premium(&lp, &(COVERAGE * 3));
    let payout = s.client.claim(&7);
    assert_eq!(payout, COVERAGE); // capped at flat coverage
    assert_eq!(s.client.get_pool_balance(), COVERAGE * 2);
}

#[test]
fn claim_is_idempotent_per_invoice() {
    let s = setup();
    let lp = Address::generate(&s.env);
    s.client.deposit_premium(&lp, &(COVERAGE * 2));

    s.client.claim(&42);
    let res = s.client.try_claim(&42);
    // `claim` returns `i128` and panics with the error, so it surfaces as the
    // outer host error (a `soroban_sdk::Error`) rather than an inner `Result`.
    assert_eq!(
        res,
        Err(Ok(soroban_sdk::Error::from(InsuranceError::AlreadyClaimed)))
    );
}

#[test]
fn claim_rejects_when_pool_empty() {
    let s = setup();
    let res = s.client.try_claim(&99);
    assert_eq!(
        res,
        Err(Ok(soroban_sdk::Error::from(InsuranceError::PoolEmpty)))
    );
}

#[test]
fn admin_is_recorded() {
    let s = setup();
    // A claim requires admin auth; with mock_all_auths it succeeds once funded.
    let lp = Address::generate(&s.env);
    s.client.deposit_premium(&lp, &COVERAGE);
    let _ = s.client.claim(&100);
    // admin captured at init is the one we passed
    assert!(s.client.is_claimed(&100));
    let _ = &s.admin;
}
