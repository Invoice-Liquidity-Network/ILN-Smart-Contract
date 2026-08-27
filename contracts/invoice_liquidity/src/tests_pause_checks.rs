//! Tests for Issue #pause-checks — expire_invoice and appeal_default pause guards
//!
//! Scenarios covered:
//!  - expire_invoice returns ContractPaused when contract is paused
//!  - expire_invoice succeeds when contract is unpaused
//!  - appeal_default returns ContractPaused when contract is paused
//!  - appeal_default succeeds when contract is unpaused
//!  - Pausing and then unpausing restores normal operation for both functions

#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, BytesN, Env,
};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30; // 30 days

#[allow(dead_code)]
struct PauseTestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: TokenClient<'static>,
    _admin: Address,
    freelancer: Address,
    payer: Address,
    funder: Address,
}

fn setup_pause() -> PauseTestEnv {
    let env = Env::default();
    env.mock_all_auths();

    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_addr = usdc_id.address();

    let token = TokenClient::new(&env, &usdc_addr);
    let token_admin = StellarAssetClient::new(&env, &usdc_addr);

    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let funder = Address::generate(&env);

    token_admin.mint(&funder, &(INVOICE_AMOUNT * 10));
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
    env.ledger().set(ledger);

    PauseTestEnv {
        env,
        contract,
        token,
        _admin: usdc_admin,
        freelancer,
        payer,
        funder,
    }
}

fn submit_invoice_pause(t: &PauseTestEnv) -> u64 {
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

/// Submit an invoice, fund it, then advance time past due_date so it can be
/// claimed as a default. Returns the invoice id.
fn make_defaulted_invoice(t: &PauseTestEnv) -> u64 {
    let id = submit_invoice_pause(t);

    // Fund the invoice.
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);

    // Advance past the due date.
    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 1;
    t.env.ledger().set(ledger);

    // Claim the default.
    t.contract.claim_default(&t.funder, &id);

    id
}

fn evidence_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[1u8; 32])
}

// ── expire_invoice pause check ────────────────────────────────────────────────

#[test]
fn test_expire_invoice_fails_when_paused() {
    let t = setup_pause();
    let id = submit_invoice_pause(&t);

    // Advance past due date so expiry would otherwise succeed.
    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 1;
    t.env.ledger().set(ledger);

    // Pause the contract.
    t.contract.pause();

    let result = t.contract.try_expire_invoice(&id);
    assert_eq!(
        result,
        Err(Ok(ContractError::ContractPaused)),
        "expire_invoice must return ContractPaused when contract is paused"
    );
}

#[test]
fn test_expire_invoice_succeeds_when_not_paused() {
    let t = setup_pause();
    let id = submit_invoice_pause(&t);

    // Advance past due date.
    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 1;
    t.env.ledger().set(ledger);

    // Contract is NOT paused — must succeed.
    let result = t.contract.try_expire_invoice(&id);
    assert!(
        result.is_ok(),
        "expire_invoice should succeed when not paused"
    );

    let invoice = t.contract.get_invoice(&id);
    assert_eq!(invoice.status, InvoiceStatus::Expired);
}

#[test]
fn test_expire_invoice_succeeds_after_unpause() {
    let t = setup_pause();
    let id = submit_invoice_pause(&t);

    // Advance past due date.
    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 1;
    t.env.ledger().set(ledger);

    // Pause then unpause.
    t.contract.pause();
    let paused_result = t.contract.try_expire_invoice(&id);
    assert_eq!(paused_result, Err(Ok(ContractError::ContractPaused)));

    t.contract.unpause();
    let unpaused_result = t.contract.try_expire_invoice(&id);
    assert!(
        unpaused_result.is_ok(),
        "expire_invoice should work again after unpause"
    );
}

// ── appeal_default pause check ────────────────────────────────────────────────

#[test]
fn test_appeal_default_fails_when_paused() {
    let t = setup_pause();
    let id = make_defaulted_invoice(&t);

    // Pause the contract.
    t.contract.pause();

    let result = t.contract.try_appeal_default(&id, &evidence_hash(&t.env));
    assert_eq!(
        result,
        Err(Ok(ContractError::ContractPaused)),
        "appeal_default must return ContractPaused when contract is paused"
    );
}

#[test]
fn test_appeal_default_succeeds_when_not_paused() {
    let t = setup_pause();
    let id = make_defaulted_invoice(&t);

    // Contract is NOT paused — must succeed.
    let result = t.contract.try_appeal_default(&id, &evidence_hash(&t.env));
    assert!(
        result.is_ok(),
        "appeal_default should succeed when not paused"
    );

    let invoice = t.contract.get_invoice(&id);
    assert_eq!(invoice.status, InvoiceStatus::Appealed);
}

#[test]
fn test_appeal_default_succeeds_after_unpause() {
    let t = setup_pause();
    let id = make_defaulted_invoice(&t);

    // Pause then unpause.
    t.contract.pause();
    let paused_result = t.contract.try_appeal_default(&id, &evidence_hash(&t.env));
    assert_eq!(paused_result, Err(Ok(ContractError::ContractPaused)));

    t.contract.unpause();
    let unpaused_result = t.contract.try_appeal_default(&id, &evidence_hash(&t.env));
    assert!(
        unpaused_result.is_ok(),
        "appeal_default should work again after unpause"
    );
}

// ── Both checks together ──────────────────────────────────────────────────────

#[test]
fn test_pause_blocks_both_expire_and_appeal_simultaneously() {
    let t = setup_pause();

    // Prepare an invoice that can be expired (not funded, past due_date).
    let expire_id = submit_invoice_pause(&t);

    // Prepare an invoice that can be appealed (funded, defaulted).
    let appeal_id = make_defaulted_invoice(&t);

    // Advance time to make expire_id expirable.
    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 2;
    t.env.ledger().set(ledger);

    // Pause the contract.
    t.contract.pause();

    // Both must be blocked.
    let expire_result = t.contract.try_expire_invoice(&expire_id);
    let appeal_result = t
        .contract
        .try_appeal_default(&appeal_id, &evidence_hash(&t.env));

    assert_eq!(expire_result, Err(Ok(ContractError::ContractPaused)));
    assert_eq!(appeal_result, Err(Ok(ContractError::ContractPaused)));
}
