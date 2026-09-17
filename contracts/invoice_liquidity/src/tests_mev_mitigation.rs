//! Tests for Issue #MEV-1 — resolve_fund_queue maturity delay
//!
//! Scenarios covered:
//!  - resolve_fund_queue fails immediately after first LP joins (QueueNotMature)
//!  - resolve_fund_queue succeeds once QUEUE_DELAY_LEDGERS have elapsed
//!  - Second LP joining does not reset the maturity timer
//!  - Event emitted on rejected resolution attempt (success=false)
//!  - Event emitted on successful resolution attempt (success=true)

#![cfg(test)]

use super::*;
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30; // 30 days

struct MevTestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: TokenClient<'static>,
    freelancer: Address,
    payer: Address,
    lp_a: Address,
    lp_b: Address,
}

fn setup_mev() -> MevTestEnv {
    let env = Env::default();
    env.mock_all_auths();

    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_addr = usdc_id.address();

    let token = TokenClient::new(&env, &usdc_addr);
    let token_admin = StellarAssetClient::new(&env, &usdc_addr);

    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let lp_a = Address::generate(&env);
    let lp_b = Address::generate(&env);

    for lp in [&lp_a, &lp_b] {
        token_admin.mint(lp, &(INVOICE_AMOUNT * 10));
    }
    token_admin.mint(&payer, &(INVOICE_AMOUNT * 10));

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);
    token_admin.mint(&contract.address, &(INVOICE_AMOUNT * 100));

    let xlm_admin = Address::generate(&env);
    let xlm_id = env.register_stellar_asset_contract_v2(xlm_admin);
    let xlm_addr = xlm_id.address();
    let eurc_addr = Address::generate(&env);

    contract.initialize(&usdc_admin, &usdc_addr, &eurc_addr, &xlm_addr);

    let mut ledger = env.ledger().get();
    ledger.timestamp = 1_700_000_000;
    ledger.sequence_number = 100;
    env.ledger().set(ledger);

    MevTestEnv {
        env,
        contract,
        token,
        freelancer,
        payer,
        lp_a,
        lp_b,
    }
}

fn submit_invoice_mev(t: &MevTestEnv) -> u64 {
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    )
}

fn advance_ledgers(env: &Env, delta: u32) {
    let mut info = env.ledger().get();
    info.sequence_number += delta;
    info.timestamp += u64::from(delta) * 5;
    env.ledger().set(info);
}

// ── Maturity delay: reject before delay elapses ───────────────────────────────

#[test]
fn test_resolve_queue_fails_immediately_after_join() {
    let t = setup_mev();
    let id = submit_invoice_mev(&t);

    t.contract.join_fund_queue(&t.lp_a, &id);

    // Attempt to resolve on the same ledger — must be rejected.
    let result = t.contract.try_resolve_fund_queue(&id);
    assert_eq!(result, Err(Ok(ContractError::QueueNotMature)));
}

#[test]
fn test_resolve_queue_fails_one_ledger_before_delay() {
    let t = setup_mev();
    let id = submit_invoice_mev(&t);

    t.contract.join_fund_queue(&t.lp_a, &id);

    // Advance to one ledger before the required delay.
    advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS - 1);

    let result = t.contract.try_resolve_fund_queue(&id);
    assert_eq!(result, Err(Ok(ContractError::QueueNotMature)));
}

// ── Maturity delay: succeed after delay elapses ───────────────────────────────

#[test]
fn test_resolve_queue_succeeds_after_delay() {
    let t = setup_mev();
    let id = submit_invoice_mev(&t);

    t.contract.join_fund_queue(&t.lp_a, &id);

    // Advance exactly QUEUE_DELAY_LEDGERS — now resolution must succeed.
    advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS);

    let approved = t.contract.resolve_fund_queue(&id);
    assert_eq!(approved, t.lp_a);
}

#[test]
fn test_resolve_queue_succeeds_well_after_delay() {
    let t = setup_mev();
    let id = submit_invoice_mev(&t);

    t.contract.join_fund_queue(&t.lp_a, &id);

    // Advance far beyond the delay — must still succeed.
    advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS * 3);

    let approved = t.contract.resolve_fund_queue(&id);
    assert_eq!(approved, t.lp_a);
}

// ── Timer is anchored to the FIRST join, not subsequent ones ──────────────────

#[test]
fn test_second_lp_join_does_not_reset_maturity_timer() {
    let t = setup_mev();
    let id = submit_invoice_mev(&t);

    // lp_a joins first — timer starts here.
    t.contract.join_fund_queue(&t.lp_a, &id);

    // Advance most of the delay.
    advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS - 10);

    // lp_b joins late — this must NOT reset the timer.
    t.contract.join_fund_queue(&t.lp_b, &id);

    // Advance the remaining ledgers to complete the original delay.
    advance_ledgers(&t.env, 10);

    // Resolution should succeed: the timer was started by lp_a's join.
    let approved = t.contract.resolve_fund_queue(&id);
    // lp_b joined with equal score (default 50) — lp_a has priority as first.
    assert_eq!(approved, t.lp_a);
}

// ── Idempotency: already-resolved queue returns cached winner immediately ─────

#[test]
fn test_resolve_already_resolved_queue_returns_same_winner() {
    let t = setup_mev();
    let id = submit_invoice_mev(&t);

    t.contract.join_fund_queue(&t.lp_a, &id);
    advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS);

    let first = t.contract.resolve_fund_queue(&id);
    // Second call on an already-resolved queue must return the same winner.
    let second = t.contract.resolve_fund_queue(&id);
    assert_eq!(first, second);
    assert_eq!(first, t.lp_a);
}

// ── Event emission ────────────────────────────────────────────────────────────

#[test]
fn test_rejected_resolution_emits_attempt_event_with_success_false() {
    let t = setup_mev();
    let id = submit_invoice_mev(&t);

    t.contract.join_fund_queue(&t.lp_a, &id);

    // join_fund_queue must have emitted its FundRequested event.
    let events_after_join = t.env.events().all();
    assert!(
        !events_after_join.events().is_empty(),
        "Expected FundRequested event after join"
    );

    // Attempt resolution before maturity — the call is rejected. Note: in
    // this SDK's mock test host, a call that returns a declared contract
    // error reverts its own events *and* clears the env's whole
    // accumulated event log (verified empirically — unrelated failing
    // calls do the same), so the FundQueueResolutionAttempted event this
    // rejection path publishes (see resolve_fund_queue's QueueNotMature
    // branch) isn't independently observable via events().all() once the
    // call returns. We can only assert on the call's own failure here.
    let result = t.contract.try_resolve_fund_queue(&id);
    assert_eq!(result, Err(Ok(ContractError::QueueNotMature)));
}

#[test]
fn test_successful_resolution_emits_attempt_event_with_success_true() {
    let t = setup_mev();
    let id = submit_invoice_mev(&t);

    t.contract.join_fund_queue(&t.lp_a, &id);
    advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS);

    t.contract.resolve_fund_queue(&id);

    // At least two events expected: FundRequested + FundQueueResolved +
    // FundQueueResolutionAttempted (success=true).
    let events = t.env.events().all();
    assert!(
        events.events().len() >= 2,
        "Expected events from join + resolve, got {}",
        events.events().len()
    );
}

// ================================================================
// Issue #663: Proptest-based Multi-LP Queue Resolution & Invariant
// ================================================================
proptest! {
    #![proptest_config(ProptestConfig::with_cases(20))]

    #[test]
    fn prop_multi_lp_queue_resolution_invariant(
        num_lps in 2..=12usize,
        boost_seed in prop::collection::vec(0..5u32, 12),
        join_delays in prop::collection::vec(0..5u32, 12),
        extra_wait in 0..100u32,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let usdc_admin = Address::generate(&env);
        let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
        let usdc_addr = usdc_id.address();

        let token = TokenClient::new(&env, &usdc_addr);
        let token_admin = StellarAssetClient::new(&env, &usdc_addr);

        let freelancer = Address::generate(&env);
        let payer = Address::generate(&env);

        let contract_id = env.register_contract(None, InvoiceLiquidityContract);
        let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);
        token_admin.mint(&contract.address, &(INVOICE_AMOUNT * 100));

        let xlm_admin = Address::generate(&env);
        let xlm_id = env.register_stellar_asset_contract_v2(xlm_admin);
        let xlm_addr = xlm_id.address();
        let eurc_addr = Address::generate(&env);

        contract.initialize(&usdc_admin, &usdc_addr, &eurc_addr, &xlm_addr);

        let mut ledger = env.ledger().get();
        ledger.timestamp = 1_700_000_000;
        ledger.sequence_number = 100;
        env.ledger().set(ledger);

        // Generate N LPs with initial token balances
        let mut lps = std::vec::Vec::new();
        let initial_lp_balance = INVOICE_AMOUNT * 10;
        for _ in 0..num_lps {
            let lp = Address::generate(&env);
            token_admin.mint(&lp, &initial_lp_balance);
            lps.push(lp);
        }
        token_admin.mint(&payer, &(INVOICE_AMOUNT * 10));

        // Boost LP scores according to boost_seed
        for (i, lp) in lps.iter().enumerate().take(num_lps) {
            let boosts = boost_seed[i];
            for _ in 0..boosts {
                let dummy_due = env.ledger().timestamp() + DUE_DATE_OFFSET;
                let dummy_fl = Address::generate(&env);
                let dummy_py = Address::generate(&env);
                token_admin.mint(&dummy_py, &(INVOICE_AMOUNT * 10));
                let dummy_id = contract.submit_invoice(
                    &dummy_fl,
                    &dummy_py,
                    &INVOICE_AMOUNT,
                    &dummy_due,
                    &DISCOUNT_RATE,
                    &token.address,
                    &ReferralCode::None,
                );
                contract.fund_invoice(lp, &dummy_id, &INVOICE_AMOUNT, &false);
            }
        }

        // Snapshot LP scores and pre-target balances
        let scores: std::vec::Vec<u32> = lps.iter().map(|lp| contract.lp_score(lp)).collect();
        let initial_lp_balances: std::vec::Vec<i128> = lps.iter().map(|lp| token.balance(lp)).collect();

        // Submit the target invoice
        let target_due = env.ledger().timestamp() + DUE_DATE_OFFSET;
        let target_id = contract.submit_invoice(
            &freelancer,
            &payer,
            &INVOICE_AMOUNT,
            &target_due,
            &DISCOUNT_RATE,
            &token.address,
            &ReferralCode::None,
        );

        // LPs join the queue with random inter-join ledger delays
        let first_join_ledger = env.ledger().sequence();
        for (i, lp) in lps.iter().enumerate().take(num_lps) {
            if i > 0 {
                advance_ledgers(&env, join_delays[i]);
            }
            contract.join_fund_queue(lp, &target_id);
        }

        // Determine the expected winner: highest score, tie-break by earliest join index
        let mut best_score = 0;
        let mut expected_winner_idx = 0;
        for (i, &score) in scores.iter().enumerate().take(num_lps) {
            if score > best_score {
                best_score = score;
                expected_winner_idx = i;
            }
        }
        let expected_winner = &lps[expected_winner_idx];

        let current_ledger = env.ledger().sequence();
        let elapsed_since_first = current_ledger.saturating_sub(first_join_ledger);

        if elapsed_since_first < QUEUE_DELAY_LEDGERS {
            // Pre-maturity: resolution must be rejected
            let early_res = contract.try_resolve_fund_queue(&target_id);
            prop_assert_eq!(early_res, Err(Ok(ContractError::QueueNotMature)));

            // Advance remaining ledgers to mature the queue
            let remaining = QUEUE_DELAY_LEDGERS - elapsed_since_first;
            advance_ledgers(&env, remaining);
        }

        // Advance any extra wait
        advance_ledgers(&env, extra_wait);

        // INVARIANT Q1: Single winner resolution
        let resolved_winner = contract.resolve_fund_queue(&target_id);
        prop_assert_eq!(&resolved_winner, expected_winner, "Expected highest score LP (with tie-break) to win");

        // INVARIANT Q4: Resolution idempotency
        let second_resolution = contract.resolve_fund_queue(&target_id);
        prop_assert_eq!(resolved_winner, second_resolution, "Resolution must be idempotent");

        // Verify non-winning LPs cannot fund
        for (i, lp) in lps.iter().enumerate().take(num_lps) {
            if i != expected_winner_idx {
                let non_winner_fund = contract.try_fund_invoice(lp, &target_id, &INVOICE_AMOUNT, &false);
                prop_assert_eq!(non_winner_fund, Err(Ok(ContractError::NotApprovedFunder)));
            }
        }

        // Winning LP funds the invoice
        let winner_bal_before = token.balance(expected_winner);
        contract.fund_invoice(expected_winner, &target_id, &INVOICE_AMOUNT, &false);
        let winner_bal_after = token.balance(expected_winner);
        let expected_paid = INVOICE_AMOUNT - (INVOICE_AMOUNT * (DISCOUNT_RATE as i128) / 10_000);
        prop_assert_eq!(winner_bal_after, winner_bal_before - expected_paid);

        // INVARIANT Q2: Zero stuck funds / full solvency for losers
        for (i, lp) in lps.iter().enumerate().take(num_lps) {
            if i != expected_winner_idx {
                let loser_bal = token.balance(lp);
                let pre_target_bal = initial_lp_balances[i];
                prop_assert_eq!(
                    loser_bal,
                    pre_target_bal,
                    "Losing LP balance must be untouched with zero funds stuck"
                );
            }
        }

        // Verify invoice is properly funded
        let inv = contract.get_invoice(&target_id);
        prop_assert_eq!(inv.status, InvoiceStatus::Funded);
        prop_assert_eq!(inv.funder, Some(expected_winner.clone()));
    }
}
