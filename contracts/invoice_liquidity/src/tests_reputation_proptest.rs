#![cfg(test)]

//! Reputation property tests and payer-history consistency checks.
//!
//! Model verified against `invoice.rs` / `lib.rs` / `top_payers.rs`:
//!
//! * `submit_invoice` increments the **freelancer's** `invoices_submitted`.
//! * `mark_paid` (final settlement) increments `invoices_paid` for the payer
//!   *and* the freelancer, and adds +1 to the payer's score (cap 100).
//! * `claim_default` increments the payer's `invoices_defaulted` and
//!   subtracts 5 from the payer's score (floor 0).
//! * `resolve_appeal(upheld = true)` restores the pre-default score and
//!   decrements `invoices_defaulted`; a rejected appeal changes neither.
//! * `ReputationProfile.score` always mirrors `payer_score` after any write
//!   or lazy decay, and the top-payer heap holds at most one entry per payer
//!   whose score equals the payer's current score (default-50 payers that
//!   were never written are absent).
//!
//! The proptest drives random lifecycle sequences against a counter model;
//! the deterministic tests pin the multi-payer ranking and appeal behavior.

use super::*;
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReputationEvent {
    SubmitAndFund,
    Pay,
    Default,
    DecayTick(u32),
}

fn reputation_event_strategy() -> impl Strategy<Value = ReputationEvent> {
    prop_oneof![
        Just(ReputationEvent::SubmitAndFund),
        Just(ReputationEvent::Pay),
        Just(ReputationEvent::Default),
        (1u32..50000u32).prop_map(ReputationEvent::DecayTick),
    ]
}

fn setup_proptest_env(
    env: &Env,
) -> (
    InvoiceLiquidityContractClient<'static>,
    TokenClient<'static>,
    Address,
    Address,
    Address,
) {
    env.mock_all_auths();

    let usdc_admin = Address::generate(env);
    let usdc_contract_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_address = usdc_contract_id.address();

    let eurc_admin = Address::generate(env);
    let eurc_contract_id = env.register_stellar_asset_contract_v2(eurc_admin.clone());
    let eurc_address = eurc_contract_id.address();

    let token = TokenClient::new(env, &usdc_address);
    let token_admin = StellarAssetClient::new(env, &usdc_address);

    let freelancer = Address::generate(env);
    let payer = Address::generate(env);
    let funder = Address::generate(env);

    // Mint USDC to the actors who need it. Use massive amounts to prevent out of funds.
    let massive_amount = 1_000_000_000_000_000_000i128; // 10^18 stroops
    token_admin.mint(&funder, &massive_amount);
    token_admin.mint(&payer, &massive_amount);

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(env, &contract_id);

    // Fund the contract treasury so it can cover defaults
    token_admin.mint(&contract.address, &massive_amount);

    let xlm_admin = Address::generate(env);
    let xlm_contract_id = env.register_stellar_asset_contract_v2(xlm_admin);
    let xlm_address = xlm_contract_id.address();

    contract.initialize(&usdc_admin, &usdc_address, &eurc_address, &xlm_address);

    let mut ledger_info = env.ledger().get();
    ledger_info.timestamp = 1_700_000_000;
    ledger_info.sequence_number = 100;
    env.ledger().set(ledger_info);

    (contract, token, freelancer, payer, funder)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    #[test]
    fn test_reputation_score_adversarial_ordering(
        events in prop::collection::vec(reputation_event_strategy(), 1..100),
        decay_rate_bps in 0u32..=10000u32,
        decay_period_ledgers in 1u64..=100000u64,
        initial_score in 0u32..=150u32,
    ) {
        let env = Env::default();
        let (contract, token, freelancer, payer, funder) = setup_proptest_env(&env);

        let config = crate::config::Config {
            high_rep_threshold: 70,
            bonus_bps: 100,
            min_discount_rate_bps: 100,
            decay_rate_bps,
            decay_period_ledgers,
            dispute_timeout_ledgers: 10000,
            xlm_sac_address: Address::generate(&env),
            usdc_sac_address: token.address.clone(),
            eurc_sac_address: Address::generate(&env),
            price_oracle: None,
            max_oracle_age_ledgers: 17280,
        };

        env.as_contract(&contract.address, || {
            crate::storage::set_config(&env, &config);
        });

        env.as_contract(&contract.address, || {
            crate::invoice::set_payer_score(&env, &payer, initial_score);
        });

        let mut active_invoices = std::vec::Vec::new();

        for event in events {
            match event {
                ReputationEvent::SubmitAndFund => {
                    let due_date = env.ledger().timestamp() + 30 * 24 * 3600;
                    let invoice_id = contract.submit_invoice(
                        &freelancer,
                        &payer,
                        &1_000_000_000,
                        &due_date,
                        &300,
                        &token.address,
                        &ReferralCode::None,
                    );
                    contract.fund_invoice(&funder, &invoice_id, &1_000_000_000, &false);
                    active_invoices.push((invoice_id, due_date));
                }
                ReputationEvent::Pay => {
                    let invoice_id = if let Some((id, _due_date)) = active_invoices.pop() {
                        id
                    } else {
                        let due_date = env.ledger().timestamp() + 30 * 24 * 3600;
                        let id = contract.submit_invoice(
                            &freelancer,
                            &payer,
                            &1_000_000_000,
                            &due_date,
                            &300,
                            &token.address,
                            &ReferralCode::None,
                        );
                        contract.fund_invoice(&funder, &id, &1_000_000_000, &false);
                        id
                    };
                    let _ = contract.mark_paid(&invoice_id, &1_000_000_000);
                }
                ReputationEvent::Default => {
                    let (invoice_id, due_date) = if let Some(item) = active_invoices.pop() {
                        item
                    } else {
                        let due_date = env.ledger().timestamp() + 30 * 24 * 3600;
                        let id = contract.submit_invoice(
                            &freelancer,
                            &payer,
                            &1_000_000_000,
                            &due_date,
                            &300,
                            &token.address,
                            &ReferralCode::None,
                        );
                        contract.fund_invoice(&funder, &id, &1_000_000_000, &false);
                        (id, due_date)
                    };

                    let mut ledger_info = env.ledger().get();
                    ledger_info.timestamp = due_date + 1;
                    env.ledger().set(ledger_info);

                    let _ = contract.claim_default(&funder, &invoice_id);
                }
                ReputationEvent::DecayTick(ledgers) => {
                    let mut ledger_info = env.ledger().get();
                    ledger_info.sequence_number = ledger_info.sequence_number.saturating_add(ledgers);
                    env.ledger().set(ledger_info);

                    let _ = contract.payer_score(&payer);
                }
            }

            let score = contract.payer_score(&payer);
            prop_assert!(score <= 100, "Reputation score exceeded 100: {}", score);

            // Read through the client (not `as_contract`) so `prop_assert_eq!`
            // can early-return a `TestCaseError` from the test body.
            let profile = contract.get_reputation(&payer);
            prop_assert_eq!(profile.score, score, "ReputationProfile score does not match payer_score");
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Payer history consistency (issue: profile / history / top-payer ranking vs
// lifecycle events)
// ─────────────────────────────────────────────────────────────────────────────

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// Counters in `ReputationProfile` equal the number of lifecycle events
    /// applied, `profile.score` mirrors `payer_score`, and the top-payer heap
    /// never holds a stale or duplicate entry for the payer.
    #[test]
    fn test_payer_history_matches_lifecycle_events(
        events in prop::collection::vec(reputation_event_strategy(), 1..60),
        decay_rate_bps in 0u32..=10000u32,
        decay_period_ledgers in 1u64..=100000u64,
        initial_score in 0u32..=150u32,
    ) {
        let env = Env::default();
        let (contract, token, freelancer, payer, funder) = setup_proptest_env(&env);

        let config = crate::config::Config {
            high_rep_threshold: 70,
            bonus_bps: 100,
            min_discount_rate_bps: 100,
            decay_rate_bps,
            decay_period_ledgers,
            dispute_timeout_ledgers: 10000,
            xlm_sac_address: Address::generate(&env),
            usdc_sac_address: token.address.clone(),
            eurc_sac_address: Address::generate(&env),
            price_oracle: None,
            max_oracle_age_ledgers: 17280,
        };
        env.as_contract(&contract.address, || {
            crate::storage::set_config(&env, &config);
        });
        env.as_contract(&contract.address, || {
            crate::invoice::set_payer_score(&env, &payer, initial_score);
        });

        let mut active_invoices = std::vec::Vec::new();
        let mut submitted: u32 = 0;
        let mut paid: u32 = 0;
        let mut defaulted: u32 = 0;

        for event in events {
            match event {
                ReputationEvent::SubmitAndFund => {
                    let due_date = env.ledger().timestamp() + 30 * 24 * 3600;
                    let id = contract.submit_invoice(
                        &freelancer, &payer, &1_000_000_000, &due_date, &300,
                        &token.address, &ReferralCode::None,
                    );
                    contract.fund_invoice(&funder, &id, &1_000_000_000, &false);
                    submitted += 1;
                    active_invoices.push((id, due_date));
                }
                ReputationEvent::Pay | ReputationEvent::Default => {
                    let (id, due_date) = if let Some(item) = active_invoices.pop() {
                        item
                    } else {
                        let due_date = env.ledger().timestamp() + 30 * 24 * 3600;
                        let id = contract.submit_invoice(
                            &freelancer, &payer, &1_000_000_000, &due_date, &300,
                            &token.address, &ReferralCode::None,
                        );
                        contract.fund_invoice(&funder, &id, &1_000_000_000, &false);
                        submitted += 1;
                        (id, due_date)
                    };
                    if event == ReputationEvent::Pay {
                        contract.mark_paid(&id, &1_000_000_000);
                        paid += 1;
                    } else {
                        let mut ledger_info = env.ledger().get();
                        ledger_info.timestamp = due_date + 1;
                        env.ledger().set(ledger_info);
                        contract.claim_default(&funder, &id);
                        defaulted += 1;
                    }
                }
                ReputationEvent::DecayTick(ledgers) => {
                    let mut ledger_info = env.ledger().get();
                    ledger_info.sequence_number =
                        ledger_info.sequence_number.saturating_add(ledgers);
                    env.ledger().set(ledger_info);
                }
            }

            // Reading the score applies any pending lazy decay and syncs the
            // profile + heap, so the checks below see a settled state.
            let score = contract.payer_score(&payer);
            let payer_profile = contract.get_reputation(&payer);
            let freelancer_profile = contract.get_reputation(&freelancer);

            prop_assert_eq!(payer_profile.invoices_paid, paid);
            prop_assert_eq!(payer_profile.invoices_defaulted, defaulted);
            prop_assert_eq!(payer_profile.invoices_submitted, 0);
            prop_assert_eq!(payer_profile.score, score);

            prop_assert_eq!(freelancer_profile.invoices_submitted, submitted);
            prop_assert_eq!(freelancer_profile.invoices_paid, paid);
            prop_assert_eq!(freelancer_profile.invoices_defaulted, 0);

            prop_assert!(paid + defaulted <= submitted);

            let top = contract.get_top_payers(&50);
            let mut payer_entries = 0u32;
            for entry in top.iter() {
                prop_assert!(entry.address == payer, "only the payer may be ranked");
                prop_assert_eq!(entry.score, score, "ranking entry is stale");
                payer_entries += 1;
            }
            prop_assert!(payer_entries <= 1, "duplicate ranking entries");
            if score != crate::constants::DEFAULT_PAYER_SCORE {
                prop_assert_eq!(payer_entries, 1, "non-default score must be ranked");
            }
        }
    }
}

fn evidence(env: &Env) -> soroban_sdk::BytesN<32> {
    soroban_sdk::BytesN::from_array(env, &[7u8; 32])
}

/// Deterministic multi-payer scenario: ranking follows paid / defaulted /
/// appeal-upheld / appeal-rejected outcomes and stays consistent with each
/// payer's profile.
#[test]
fn test_top_payer_ranking_tracks_lifecycle_outcomes() {
    use crate::test::setup;

    const AMOUNT: i128 = 1_000_000_000;
    let t = setup();
    let token_admin = StellarAssetClient::new(&t.env, &t.token.address);

    let mut payers = std::vec::Vec::new();
    for _ in 0..4 {
        let p = Address::generate(&t.env);
        token_admin.mint(&p, &(AMOUNT * 10));
        payers.push(p);
    }
    let (p_two_paid, p_one_paid, p_upheld, p_rejected) = (
        payers[0].clone(),
        payers[1].clone(),
        payers[2].clone(),
        payers[3].clone(),
    );

    let due_date = t.env.ledger().timestamp() + 30 * 24 * 3600;
    let submit_fund = |payer: &Address| -> u64 {
        let id = t.contract.submit_invoice(
            &t.freelancer, payer, &AMOUNT, &due_date, &300, &t.token.address,
            &ReferralCode::None,
        );
        t.contract.fund_invoice(&t.funder, &id, &AMOUNT, &false);
        id
    };

    let a1 = submit_fund(&p_two_paid);
    let a2 = submit_fund(&p_two_paid);
    let b1 = submit_fund(&p_one_paid);
    let c1 = submit_fund(&p_upheld);
    let d1 = submit_fund(&p_rejected);

    t.contract.mark_paid(&a1, &AMOUNT);
    t.contract.mark_paid(&a2, &AMOUNT);
    t.contract.mark_paid(&b1, &AMOUNT);

    let mut ledger_info = t.env.ledger().get();
    ledger_info.timestamp = due_date + 1;
    t.env.ledger().set(ledger_info);
    t.contract.claim_default(&t.funder, &c1);
    t.contract.claim_default(&t.funder, &d1);

    // Ranking after paid + default events: 52, 51, 45, 45 (tie by address).
    let top = t.contract.get_top_payers(&10);
    assert_eq!(top.len(), 4);
    assert_eq!(top.get(0).unwrap(), TopPayerEntry { address: p_two_paid.clone(), score: 52 });
    assert_eq!(top.get(1).unwrap(), TopPayerEntry { address: p_one_paid.clone(), score: 51 });
    assert_eq!(top.get(2).unwrap().score, 45);
    assert_eq!(top.get(3).unwrap().score, 45);
    assert!(top.get(2).unwrap().address < top.get(3).unwrap().address);
    assert_eq!(t.contract.get_reputation(&p_two_paid).invoices_paid, 2);
    assert_eq!(t.contract.get_reputation(&p_upheld).invoices_defaulted, 1);

    // Appeal upheld for `p_upheld`: score restored to the pre-default 50 and
    // the default is removed from history; `p_rejected` keeps its penalty.
    t.contract.appeal_default(&c1, &evidence(&t.env));
    t.contract.appeal_default(&d1, &evidence(&t.env));
    t.contract.resolve_appeal(&c1, &true);
    t.contract.resolve_appeal(&d1, &false);

    assert_eq!(t.contract.payer_score(&p_upheld), 50);
    assert_eq!(t.contract.get_reputation(&p_upheld).invoices_defaulted, 0);
    assert_eq!(t.contract.get_reputation(&p_upheld).score, 50);
    assert_eq!(t.contract.payer_score(&p_rejected), 45);
    assert_eq!(t.contract.get_reputation(&p_rejected).invoices_defaulted, 1);

    let top = t.contract.get_top_payers(&10);
    assert_eq!(top.len(), 4, "appeal must not duplicate or drop ranking entries");
    assert_eq!(top.get(0).unwrap().address, p_two_paid);
    assert_eq!(top.get(1).unwrap().address, p_one_paid);
    assert_eq!(top.get(2).unwrap(), TopPayerEntry { address: p_upheld.clone(), score: 50 });
    assert_eq!(top.get(3).unwrap(), TopPayerEntry { address: p_rejected.clone(), score: 45 });

    // Every ranked entry equals the payer's live score and profile score.
    for entry in top.iter() {
        assert_eq!(t.contract.payer_score(&entry.address), entry.score);
        assert_eq!(t.contract.get_reputation(&entry.address).score, entry.score);
    }
}

/// A payer's history is isolated from a freelancer-only address and an
/// unknown address: they never appear in the ranking.
#[test]
fn test_unranked_addresses_have_empty_history() {
    use crate::test::setup;

    let t = setup();
    let stranger = Address::generate(&t.env);
    assert_eq!(t.contract.payer_score(&stranger), 50);
    let profile = t.contract.get_reputation(&stranger);
    assert_eq!(profile.invoices_submitted, 0);
    assert_eq!(profile.invoices_paid, 0);
    assert_eq!(profile.invoices_defaulted, 0);
    assert_eq!(t.contract.get_top_payers(&10).len(), 0);
}
