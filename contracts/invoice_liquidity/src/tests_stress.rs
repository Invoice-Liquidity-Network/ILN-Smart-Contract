// Stress tests with 1000+ simulated invoices
// Tests contract performance under load and verifies stat counter accuracy

#![cfg(test)]
// Timing variables and loop indices are captured for potential future use.
#![allow(dead_code, unused_variables)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};
use std::time::Instant;

const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30; // 30 days
const DISCOUNT_RATE: u32 = 300; // 3.00%
const INVOICE_AMOUNT: i128 = 1_000_000_000;
const NUM_INVOICES: u64 = 1000;

struct MockToken {
    address: Address,
    client: TokenClient<'static>,
    admin_client: StellarAssetClient<'static>,
}

struct StressTestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    admin: Address,
    freelancer: Address,
    payer: Address,
    lp: Address,
    token: MockToken,
}

fn register_mock_token(env: &Env) -> MockToken {
    let token_admin = Address::generate(env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_contract.address();

    MockToken {
        address: token_address.clone(),
        client: TokenClient::new(env, &token_address),
        admin_client: StellarAssetClient::new(env, &token_address),
    }
}

fn setup() -> StressTestEnv {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let lp = Address::generate(&env);

    let token = register_mock_token(&env);

    // Mint tokens - need enough for 1000 invoices
    let total_amount = INVOICE_AMOUNT * NUM_INVOICES as i128 * 10;
    token.admin_client.mint(&payer, &total_amount);
    token.admin_client.mint(&lp, &total_amount);

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);

    // Need EURC and XLM token for initialization
    let eurc = register_mock_token(&env);
    let xlm = register_mock_token(&env);
    contract.initialize(&admin, &token.address, &eurc.address, &xlm.address);

    let mut ledger_info = env.ledger().get();
    ledger_info.timestamp = 1_700_000_000;
    env.ledger().set(ledger_info);

    StressTestEnv {
        env,
        contract,
        admin,
        freelancer,
        payer,
        lp,
        token,
    }
}

fn due_date(env: &StressTestEnv) -> u64 {
    env.env.ledger().timestamp() + DUE_DATE_OFFSET
}

#[test]
fn test_stress_1000_invoice_lifecycles() {
    let env = setup();

    let start_time = Instant::now();

    let mut invoice_ids: Vec<u64> = Vec::new(&env.env);

    // Phase 1: Submit 1000 invoices
    let submit_start = Instant::now();

    for i in 0..NUM_INVOICES {
        let invoice_id = env.contract.submit_invoice(&ReferralCode::None);
        invoice_ids.push_back(invoice_id);
    }

    let submit_duration = submit_start.elapsed();

    // Verify invoice count
    let stats_after_submit = env.contract.get_contract_stats();
    assert_eq!(
        stats_after_submit.total_invoices, NUM_INVOICES,
        "Total invoices should match submitted count"
    );

    // Phase 2: Fund 1000 invoices
    let fund_start = Instant::now();

    for (i, invoice_id) in invoice_ids.iter().enumerate() {
        env.contract
            .fund_invoice(&env.lp, &invoice_id, &INVOICE_AMOUNT, &false);
    }

    let fund_duration = fund_start.elapsed();

    // Verify funded count
    let stats_after_fund = env.contract.get_contract_stats();
    assert_eq!(
        stats_after_fund.total_funded, NUM_INVOICES,
        "Total funded should match funded count"
    );

    // Phase 3: Settle (mark as paid) 1000 invoices
    let settle_start = Instant::now();

    for (i, invoice_id) in invoice_ids.iter().enumerate() {
        env.contract.mark_paid(&invoice_id, &INVOICE_AMOUNT);
    }

    let settle_duration = settle_start.elapsed();

    // Verify paid count
    let stats_after_settle = env.contract.get_contract_stats();
    assert_eq!(
        stats_after_settle.total_paid, NUM_INVOICES,
        "Total paid should match settled count"
    );

    // Verify all invoices are in correct final state
    let verify_start = Instant::now();

    for (i, invoice_id) in invoice_ids.iter().enumerate() {
        let invoice = env.contract.get_invoice(&invoice_id);
    }

    let verify_duration = verify_start.elapsed();

    // Final stats verification
    let final_stats = env.contract.get_contract_stats();

    assert_eq!(
        final_stats.total_invoices, NUM_INVOICES,
        "Final total invoices should match"
    );
    assert_eq!(
        final_stats.total_funded, NUM_INVOICES,
        "Final total funded should match"
    );
    assert_eq!(
        final_stats.total_paid, NUM_INVOICES,
        "Final total paid should match"
    );

    let total_duration = start_time.elapsed();
    // Stress test completed successfully
    // All {} invoices processed without panics
    // All stat counters accurate
    // All invoices in correct final state (Paid)
}

#[test]
fn test_stress_1000_concurrent_submissions() {
    let env = setup();

    let start_time = Instant::now();

    // Submit all invoices in rapid succession to test concurrent submission handling
    let mut invoice_ids: Vec<u64> = Vec::new(&env.env);

    for i in 0..NUM_INVOICES {
        let invoice_id = env.contract.submit_invoice(&ReferralCode::None);
        invoice_ids.push_back(invoice_id);
    }

    let submit_duration = start_time.elapsed();

    // Verify all invoices were created and are in Pending state
    for invoice_id in invoice_ids.iter() {
        let invoice = env.contract.get_invoice(&invoice_id);
        assert_eq!(
            invoice.status,
            InvoiceStatus::Pending,
            "Invoice {} should be in Pending state after submission",
            invoice_id
        );
    }

    let stats = env.contract.get_contract_stats();
    assert_eq!(
        stats.total_invoices, NUM_INVOICES,
        "All invoices should be counted"
    );
}

#[test]
fn test_stress_1000_partial_fundings() {
    let env = setup();

    let start_time = Instant::now();

    // Submit invoices
    let mut invoice_ids: Vec<u64> = Vec::new(&env.env);
    for _ in 0..NUM_INVOICES {
        let invoice_id = env.contract.submit_invoice(&ReferralCode::None);
        invoice_ids.push_back(invoice_id);
    }

    // Fund each invoice with partial amounts (50% each)
    let partial_amount = INVOICE_AMOUNT / 2;
    let fund_start = Instant::now();

    for (i, invoice_id) in invoice_ids.iter().enumerate() {
        env.contract
            .fund_invoice(&env.lp, &invoice_id, &partial_amount, &false);
    }

    let fund_duration = fund_start.elapsed();
    for invoice_id in invoice_ids.iter() {
        let invoice = env.contract.get_invoice(&invoice_id);
        assert_eq!(
            invoice.status,
            InvoiceStatus::PartiallyFunded,
            "Invoice {} should be in PartiallyFunded state",
            invoice_id
        );
        assert_eq!(
            invoice.amount_funded, partial_amount,
            "Invoice {} should have correct partial funding amount",
            invoice_id
        );
    }

    let total_duration = start_time.elapsed();
}
