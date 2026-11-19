//! Tests for Issue #batch-reputation — batch_submit increments invoices_submitted
//!
//! Scenarios covered:
//!  - batch submit 3 invoices for one freelancer → invoices_submitted == 3
//!  - batch submit with 2 different freelancers → each gets their own count
//!  - batch submit with same freelancer multiple times → count accumulates
//!  - reputation profile score unchanged by submission alone
//!  - single submit and batch submit produce the same invoices_submitted delta

#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    Address, Env,
};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30;

struct BatchRepTestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token_addr: Address,
    freelancer_a: Address,
    freelancer_b: Address,
    payer: Address,
}

fn setup_batch_rep() -> BatchRepTestEnv {
    let env = Env::default();
    env.mock_all_auths();

    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_addr = usdc_id.address();

    let token_admin_client = StellarAssetClient::new(&env, &usdc_addr);
    let freelancer_a = Address::generate(&env);
    let freelancer_b = Address::generate(&env);
    let payer = Address::generate(&env);

    token_admin_client.mint(&payer, &(INVOICE_AMOUNT * 20));

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);

    let xlm_admin = Address::generate(&env);
    let xlm_id = env.register_stellar_asset_contract_v2(xlm_admin);
    let xlm_addr = xlm_id.address();
    let eurc_addr = Address::generate(&env);

    contract.initialize(&usdc_admin, &usdc_addr, &eurc_addr, &xlm_addr);

    let mut ledger = env.ledger().get();
    ledger.timestamp = 1_700_000_000;
    env.ledger().set(ledger);

    BatchRepTestEnv {
        env,
        contract,
        token_addr: usdc_addr,
        freelancer_a,
        freelancer_b,
        payer,
    }
}

fn make_param(t: &BatchRepTestEnv, freelancer: &Address) -> InvoiceParams {
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    InvoiceParams {
        freelancer: freelancer.clone(),
        payer: t.payer.clone(),
        amount: INVOICE_AMOUNT,
        due_date,
        discount_rate: DISCOUNT_RATE,
        token: t.token_addr.clone(),
        referral_code: ReferralCode::None,
    }
}

// ── Single freelancer batches ────────────────────────────────────────────────

#[test]
fn test_batch_submit_3_increments_invoices_submitted_by_3() {
    let t = setup_batch_rep();

    let invoices = soroban_sdk::vec![
        &t.env,
        make_param(&t, &t.freelancer_a),
        make_param(&t, &t.freelancer_a),
        make_param(&t, &t.freelancer_a),
    ];

    t.contract.submit_invoices_batch(&invoices);

    let profile = t.contract.get_reputation(&t.freelancer_a);
    assert_eq!(
        profile.invoices_submitted, 3,
        "batch of 3 should increment invoices_submitted to 3"
    );
}

#[test]
fn test_batch_submit_increments_cumulate_across_multiple_batches() {
    let t = setup_batch_rep();

    // First batch of 2.
    let batch1 = soroban_sdk::vec![
        &t.env,
        make_param(&t, &t.freelancer_a),
        make_param(&t, &t.freelancer_a),
    ];
    t.contract.submit_invoices_batch(&batch1);

    let after_first = t.contract.get_reputation(&t.freelancer_a);
    assert_eq!(after_first.invoices_submitted, 2);

    // Second batch of 3.
    let batch2 = soroban_sdk::vec![
        &t.env,
        make_param(&t, &t.freelancer_a),
        make_param(&t, &t.freelancer_a),
        make_param(&t, &t.freelancer_a),
    ];
    t.contract.submit_invoices_batch(&batch2);

    let after_second = t.contract.get_reputation(&t.freelancer_a);
    assert_eq!(
        after_second.invoices_submitted, 5,
        "cumulative count should be 5 after two batches"
    );
}

// ── Multiple freelancers in one batch ────────────────────────────────────────

#[test]
fn test_batch_with_two_freelancers_increments_each_independently() {
    let t = setup_batch_rep();

    let invoices = soroban_sdk::vec![
        &t.env,
        make_param(&t, &t.freelancer_a),
        make_param(&t, &t.freelancer_b),
        make_param(&t, &t.freelancer_a),
    ];

    t.contract.submit_invoices_batch(&invoices);

    let rep_a = t.contract.get_reputation(&t.freelancer_a);
    let rep_b = t.contract.get_reputation(&t.freelancer_b);

    assert_eq!(rep_a.invoices_submitted, 2, "freelancer_a submitted 2");
    assert_eq!(rep_b.invoices_submitted, 1, "freelancer_b submitted 1");
}

// ── Parity with single submit ────────────────────────────────────────────────

#[test]
fn test_single_submit_and_batch_submit_produce_same_delta() {
    let env = Env::default();
    env.mock_all_auths();

    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_addr = usdc_id.address();

    let token_admin_client = StellarAssetClient::new(&env, &usdc_addr);
    let freelancer_single = Address::generate(&env);
    let freelancer_batch = Address::generate(&env);
    let payer = Address::generate(&env);
    token_admin_client.mint(&payer, &(INVOICE_AMOUNT * 10));

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);

    let xlm_admin = Address::generate(&env);
    let xlm_id = env.register_stellar_asset_contract_v2(xlm_admin);
    let xlm_addr = xlm_id.address();
    let eurc_addr = Address::generate(&env);
    contract.initialize(&usdc_admin, &usdc_addr, &eurc_addr, &xlm_addr);

    let mut ledger = env.ledger().get();
    ledger.timestamp = 1_700_000_000;
    env.ledger().set(ledger);

    let due_date = env.ledger().timestamp() + DUE_DATE_OFFSET;

    // Single submit for freelancer_single.
    contract.submit_invoice(
        &freelancer_single,
        &payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &usdc_addr,
        &ReferralCode::None,
    );

    // Batch submit (1 invoice) for freelancer_batch.
    let invoices = soroban_sdk::vec![
        &env,
        InvoiceParams {
            freelancer: freelancer_batch.clone(),
            payer: payer.clone(),
            amount: INVOICE_AMOUNT,
            due_date,
            discount_rate: DISCOUNT_RATE,
            token: usdc_addr.clone(),
            referral_code: ReferralCode::None,
        }
    ];
    contract.submit_invoices_batch(&invoices);

    let rep_single = contract.get_reputation(&freelancer_single);
    let rep_batch = contract.get_reputation(&freelancer_batch);

    assert_eq!(
        rep_single.invoices_submitted, rep_batch.invoices_submitted,
        "single submit and batch submit should produce the same invoices_submitted increment"
    );
    assert_eq!(rep_single.invoices_submitted, 1);
}

// ── Zero invoices_defaulted/paid after mere submission ───────────────────────

#[test]
fn test_batch_submit_does_not_affect_paid_or_defaulted_counts() {
    let t = setup_batch_rep();

    let invoices = soroban_sdk::vec![
        &t.env,
        make_param(&t, &t.freelancer_a),
        make_param(&t, &t.freelancer_a),
    ];
    t.contract.submit_invoices_batch(&invoices);

    let profile = t.contract.get_reputation(&t.freelancer_a);
    assert_eq!(profile.invoices_paid, 0);
    assert_eq!(profile.invoices_defaulted, 0);
    assert_eq!(profile.invoices_submitted, 2);
}
