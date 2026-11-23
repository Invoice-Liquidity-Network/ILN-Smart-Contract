//! Numeric boundary tests for the reputation bonus arithmetic
//! (see `docs/reputation-bonus-arithmetic.md`).

#![cfg(test)]

use reputation_bonus::config::Config;
use reputation_bonus::errors::ContractError;
use reputation_bonus::invoice::InvoiceKey;
use reputation_bonus::rate_logic::calculate_effective_rate;
use reputation_bonus::reputation::{write_reputation, ReputationScore};
use reputation_bonus::{ReputationBonusContract, ReputationBonusContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env,
};

const MAX: u32 = u32::MAX;

fn rate(base: u32, rep: u32, threshold: u32, bonus: u32, min: u32) -> u32 {
    calculate_effective_rate(base, rep, threshold, bonus, min).expect("rate calc is infallible")
}

fn score(submitted: u32, paid: u32) -> u32 {
    let mut r = ReputationScore {
        invoices_submitted: submitted,
        invoices_paid: paid,
        invoices_defaulted: 0,
        score: 0,
    };
    r.recalculate_score();
    r.score
}

// ── calculate_effective_rate ─────────────────────────────────────────────────

#[test]
fn bonus_larger_than_base_saturates_to_floor_instead_of_underflowing() {
    assert_eq!(rate(100, 100, 80, 500, 10), 10);
    assert_eq!(rate(100, 100, 80, MAX, 10), 10);
    assert_eq!(rate(MAX, 100, 80, MAX, 1), 1);
    assert_eq!(rate(0, 100, 80, 500, 25), 25);
}

#[test]
fn maximum_base_rate_does_not_overflow() {
    assert_eq!(rate(MAX, 0, 80, 500, 1), MAX);
    assert_eq!(rate(MAX, 100, 80, 500, 1), MAX - 500);
    assert_eq!(rate(MAX, 100, 80, 0, 1), MAX);
}

#[test]
fn maximum_floor_dominates_both_branches() {
    assert_eq!(rate(500, 0, 80, 200, MAX), MAX);
    assert_eq!(rate(500, 100, 80, 200, MAX), MAX);
    assert_eq!(rate(MAX, 100, 80, 200, MAX), MAX);
}

#[test]
fn threshold_comparison_is_inclusive() {
    assert_eq!(rate(500, 79, 80, 200, 100), 500);
    assert_eq!(rate(500, 80, 80, 200, 100), 300);
    assert_eq!(rate(500, 81, 80, 200, 100), 300);
    // Extremes of the score domain.
    assert_eq!(rate(500, 100, 100, 200, 100), 300);
    assert_eq!(rate(500, MAX - 1, MAX, 200, 100), 500);
    assert_eq!(rate(500, MAX, MAX, 200, 100), 300);
}

#[test]
fn zero_threshold_gives_everyone_the_bonus() {
    // `set_config` allows a threshold of 0; documented in the arithmetic doc.
    assert_eq!(rate(500, 0, 0, 200, 100), 300);
}

#[test]
fn floor_above_base_raises_the_rate() {
    assert_eq!(rate(50, 0, 80, 200, 100), 100);
    assert_eq!(rate(50, 100, 80, 0, 100), 100);
}

#[test]
fn exhaustive_boundary_grid_never_fails_and_keeps_invariants() {
    let vals = [0_u32, 1, 2, 99, 100, 500, MAX - 1, MAX];
    for &base in &vals {
        for &rep in &vals {
            for &thr in &vals {
                for &bonus in &vals {
                    for &min in &vals {
                        let r = calculate_effective_rate(base, rep, thr, bonus, min)
                            .expect("infallible");
                        assert!(r >= min, "below floor: {base} {rep} {thr} {bonus} {min}");
                        assert!(
                            r <= base.max(min),
                            "above max(base, floor): {base} {rep} {thr} {bonus} {min}"
                        );
                        if rep < thr {
                            assert_eq!(r, base.max(min));
                        }
                    }
                }
            }
        }
    }
}

// ── ReputationScore::recalculate_score ───────────────────────────────────────

#[test]
fn score_is_zero_with_no_history() {
    assert_eq!(score(0, 0), 0);
}

#[test]
fn score_uses_wide_arithmetic_at_u32_max() {
    assert_eq!(score(MAX, MAX), 100);
    assert_eq!(score(MAX, MAX - 1), 99);
    assert_eq!(score(MAX, 1), 0);
    assert_eq!(score(MAX, 0), 0);
}

#[test]
fn score_is_capped_at_100_when_paid_exceeds_submitted() {
    assert_eq!(score(1, MAX), 100);
    assert_eq!(score(0, 5), 100);
}

#[test]
fn score_truncates_toward_zero() {
    assert_eq!(score(3, 1), 33);
    assert_eq!(score(3, 2), 66);
    assert_eq!(score(200, 1), 0);
}

// ── contract-level boundaries ────────────────────────────────────────────────

fn setup() -> (Env, ReputationBonusContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register_contract(None, ReputationBonusContract);
    let client = ReputationBonusContractClient::new(&env, &id);
    client.init(&admin);
    client.set_config(&Config {
        high_rep_threshold: 80,
        bonus_bps: 200,
        min_discount_rate_bps: 100,
    });
    (env, client, id)
}

#[test]
fn counters_saturate_at_u32_max_without_panicking() {
    let (env, client, contract) = setup();
    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    env.as_contract(&contract, || {
        let maxed = ReputationScore {
            invoices_submitted: MAX,
            invoices_paid: MAX,
            invoices_defaulted: MAX,
            score: 0,
        };
        write_reputation(&env, &freelancer, maxed.clone());
        write_reputation(&env, &payer, maxed);
    });
    assert_eq!(client.get_reputation(&freelancer).score, 100);

    let inv = client.submit_invoice(&freelancer, &payer, &1_000, &1_000, &500);
    client.mark_paid(&inv.id);

    for who in [&freelancer, &payer] {
        let rep = client.get_reputation(who);
        assert_eq!(rep.invoices_submitted, MAX);
        assert_eq!(rep.invoices_paid, MAX);
        assert_eq!(rep.score, 100);
    }

    // Defaulting a second invoice saturates the defaulted counter too.
    let inv2 = client.submit_invoice(&freelancer, &payer, &1_000, &1_000, &500);
    env.ledger().set_timestamp(1_001);
    client.handle_default(&inv2.id);
    assert_eq!(client.get_reputation(&freelancer).invoices_defaulted, MAX);
}

#[test]
fn extreme_base_rate_and_amount_are_accepted_without_overflow() {
    let (env, client, _) = setup();
    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);

    // Zero reputation: no bonus, so the base rate passes through.
    let inv = client.submit_invoice(&freelancer, &payer, &i128::MAX, &u64::MAX, &MAX);
    assert_eq!(inv.effective_discount_rate_bps, MAX);
    assert_eq!(inv.amount, i128::MAX);

    // Perfect reputation: the bonus is subtracted exactly once.
    client.mark_paid(&inv.id);
    let inv2 = client.submit_invoice(&freelancer, &payer, &1, &0, &MAX);
    assert_eq!(inv2.effective_discount_rate_bps, MAX - 200);
}

#[test]
fn invoice_counter_overflow_is_an_error_and_writes_nothing() {
    let (env, client, contract) = setup();
    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    env.as_contract(&contract, || {
        env.storage()
            .instance()
            .set(&InvoiceKey::InvoiceCount, &u64::MAX);
    });

    assert_eq!(
        client.try_submit_invoice(&freelancer, &payer, &1_000, &1_000, &500),
        Err(Ok(ContractError::ArithmeticError))
    );
    assert_eq!(client.get_reputation(&freelancer).invoices_submitted, 0);
    assert_eq!(client.get_reputation(&payer).invoices_submitted, 0);
}
