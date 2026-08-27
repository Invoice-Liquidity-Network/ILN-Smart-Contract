#![cfg(test)]

use super::*;
use crate::config::Config;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};
use std::format;

const _INVOICE_AMOUNT: i128 = 100_000_000;
const _DISCOUNT_RATE: u32 = 300;
const _DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30;

#[allow(dead_code)]
struct TestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: TokenClient<'static>,
    token_address: Address,
    freelancer: Address,
    payer: Address,
    funder: Address,
}

fn setup() -> TestEnv {
    let env = Env::default();
    env.mock_all_auths();

    let usdc_admin = Address::generate(&env);
    let usdc_contract_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_address = usdc_contract_id.address();
    let token = TokenClient::new(&env, &usdc_address);
    let token_admin = StellarAssetClient::new(&env, &usdc_address);

    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let funder = Address::generate(&env);

    token_admin.mint(&funder, &1_000_000_000_000);
    token_admin.mint(&payer, &1_000_000_000_000);

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);

    let xlm_admin = Address::generate(&env);
    let xlm_address = env.register_stellar_asset_contract_v2(xlm_admin).address();

    let eurc_address = Address::generate(&env);

    contract.initialize(&usdc_admin, &usdc_address, &eurc_address, &xlm_address);

    TestEnv {
        env,
        contract,
        token,
        token_address: usdc_address,
        freelancer,
        payer,
        funder,
    }
}

fn _submit_standard_invoice(t: &TestEnv) -> u64 {
    let due_date = t.env.ledger().timestamp() + _DUE_DATE_OFFSET;
    t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &_INVOICE_AMOUNT,
        &due_date,
        &_DISCOUNT_RATE,
        &t.token_address,
        &ReferralCode::None,
    )
}

// ================================================================
// Reputation Decay Tests (Issue #487)
// ================================================================

fn setup_decay_config(t: &TestEnv, decay_rate_bps: u32, decay_period_ledgers: u64) {
    let config = Config {
        high_rep_threshold: 80,
        bonus_bps: 200,
        min_discount_rate_bps: 100,
        decay_rate_bps,
        decay_period_ledgers,
        dispute_timeout_ledgers: 100,
        xlm_sac_address: Address::generate(&t.env),
        usdc_sac_address: Address::generate(&t.env),
        eurc_sac_address: Address::generate(&t.env),
        price_oracle: None,
        max_oracle_age_ledgers: 17280,
    };
    t.env.as_contract(&t.contract.address, || {
        crate::storage::set_config(&t.env, &config);
    });
}

fn set_payer_score_direct(t: &TestEnv, score: u32) {
    t.env.as_contract(&t.contract.address, || {
        invoice::set_payer_score(&t.env, &t.payer, score);
    });
}

#[test]
fn test_reputation_decay_one_period() {
    let t = setup();
    set_payer_score_direct(&t, 80);
    setup_decay_config(&t, 100, 1000);

    let mut ledger = t.env.ledger().get();
    ledger.sequence_number += 1000;
    t.env.ledger().set(ledger);

    let score = t.contract.payer_score(&t.payer);
    // Decay: 80 - max(80*100/10000, 1) = 80 - 1 = 79
    assert_eq!(score, 79);
}

#[test]
fn test_reputation_decay_multiple_periods() {
    let t = setup();
    set_payer_score_direct(&t, 100);
    setup_decay_config(&t, 100, 1000);

    let mut ledger = t.env.ledger().get();
    ledger.sequence_number += 3000;
    t.env.ledger().set(ledger);

    let score = t.contract.payer_score(&t.payer);
    // After 3 periods: 100->99->98->97
    assert_eq!(score, 97);
}

#[test]
fn test_reputation_decay_floor() {
    let t = setup();
    set_payer_score_direct(&t, 5);
    setup_decay_config(&t, 5000, 100);

    let mut ledger = t.env.ledger().get();
    ledger.sequence_number += 1000;
    t.env.ledger().set(ledger);

    let score = t.contract.payer_score(&t.payer);
    assert_eq!(score, 0, "Score should floor at 0");
}

#[test]
fn test_reputation_activity_resets_decay() {
    let t = setup();
    set_payer_score_direct(&t, 80);
    setup_decay_config(&t, 100, 1000);

    let mut ledger = t.env.ledger().get();
    ledger.sequence_number += 500;
    t.env.ledger().set(ledger);

    set_payer_score_direct(&t, 85);

    ledger = t.env.ledger().get();
    ledger.sequence_number += 500;
    t.env.ledger().set(ledger);

    let score = t.contract.payer_score(&t.payer);
    assert_eq!(score, 85, "Score should not decay after activity reset");
}

#[test]
fn test_get_payer_score_persists_decayed_score() {
    let t = setup();
    set_payer_score_direct(&t, 80);
    setup_decay_config(&t, 100, 1000);

    let mut ledger = t.env.ledger().get();
    ledger.sequence_number += 1000;
    t.env.ledger().set(ledger);

    // Call get_payer_score via contract
    let score = t.contract.payer_score(&t.payer);
    assert_eq!(score, 79);

    // Verify raw storage has persisted the decayed score (79)
    t.env.as_contract(&t.contract.address, || {
        let rep = crate::invoice::get_reputation(&t.env, &t.payer);
        assert_eq!(
            rep.score, 79,
            "Decayed score must be persisted in ReputationProfile"
        );
    });
}

#[test]
fn test_get_payer_score_emits_reputation_updated_event() {
    let t = setup();
    set_payer_score_direct(&t, 80);
    setup_decay_config(&t, 100, 1000);

    let mut ledger = t.env.ledger().get();
    ledger.sequence_number += 1000;
    t.env.ledger().set(ledger);

    // Call get_payer_score via contract
    t.contract.payer_score(&t.payer);

    // Check events emitted
    let events = t.env.events().all();
    let reputation_event_exists = events
        .events()
        .iter()
        .any(|e| format!("{:?}", e).contains("reputation_updated"));
    assert!(
        reputation_event_exists,
        "ReputationUpdated event should be emitted when score decays during get_payer_score"
    );
}
