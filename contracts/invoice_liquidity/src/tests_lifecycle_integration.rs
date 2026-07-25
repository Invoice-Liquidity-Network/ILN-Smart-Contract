// End-to-end integration test for the full invoice lifecycle
// Tests submit → fund → mark_paid with state, events, and balance verification

#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30; // 30 days
const DISCOUNT_RATE: u32 = 300; // 3.00%
const INVOICE_AMOUNT: i128 = 1_000_000_000;

struct MockToken {
    address: Address,
    client: TokenClient<'static>,
    admin_client: StellarAssetClient<'static>,
}

#[allow(dead_code)]
struct LifecycleTestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    admin: Address,
    freelancer: Address,
    payer: Address,
    lp: Address,
    token: MockToken,
    xlm: MockToken,
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

fn setup() -> LifecycleTestEnv {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let lp = Address::generate(&env);

    let token = register_mock_token(&env);
    let xlm = register_mock_token(&env);

    // Mint tokens
    token.admin_client.mint(&payer, &(INVOICE_AMOUNT * 10));
    token.admin_client.mint(&lp, &(INVOICE_AMOUNT * 10));
    xlm.admin_client.mint(&payer, &(INVOICE_AMOUNT * 100));
    xlm.admin_client.mint(&lp, &(INVOICE_AMOUNT * 100));

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);
    let eurc_address = Address::generate(&env);
    contract.initialize(&admin, &token.address, &eurc_address, &xlm.address);

    let mut ledger_info = env.ledger().get();
    ledger_info.timestamp = 1_700_000_000;
    env.ledger().set(ledger_info);

    LifecycleTestEnv {
        env,
        contract,
        admin,
        freelancer,
        payer,
        lp,
        token,
        xlm,
    }
}

fn due_date(env: &LifecycleTestEnv) -> u64 {
    env.env.ledger().timestamp() + DUE_DATE_OFFSET
}

fn expected_discount(amount: i128) -> i128 {
    amount * DISCOUNT_RATE as i128 / 10_000
}

#[test]
fn test_lifecycle_usdc_full() {
    let env = setup();

    // Get initial balances
    let freelancer_balance_before = env.token.client.balance(&env.freelancer);
    let lp_balance_before = env.token.client.balance(&env.lp);
    let payer_balance_before = env.token.client.balance(&env.payer);

    // Get initial stats
    let stats_initial = env.contract.get_contract_stats();

    // Step 1: Submit invoice
    let invoice_id = env.contract.submit_invoice(&ReferralCode::None);

    // Verify Pending state
    let invoice_pending = env.contract.get_invoice(&invoice_id);
    assert_eq!(invoice_pending.status, InvoiceStatus::Pending);
    assert_eq!(invoice_pending.amount, INVOICE_AMOUNT);
    assert_eq!(invoice_pending.discount_rate, DISCOUNT_RATE);
    assert_eq!(invoice_pending.token, env.token.address);
    assert_eq!(invoice_pending.freelancer, env.freelancer);
    assert_eq!(invoice_pending.payer, env.payer);

    // Verify stats after submission
    let stats_after_submit = env.contract.get_contract_stats();
    assert_eq!(
        stats_after_submit.total_invoices,
        stats_initial.total_invoices + 1
    );

    // Step 2: Fund invoice
    env.contract
        .fund_invoice(&env.lp, &invoice_id, &INVOICE_AMOUNT, &false);

    let discount = expected_discount(INVOICE_AMOUNT);
    let expected_payout = INVOICE_AMOUNT - discount;

    // Verify freelancer received payout
    let freelancer_balance_after_fund = env.token.client.balance(&env.freelancer);
    assert_eq!(
        freelancer_balance_after_fund - freelancer_balance_before,
        expected_payout,
        "Freelancer should receive amount minus discount"
    );

    // Verify LP paid the payout amount
    let lp_balance_after_fund = env.token.client.balance(&env.lp);
    assert_eq!(
        lp_balance_before - lp_balance_after_fund,
        expected_payout,
        "LP should pay the payout amount"
    );

    // Verify Funded state
    let invoice_funded = env.contract.get_invoice(&invoice_id);
    assert_eq!(invoice_funded.status, InvoiceStatus::Funded);
    assert_eq!(invoice_funded.amount_funded, INVOICE_AMOUNT);
    assert_eq!(invoice_funded.funder, Some(env.lp.clone()));

    // Verify stats after funding
    let stats_after_fund = env.contract.get_contract_stats();
    assert_eq!(
        stats_after_fund.total_funded,
        stats_initial.total_funded + 1
    );

    // Step 3: Mark as paid
    env.contract.mark_paid(&invoice_id, &INVOICE_AMOUNT);

    // Verify LP received yield (net gain is discount)
    let lp_balance_final = env.token.client.balance(&env.lp);
    assert_eq!(
        lp_balance_final - lp_balance_before,
        discount,
        "LP should earn yield (discount amount)"
    );

    // Verify payer paid full amount
    let payer_balance_after_paid = env.token.client.balance(&env.payer);
    assert_eq!(
        payer_balance_before - payer_balance_after_paid,
        INVOICE_AMOUNT,
        "Payer should pay full amount"
    );

    // Verify Paid state
    let invoice_paid = env.contract.get_invoice(&invoice_id);
    assert_eq!(invoice_paid.status, InvoiceStatus::Paid);
    assert_eq!(invoice_paid.amount_paid, INVOICE_AMOUNT);

    // Verify stats after payment
    let stats_after_paid = env.contract.get_contract_stats();
    assert_eq!(stats_after_paid.total_paid, stats_initial.total_paid + 1);
}

#[test]
fn test_lifecycle_eurc_full() {
    let env = setup();

    // Add EURC as an approved token
    let eurc = register_mock_token(&env.env);
    eurc.admin_client.mint(&env.payer, &(INVOICE_AMOUNT * 10));
    eurc.admin_client.mint(&env.lp, &(INVOICE_AMOUNT * 10));
    env.contract.add_token(&eurc.address);

    // Get initial balances
    let freelancer_balance_before = eurc.client.balance(&env.freelancer);
    let lp_balance_before = eurc.client.balance(&env.lp);
    let payer_balance_before = eurc.client.balance(&env.payer);

    // Get initial stats
    let stats_initial = env.contract.get_contract_stats();

    // Step 1: Submit invoice with EURC
    let invoice_id = env.contract.submit_invoice(&ReferralCode::None);

    // Verify Pending state
    let invoice_pending = env.contract.get_invoice(&invoice_id);
    assert_eq!(invoice_pending.status, InvoiceStatus::Pending);
    assert_eq!(invoice_pending.token, eurc.address);

    // Step 2: Fund invoice
    env.contract
        .fund_invoice(&env.lp, &invoice_id, &INVOICE_AMOUNT, &false);

    let discount = expected_discount(INVOICE_AMOUNT);
    let expected_payout = INVOICE_AMOUNT - discount;

    // Verify balances
    assert_eq!(
        eurc.client.balance(&env.freelancer) - freelancer_balance_before,
        expected_payout
    );
    assert_eq!(
        lp_balance_before - eurc.client.balance(&env.lp),
        expected_payout
    );

    // Verify Funded state
    let invoice_funded = env.contract.get_invoice(&invoice_id);
    assert_eq!(invoice_funded.status, InvoiceStatus::Funded);

    // Step 3: Mark as paid
    env.contract.mark_paid(&invoice_id, &INVOICE_AMOUNT);

    // Verify LP received yield (net gain is discount)
    let lp_balance_final = eurc.client.balance(&env.lp);
    assert_eq!(lp_balance_final - lp_balance_before, discount);

    // Verify payer paid full amount
    assert_eq!(
        payer_balance_before - eurc.client.balance(&env.payer),
        INVOICE_AMOUNT
    );

    // Verify Paid state
    let invoice_paid = env.contract.get_invoice(&invoice_id);
    assert_eq!(invoice_paid.status, InvoiceStatus::Paid);

    // Verify stats
    let stats_final = env.contract.get_contract_stats();
    assert_eq!(stats_final.total_invoices, stats_initial.total_invoices + 1);
    assert_eq!(stats_final.total_funded, stats_initial.total_funded + 1);
    assert_eq!(stats_final.total_paid, stats_initial.total_paid + 1);
}

#[test]
fn test_lifecycle_xlm_full() {
    let env = setup();

    // Get initial balances
    let freelancer_balance_before = env.xlm.client.balance(&env.freelancer);
    let lp_balance_before = env.xlm.client.balance(&env.lp);
    let payer_balance_before = env.xlm.client.balance(&env.payer);

    // Get initial stats
    let stats_initial = env.contract.get_contract_stats();

    // Step 1: Submit invoice with XLM
    let invoice_id = env.contract.submit_invoice(&ReferralCode::None);

    // Verify Pending state
    let invoice_pending = env.contract.get_invoice(&invoice_id);
    assert_eq!(invoice_pending.status, InvoiceStatus::Pending);
    assert_eq!(invoice_pending.token, env.xlm.address);

    // Step 2: Fund invoice
    env.contract
        .fund_invoice(&env.lp, &invoice_id, &INVOICE_AMOUNT, &false);

    let discount = expected_discount(INVOICE_AMOUNT);
    let expected_payout = INVOICE_AMOUNT - discount;

    // Verify balances
    assert_eq!(
        env.xlm.client.balance(&env.freelancer) - freelancer_balance_before,
        expected_payout
    );
    assert_eq!(
        lp_balance_before - env.xlm.client.balance(&env.lp),
        expected_payout
    );

    // Verify Funded state
    let invoice_funded = env.contract.get_invoice(&invoice_id);
    assert_eq!(invoice_funded.status, InvoiceStatus::Funded);

    // Step 3: Mark as paid
    env.contract.mark_paid(&invoice_id, &INVOICE_AMOUNT);

    // Verify LP received yield (net gain is discount)
    let lp_balance_final = env.xlm.client.balance(&env.lp);
    assert_eq!(lp_balance_final - lp_balance_before, discount);

    // Verify payer paid full amount
    assert_eq!(
        payer_balance_before - env.xlm.client.balance(&env.payer),
        INVOICE_AMOUNT
    );

    // Verify Paid state
    let invoice_paid = env.contract.get_invoice(&invoice_id);
    assert_eq!(invoice_paid.status, InvoiceStatus::Paid);

    // Verify stats
    let stats_final = env.contract.get_contract_stats();
    assert_eq!(stats_final.total_invoices, stats_initial.total_invoices + 1);
    assert_eq!(stats_final.total_funded, stats_initial.total_funded + 1);
    assert_eq!(stats_final.total_paid, stats_initial.total_paid + 1);
}

#[test]
fn test_lifecycle_stat_counters_increment() {
    let env = setup();

    // Get initial stats
    let stats_initial = env.contract.get_contract_stats();

    // Submit invoice
    let invoice_id = env.contract.submit_invoice(&ReferralCode::None);

    // Verify total_invoices incremented
    let stats_after_submit = env.contract.get_contract_stats();
    assert_eq!(
        stats_after_submit.total_invoices,
        stats_initial.total_invoices + 1
    );
    assert_eq!(stats_after_submit.total_funded, stats_initial.total_funded);
    assert_eq!(stats_after_submit.total_paid, stats_initial.total_paid);

    // Fund invoice
    env.contract
        .fund_invoice(&env.lp, &invoice_id, &INVOICE_AMOUNT, &false);

    // Verify total_funded incremented
    let stats_after_fund = env.contract.get_contract_stats();
    assert_eq!(
        stats_after_fund.total_invoices,
        stats_initial.total_invoices + 1
    );
    assert_eq!(
        stats_after_fund.total_funded,
        stats_initial.total_funded + 1
    );
    assert_eq!(stats_after_fund.total_paid, stats_initial.total_paid);

    // Mark as paid
    env.contract.mark_paid(&invoice_id, &INVOICE_AMOUNT);

    // Verify total_paid incremented
    let stats_after_paid = env.contract.get_contract_stats();
    assert_eq!(
        stats_after_paid.total_invoices,
        stats_initial.total_invoices + 1
    );
    assert_eq!(
        stats_after_paid.total_funded,
        stats_initial.total_funded + 1
    );
    assert_eq!(stats_after_paid.total_paid, stats_initial.total_paid + 1);
}
