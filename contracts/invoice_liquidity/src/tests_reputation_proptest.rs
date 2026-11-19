#![cfg(test)]

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
            prop_assert!(score >= 0, "Reputation score went negative: {}", score);

            env.as_contract(&contract.address, || {
                let profile = crate::invoice::get_reputation(&env, &payer);
                prop_assert_eq!(profile.score, score, "ReputationProfile score does not match payer_score");
            });
        }
    }
}
