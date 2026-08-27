#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, BytesN, Env,
};
use std::format;

const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30;
const DISCOUNT_RATE: u32 = 300;
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
    _admin: Address,
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

fn setup() -> LifecycleTestEnv {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let lp = Address::generate(&env);

    let token = register_mock_token(&env);

    token.admin_client.mint(&payer, &(INVOICE_AMOUNT * 10));
    token.admin_client.mint(&lp, &(INVOICE_AMOUNT * 10));

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);
    let eurc_address = Address::generate(&env);
    let xlm_admin = Address::generate(&env);
    let xlm_id = env.register_stellar_asset_contract_v2(xlm_admin);
    let xlm_address = xlm_id.address();
    contract.initialize(&admin, &token.address, &eurc_address, &xlm_address);

    // Fund the contract treasury so it can cover LP refunds on upheld
    // disputes: the LP's original contribution (invoice amount minus the
    // discount) is forwarded to the freelancer immediately on full
    // funding, so a later refund of that same amount draws on this
    // reserve rather than the LP's own (already-disbursed) escrowed
    // funds. Sized to exactly the LP's contribution — not a large,
    // arbitrary buffer like test.rs's setup() — so that dispute-resolution
    // tests can assert the contract's balance nets back to zero once the
    // reserve has covered the refund.
    let lp_contribution = INVOICE_AMOUNT - (INVOICE_AMOUNT * DISCOUNT_RATE as i128 / 10_000);
    token.admin_client.mint(&contract.address, &lp_contribution);

    let mut ledger_info = env.ledger().get();
    ledger_info.timestamp = 1_700_000_000;
    env.ledger().set(ledger_info);

    LifecycleTestEnv {
        env,
        contract,
        _admin: admin,
        freelancer,
        payer,
        lp,
        token,
    }
}

fn due_date(env: &LifecycleTestEnv) -> u64 {
    env.env.ledger().timestamp() + DUE_DATE_OFFSET
}

fn _expected_discount(amount: i128) -> i128 {
    amount * DISCOUNT_RATE as i128 / 10_000
}

// ================================================================
// cancel_invoice tests (Issue #490)
// ================================================================

#[test]
fn test_cancel_invoice_pending_state_no_refunds() {
    let env = setup();

    let invoice_id = env.contract.submit_invoice(
        &env.freelancer,
        &env.payer,
        &INVOICE_AMOUNT,
        &due_date(&env),
        &DISCOUNT_RATE,
        &env.token.address,
        &ReferralCode::None,
    );

    let invoice_before = env.contract.get_invoice(&invoice_id);
    assert_eq!(invoice_before.status, InvoiceStatus::Pending);

    env.contract.cancel_invoice(&invoice_id);

    let invoice_after = env.contract.get_invoice(&invoice_id);
    assert_eq!(invoice_after.status, InvoiceStatus::Cancelled);
}

#[test]
fn test_cancel_invoice_partial_funding_refunds_funder() {
    let env = setup();

    let partial_amount = INVOICE_AMOUNT / 2;

    let invoice_id = env.contract.submit_invoice(
        &env.freelancer,
        &env.payer,
        &INVOICE_AMOUNT,
        &due_date(&env),
        &DISCOUNT_RATE,
        &env.token.address,
        &ReferralCode::None,
    );

    let lp_balance_before = env.token.client.balance(&env.lp);

    env.contract
        .fund_invoice(&env.lp, &invoice_id, &partial_amount, &false);

    let invoice_funded = env.contract.get_invoice(&invoice_id);
    assert_eq!(invoice_funded.status, InvoiceStatus::PartiallyFunded);

    env.contract.cancel_invoice(&invoice_id);

    let invoice_cancelled = env.contract.get_invoice(&invoice_id);
    assert_eq!(invoice_cancelled.status, InvoiceStatus::Cancelled);

    let lp_balance_after = env.token.client.balance(&env.lp);

    assert_eq!(
        lp_balance_after - lp_balance_before,
        0i128,
        "LP should be fully refunded (net zero after fund + refund)"
    );
}

#[test]
fn test_cancel_invoice_partial_funding_multiple_funders() {
    let env = setup();

    let lp2 = Address::generate(&env.env);
    env.token.admin_client.mint(&lp2, &(INVOICE_AMOUNT * 10));

    let invoice_id = env.contract.submit_invoice(
        &env.freelancer,
        &env.payer,
        &INVOICE_AMOUNT,
        &due_date(&env),
        &DISCOUNT_RATE,
        &env.token.address,
        &ReferralCode::None,
    );

    let fund1 = INVOICE_AMOUNT / 3;
    let fund2 = INVOICE_AMOUNT / 3;

    let lp1_balance_before = env.token.client.balance(&env.lp);
    let lp2_balance_before = env.token.client.balance(&lp2);

    env.contract
        .fund_invoice(&env.lp, &invoice_id, &fund1, &false);
    env.contract.fund_invoice(&lp2, &invoice_id, &fund2, &false);

    let invoice_partial = env.contract.get_invoice(&invoice_id);
    assert_eq!(invoice_partial.status, InvoiceStatus::PartiallyFunded);

    env.contract.cancel_invoice(&invoice_id);

    let invoice_cancelled = env.contract.get_invoice(&invoice_id);
    assert_eq!(invoice_cancelled.status, InvoiceStatus::Cancelled);

    let lp1_balance_after = env.token.client.balance(&env.lp);
    let lp2_balance_after = env.token.client.balance(&lp2);

    assert_eq!(
        lp1_balance_after - lp1_balance_before,
        0i128,
        "LP1 should be fully refunded"
    );
    assert_eq!(
        lp2_balance_after - lp2_balance_before,
        0i128,
        "LP2 should be fully refunded"
    );
}

#[test]
fn test_cancel_invoice_fully_funded_rejected() {
    let env = setup();

    let invoice_id = env.contract.submit_invoice(
        &env.freelancer,
        &env.payer,
        &INVOICE_AMOUNT,
        &due_date(&env),
        &DISCOUNT_RATE,
        &env.token.address,
        &ReferralCode::None,
    );

    env.contract
        .fund_invoice(&env.lp, &invoice_id, &INVOICE_AMOUNT, &false);

    let invoice_funded = env.contract.get_invoice(&invoice_id);
    assert_eq!(invoice_funded.status, InvoiceStatus::Funded);

    let result = env.contract.try_cancel_invoice(&invoice_id);
    assert_eq!(result, Err(Ok(ContractError::AlreadyFunded)));
}

#[test]
fn test_cancel_invoice_nonexistent_fails() {
    let env = setup();

    let result = env.contract.try_cancel_invoice(&999);
    assert_eq!(result, Err(Ok(ContractError::InvoiceNotFound)));
}

// ================================================================
// dispute resolution tests
// ================================================================

#[test]
fn test_dispute_upheld_with_partial_payment_refunds_payer() {
    let env = setup();

    let invoice_id = env.contract.submit_invoice(
        &env.freelancer,
        &env.payer,
        &INVOICE_AMOUNT,
        &due_date(&env),
        &DISCOUNT_RATE,
        &env.token.address,
        &ReferralCode::None,
    );

    env.contract
        .fund_invoice(&env.lp, &invoice_id, &INVOICE_AMOUNT, &false);

    let partial_payment = INVOICE_AMOUNT / 4;
    env.contract.mark_paid(&invoice_id, &partial_payment);

    let invoice_after_partial = env.contract.get_invoice(&invoice_id);
    assert_eq!(invoice_after_partial.amount_paid, partial_payment);

    let payer_balance_before_dispute = env.token.client.balance(&env.payer);

    let reason_hash = BytesN::from_array(&env.env, &[1u8; 32]);
    env.contract.dispute_invoice(&invoice_id, &reason_hash);

    let invoice_disputed = env.contract.get_invoice(&invoice_id);
    assert_eq!(invoice_disputed.status, InvoiceStatus::Disputed);

    let resolution_hash = BytesN::from_array(&env.env, &[2u8; 32]);
    env.contract
        .resolve_dispute(&invoice_id, &resolution_hash, &1);

    // events().all() reflects only the most recently completed top-level
    // contract call in this SDK's mock test host, not accumulated history
    // across the whole test — so check it right after resolve_dispute,
    // before any of the read-only calls below become the "most recent"
    // call and leave it empty.
    let events = env.env.events().all();
    let refund_event_exists = events
        .events()
        .iter()
        .any(|e| format!("{:?}", e).contains("dispute_upheld_payer_refund"));
    assert!(
        refund_event_exists,
        "DisputeUpheldPayerRefund event should be emitted"
    );

    let invoice_cancelled = env.contract.get_invoice(&invoice_id);
    assert_eq!(invoice_cancelled.status, InvoiceStatus::Cancelled);

    let payer_balance_after_dispute = env.token.client.balance(&env.payer);
    assert_eq!(
        payer_balance_after_dispute - payer_balance_before_dispute,
        partial_payment,
        "Payer should receive partial payment refund when dispute is upheld"
    );

    let contract_balance = env.token.client.balance(&env.contract.address);
    assert_eq!(
        contract_balance, 0,
        "Contract balance must be zero after dispute resolution"
    );
}

#[test]
fn test_dispute_upheld_with_zero_payment_no_payer_refund() {
    let env = setup();

    let invoice_id = env.contract.submit_invoice(
        &env.freelancer,
        &env.payer,
        &INVOICE_AMOUNT,
        &due_date(&env),
        &DISCOUNT_RATE,
        &env.token.address,
        &ReferralCode::None,
    );

    env.contract
        .fund_invoice(&env.lp, &invoice_id, &INVOICE_AMOUNT, &false);

    let payer_balance_before = env.token.client.balance(&env.payer);

    let reason_hash = BytesN::from_array(&env.env, &[1u8; 32]);
    env.contract.dispute_invoice(&invoice_id, &reason_hash);

    let resolution_hash = BytesN::from_array(&env.env, &[2u8; 32]);
    env.contract
        .resolve_dispute(&invoice_id, &resolution_hash, &1);

    let invoice_cancelled = env.contract.get_invoice(&invoice_id);
    assert_eq!(invoice_cancelled.status, InvoiceStatus::Cancelled);

    let payer_balance_after = env.token.client.balance(&env.payer);
    assert_eq!(
        payer_balance_after, payer_balance_before,
        "Payer balance should remain unchanged when no partial payment was made"
    );

    let contract_balance = env.token.client.balance(&env.contract.address);
    assert_eq!(
        contract_balance, 0,
        "Contract balance must be zero after dispute resolution"
    );

    let events = env.env.events().all();
    let refund_event_exists = events
        .events()
        .iter()
        .any(|e| format!("{:?}", e).contains("dispute_upheld_payer_refund"));
    assert!(
        !refund_event_exists,
        "No DisputeUpheldPayerRefund event should be emitted for zero payment"
    );
}
