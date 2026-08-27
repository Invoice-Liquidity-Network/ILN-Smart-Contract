//! Tests for Issue #invoice-count — get_invoice_count underflow safety
//!
//! Scenarios covered:
//!  - get_invoice_count on uninitialized contract returns 0 (no underflow)
//!  - get_invoice_count after initialization returns 0
//!  - get_invoice_count after first submit returns 1
//!  - get_invoice_count after N submits returns N

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

#[allow(dead_code)]
struct CountTestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token_addr: Address,
    _admin: Address,
    freelancer: Address,
    payer: Address,
}

fn setup_count() -> CountTestEnv {
    let env = Env::default();
    env.mock_all_auths();

    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_addr = usdc_id.address();

    let token_admin_client = StellarAssetClient::new(&env, &usdc_addr);
    let freelancer = Address::generate(&env);
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

    CountTestEnv {
        env,
        contract,
        token_addr: usdc_addr,
        _admin: usdc_admin,
        freelancer,
        payer,
    }
}

fn submit_one(t: &CountTestEnv) -> u64 {
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token_addr,
        &ReferralCode::None,
    )
}

// ── Pre-initialization safety ────────────────────────────────────────────────

#[test]
fn test_get_invoice_count_on_uninitialized_contract_returns_zero() {
    // Register a *new* contract but do NOT call initialize — simulates a
    // freshly deployed contract before any setup transaction.
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);

    // Must not panic (no underflow on u64) and must return 0.
    let count = contract.get_invoice_count();
    assert_eq!(count, 0, "Uninitialized contract should report 0 invoices");
}

// ── Post-initialization, zero invoices ───────────────────────────────────────

#[test]
fn test_get_invoice_count_after_init_returns_zero() {
    let t = setup_count();

    let count = t.contract.get_invoice_count();
    assert_eq!(count, 0, "No invoices should exist after initialization");
}

// ── After first invoice ───────────────────────────────────────────────────────

#[test]
fn test_get_invoice_count_after_first_submit_returns_one() {
    let t = setup_count();

    submit_one(&t);

    let count = t.contract.get_invoice_count();
    assert_eq!(count, 1);
}

// ── After multiple invoices ───────────────────────────────────────────────────

#[test]
fn test_get_invoice_count_increments_with_each_submit() {
    let t = setup_count();

    for expected_count in 1u64..=5 {
        submit_one(&t);
        assert_eq!(t.contract.get_invoice_count(), expected_count);
    }
}

#[test]
fn test_get_invoice_count_matches_batch_submit_count() {
    let t = setup_count();

    // Batch submit 3 invoices.
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoices = soroban_sdk::vec![
        &t.env,
        InvoiceParams {
            freelancer: t.freelancer.clone(),
            payer: t.payer.clone(),
            amount: INVOICE_AMOUNT,
            due_date,
            discount_rate: DISCOUNT_RATE,
            token: t.token_addr.clone(),
            referral_code: ReferralCode::None,
        },
        InvoiceParams {
            freelancer: t.freelancer.clone(),
            payer: t.payer.clone(),
            amount: INVOICE_AMOUNT,
            due_date,
            discount_rate: DISCOUNT_RATE,
            token: t.token_addr.clone(),
            referral_code: ReferralCode::None,
        },
        InvoiceParams {
            freelancer: t.freelancer.clone(),
            payer: t.payer.clone(),
            amount: INVOICE_AMOUNT,
            due_date,
            discount_rate: DISCOUNT_RATE,
            token: t.token_addr.clone(),
            referral_code: ReferralCode::None,
        },
    ];

    t.contract.submit_invoices_batch(&invoices);

    assert_eq!(t.contract.get_invoice_count(), 3);
}
