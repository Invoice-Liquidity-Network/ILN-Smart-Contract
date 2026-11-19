#![cfg(test)]

use invoice_liquidity::{
    reputation::{
        get_reputation,
        is_eligible_lp,
        set_reputation,
        ReputationScore,
    },
};

use soroban_sdk::{
    testutils::Address as _,
    Address,
    Env,
};

const LP_THRESHOLD: u32 = 70;

fn default_score() -> ReputationScore {
    ReputationScore {
        invoices_paid: 0,
        invoices_defaulted: 0,
        disputes_won: 0,
        disputes_lost: 0,
        score: 0,
    }
}

#[test]
fn new_address_returns_zero_struct() {
    let env = Env::default();

    let user = Address::generate(&env);

    let reputation = get_reputation(&env, &user);

    assert_eq!(reputation, default_score());
}

#[test]
fn score_exactly_at_lp_threshold_should_pass() {
    let env = Env::default();

    let user = Address::generate(&env);

    let reputation = ReputationScore {
        invoices_paid: 10,
        invoices_defaulted: 0,
        disputes_won: 0,
        disputes_lost: 0,
        score: LP_THRESHOLD,
    };

    set_reputation(&env, &user, &reputation);

    let stored = get_reputation(&env, &user);

    assert_eq!(stored.score, LP_THRESHOLD);

    assert!(is_eligible_lp(&stored));
}

#[test]
fn score_one_below_threshold_should_fail() {
    let env = Env::default();

    let user = Address::generate(&env);

    let reputation = ReputationScore {
        invoices_paid: 10,
        invoices_defaulted: 0,
        disputes_won: 0,
        disputes_lost: 0,
        score: LP_THRESHOLD - 1,
    };

    set_reputation(&env, &user, &reputation);

    let stored = get_reputation(&env, &user);

    assert_eq!(stored.score, LP_THRESHOLD - 1);

    assert!(!is_eligible_lp(&stored));
}

#[test]
fn invoices_paid_overflow_boundary_should_not_panic() {
    let env = Env::default();

    let user = Address::generate(&env);

    let reputation = ReputationScore {
        invoices_paid: u32::MAX,
        invoices_defaulted: 0,
        disputes_won: 0,
        disputes_lost: 0,
        score: 100,
    };

    set_reputation(&env, &user, &reputation);

    let stored = get_reputation(&env, &user);

    assert_eq!(stored.invoices_paid, u32::MAX);
    assert_eq!(stored.score, 100);
}

#[test]
fn score_after_successful_default_appeal_returns_correct_value() {
    let env = Env::default();

    let user = Address::generate(&env);

    // Initial damaged reputation
    let reputation = ReputationScore {
        invoices_paid: 12,
        invoices_defaulted: 1,
        disputes_won: 0,
        disputes_lost: 1,
        score: 58,
    };

    set_reputation(&env, &user, &reputation);

    // Appeal succeeds
    let appealed_reputation = ReputationScore {
        invoices_paid: 12,
        invoices_defaulted: 0,
        disputes_won: 1,
        disputes_lost: 0,
        score: 82,
    };

    set_reputation(&env, &user, &appealed_reputation);

    let stored = get_reputation(&env, &user);

    assert_eq!(stored.invoices_paid, 12);
    assert_eq!(stored.invoices_defaulted, 0);
    assert_eq!(stored.disputes_won, 1);
    assert_eq!(stored.disputes_lost, 0);
    assert_eq!(stored.score, 82);

    assert!(is_eligible_lp(&stored));
}