#![cfg(test)]

//! Tests for new features:
//! - get_contract_stats() view
//! - pause/unpause emergency controls
//! - timestamp validation (MIN/MAX duration)
//! - submit_invoices_batch with mixed valid/invalid (Issue #480)

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Events as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, IntoVal,
};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30; // 30 days

#[allow(dead_code)]
struct TestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: TokenClient<'static>,
    admin: Address,
    freelancer: Address,
    payer: Address,
    funder: Address,
    /// EURC address — approved during `initialize`, distinct from `token`
    /// (USDC). Used to exercise convert_invoice_token's happy path (#478).
    eurc_address: Address,
}

fn setup() -> TestEnv {
    let env = Env::default();
    env.mock_all_auths();

    let usdc_admin = Address::generate(&env);
    let usdc_contract_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_address = usdc_contract_id.address();

    let token = TokenClient::new(&env, &usdc_address);
    let token_admin = StellarAssetClient::new(&env, &usdc_address);

    let admin = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let funder = Address::generate(&env);

    token_admin.mint(&funder, &(INVOICE_AMOUNT * 10));
    token_admin.mint(&payer, &(INVOICE_AMOUNT * 10));

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);
    token_admin.mint(&contract.address, &(INVOICE_AMOUNT * 100));

    let xlm_admin = Address::generate(&env);
    let xlm_contract_id = env.register_stellar_asset_contract_v2(xlm_admin);
    let xlm_address = xlm_contract_id.address();

    let eurc_admin = Address::generate(&env);
    let eurc_contract_id = env.register_stellar_asset_contract_v2(eurc_admin);
    let eurc_address = eurc_contract_id.address();

    contract.initialize(&admin, &usdc_address, &eurc_address, &xlm_address);

    let mut ledger_info = env.ledger().get();
    ledger_info.timestamp = 1_700_000_000;
    env.ledger().set(ledger_info);

    TestEnv {
        env,
        contract,
        token,
        admin,
        freelancer,
        payer,
        funder,
        eurc_address,
    }
}

fn make_invoice_params(t: &TestEnv) -> InvoiceParams {
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    InvoiceParams {
        freelancer: t.freelancer.clone(),
        payer: t.payer.clone(),
        amount: INVOICE_AMOUNT,
        due_date,
        discount_rate: DISCOUNT_RATE,
        token: t.token.address.clone(),
        referral_code: ReferralCode::None,
    }
}

fn make_invoice_params_with_referral(
    t: &TestEnv,
    referral: ReferralCode,
) -> InvoiceParams {
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    InvoiceParams {
        freelancer: t.freelancer.clone(),
        payer: t.payer.clone(),
        amount: INVOICE_AMOUNT,
        due_date,
        discount_rate: DISCOUNT_RATE,
        token: t.token.address.clone(),
        referral_code: referral,
    }
}

// ================================================================
// Tests for get_contract_stats()
// ================================================================

#[test]
fn test_contract_stats_initial_state() {
    let t = setup();

    let stats = t.contract.get_contract_stats();

    assert_eq!(stats.total_invoices, 0);
    assert_eq!(stats.total_funded, 0);
    assert_eq!(stats.total_paid, 0);
    assert_eq!(stats.total_volume_usdc, 0);
    assert_eq!(stats.total_volume_eurc, 0);
    assert_eq!(stats.total_volume_xlm, 0);
}

#[test]
fn test_contract_stats_increments_on_submit() {
    let t = setup();
    let _invoice_id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &(t.env.ledger().timestamp() + DUE_DATE_OFFSET),
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    let stats = t.contract.get_contract_stats();
    assert_eq!(stats.total_invoices, 1);
    assert_eq!(stats.total_funded, 0);
    assert_eq!(stats.total_paid, 0);
}

#[test]
fn test_contract_stats_increments_on_fund() {
    let t = setup();
    let invoice_id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &(t.env.ledger().timestamp() + DUE_DATE_OFFSET),
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &false);

    let stats = t.contract.get_contract_stats();
    assert_eq!(stats.total_invoices, 1);
    assert_eq!(stats.total_funded, 1);
    assert_eq!(stats.total_paid, 0);
    assert_eq!(stats.total_volume_usdc, INVOICE_AMOUNT);
}

#[test]
fn test_contract_stats_increments_on_mark_paid() {
    let t = setup();
    let invoice_id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &(t.env.ledger().timestamp() + DUE_DATE_OFFSET),
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &false);
    t.contract.mark_paid(&invoice_id, &INVOICE_AMOUNT);

    let stats = t.contract.get_contract_stats();
    assert_eq!(stats.total_invoices, 1);
    assert_eq!(stats.total_funded, 1);
    assert_eq!(stats.total_paid, 1);
    assert_eq!(stats.total_volume_usdc, INVOICE_AMOUNT);
}

#[test]
fn test_contract_stats_multiple_invoices() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;

    // Submit 3 invoices
    for _i in 0..3 {
        t.contract.submit_invoice(
            &t.freelancer,
            &t.payer,
            &INVOICE_AMOUNT,
            &due_date,
            &DISCOUNT_RATE,
            &t.token.address,
            &ReferralCode::None,
        );
    }

    let stats = t.contract.get_contract_stats();
    assert_eq!(stats.total_invoices, 3);
    assert_eq!(stats.total_funded, 0);
    assert_eq!(stats.total_paid, 0);
}

#[contract]
struct MockPriceOracle;

#[contractimpl]
impl MockPriceOracle {
    pub fn get_price(_env: Env, _token: Address) -> i128 {
        20_000
    }
}

#[test]
fn test_contract_stats_tracks_token_volumes_and_oracle_normalization() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &false);
    t.contract.mark_paid(&invoice_id, &INVOICE_AMOUNT);

    let stats = t.contract.get_contract_stats();
    assert_eq!(stats.total_volume_usdc, INVOICE_AMOUNT);
    assert_eq!(stats.token_volumes.len(), 2);

    let volume_entry = stats.token_volumes.get(0).unwrap();
    assert_eq!(volume_entry.0, t.token.address);
    assert_eq!(volume_entry.1, INVOICE_AMOUNT);
    assert_eq!(stats.total_volume_usd_normalized, 0);

    let oracle_id = t.env.register_contract(None, MockPriceOracle);
    t.env.as_contract(&t.contract.address, || {
        let mut config = crate::storage::get_config(&t.env).unwrap();
        config.price_oracle = Some(oracle_id.clone());
        crate::storage::set_config(&t.env, &config);
    });

    let stats = t.contract.get_contract_stats();
    assert_eq!(
        stats.total_volume_usd_normalized,
        INVOICE_AMOUNT * 20_000 / 10_000
    );
}

// ================================================================
// Tests for pause/unpause
// ================================================================

#[test]
fn test_pause_blocks_submit_invoice() {
    let t = setup();

    t.contract.pause();

    let result = t.contract.try_submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &(t.env.ledger().timestamp() + DUE_DATE_OFFSET),
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    assert!(result.is_err());
    assert_eq!(result, Err(Ok(ContractError::ContractPaused)));
}

#[test]
fn test_pause_blocks_fund_invoice() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    t.contract.pause();

    let result = t
        .contract
        .try_fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &false);

    assert!(result.is_err());
    assert_eq!(result, Err(Ok(ContractError::ContractPaused)));
}

#[test]
fn test_pause_blocks_mark_paid() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &false);
    t.contract.pause();

    let result = t.contract.try_mark_paid(&invoice_id, &INVOICE_AMOUNT);

    assert!(result.is_err());
    assert_eq!(result, Err(Ok(ContractError::ContractPaused)));
}

#[test]
fn test_pause_blocks_cancel_invoice() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    t.contract.pause();

    let result = t.contract.try_cancel_invoice(&invoice_id);

    assert!(result.is_err());
    assert_eq!(result, Err(Ok(ContractError::ContractPaused)));
}

#[test]
fn test_pause_blocks_claim_default() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &false);

    // Advance time past due date
    let mut ledger = t.env.ledger().get();
    ledger.timestamp = due_date + 1;
    t.env.ledger().set(ledger);

    t.contract.pause();

    let result = t.contract.try_claim_default(&t.funder, &invoice_id);

    assert!(result.is_err());
    assert_eq!(result, Err(Ok(ContractError::ContractPaused)));
}

#[test]
fn test_unpause_restores_functionality() {
    let t = setup();

    t.contract.pause();
    t.contract.unpause();

    let result = t.contract.try_submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &(t.env.ledger().timestamp() + DUE_DATE_OFFSET),
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    assert!(result.is_ok());
}

#[test]
fn test_get_contract_stats_works_when_paused() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    t.contract.pause();

    // Stats should still be readable
    let stats = t.contract.get_contract_stats();
    assert_eq!(stats.total_invoices, 1);
}

// ================================================================
// Tests for timestamp validation (MIN/MAX duration)
// ================================================================

#[test]
fn test_due_date_too_soon_rejected() {
    let t = setup();
    let now = t.env.ledger().timestamp();
    let too_soon = now + (12 * 60 * 60); // 12 hours - less than 24 hours

    let result = t.contract.try_submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &too_soon,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    assert!(result.is_err());
    assert_eq!(result, Err(Ok(ContractError::DueDateTooSoon)));
}

#[test]
fn test_due_date_exactly_24_hours_accepted() {
    let t = setup();
    let now = t.env.ledger().timestamp();
    let exactly_24h = now + (24 * 60 * 60);

    let result = t.contract.try_submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &exactly_24h,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    assert!(result.is_ok());
}

#[test]
fn test_due_date_too_far_rejected() {
    let t = setup();
    let now = t.env.ledger().timestamp();
    let too_far = now + (366 * 24 * 60 * 60); // 366 days - more than 365 days

    let result = t.contract.try_submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &too_far,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    assert!(result.is_err());
    assert_eq!(result, Err(Ok(ContractError::DueDateTooFar)));
}

#[test]
fn test_due_date_exactly_365_days_accepted() {
    let t = setup();
    let now = t.env.ledger().timestamp();
    let exactly_365d = now + (365 * 24 * 60 * 60);

    let result = t.contract.try_submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &exactly_365d,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    assert!(result.is_ok());
}

#[test]
fn test_due_date_in_past_rejected() {
    let t = setup();
    let now = t.env.ledger().timestamp();
    let past = now - 1;

    let result = t.contract.try_submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &past,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    assert!(result.is_err());
    assert_eq!(result, Err(Ok(ContractError::InvalidDueDate)));
}

#[test]
fn test_due_date_equal_to_now_rejected() {
    let t = setup();
    let now = t.env.ledger().timestamp();

    let result = t.contract.try_submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &now,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    assert!(result.is_err());
    assert_eq!(result, Err(Ok(ContractError::InvalidDueDate)));
}

// ================================================================
// Tests for submit_invoices_batch (Issue #480)
// ================================================================

#[test]
fn test_batch_submit_all_valid_invoices() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;

    let mut batch = soroban_sdk::Vec::new(&t.env);
    for _ in 0..5 {
        batch.push_back(InvoiceParams {
            freelancer: t.freelancer.clone(),
            payer: t.payer.clone(),
            amount: INVOICE_AMOUNT,
            due_date,
            discount_rate: DISCOUNT_RATE,
            token: t.token.address.clone(),
            referral_code: ReferralCode::None,
        });
    }

    let result = t.contract.try_submit_invoices_batch(&batch);
    assert!(result.is_ok());

    let ids = result.unwrap();
    assert_eq!(ids.len(), 5);

    // Verify all invoices were created with sequential IDs
    for i in 0..5 {
        let invoice = t.contract.get_invoice(&ids.get(i).unwrap());
        assert_eq!(invoice.status, InvoiceStatus::Pending);
        assert_eq!(invoice.amount, INVOICE_AMOUNT);
    }
}

#[test]
fn test_batch_submit_rejects_over_10_invoices() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;

    let mut batch = soroban_sdk::Vec::new(&t.env);
    for _ in 0..11 {
        batch.push_back(InvoiceParams {
            freelancer: t.freelancer.clone(),
            payer: t.payer.clone(),
            amount: INVOICE_AMOUNT,
            due_date,
            discount_rate: DISCOUNT_RATE,
            token: t.token.address.clone(),
            referral_code: ReferralCode::None,
        });
    }

    let result = t.contract.try_submit_invoices_batch(&batch);
    assert_eq!(result, Err(Ok(ContractError::BatchTooLarge)));
}

#[test]
fn test_batch_submit_fails_entirely_with_one_invalid() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;

    let mut batch = soroban_sdk::Vec::new(&t.env);

    // First invoice is valid
    batch.push_back(InvoiceParams {
        freelancer: t.freelancer.clone(),
        payer: t.payer.clone(),
        amount: INVOICE_AMOUNT,
        due_date,
        discount_rate: DISCOUNT_RATE,
        token: t.token.address.clone(),
        referral_code: ReferralCode::None,
    });

    // Second invoice has invalid amount (0)
    batch.push_back(InvoiceParams {
        freelancer: t.freelancer.clone(),
        payer: t.payer.clone(),
        amount: 0, // invalid
        due_date,
        discount_rate: DISCOUNT_RATE,
        token: t.token.address.clone(),
        referral_code: ReferralCode::None,
    });

    let result = t.contract.try_submit_invoices_batch(&batch);
    assert!(result.is_err());

    // Verify no invoices were created (atomic failure)
    let stats = t.contract.get_contract_stats();
    assert_eq!(stats.total_invoices, 0);
}

#[test]
fn test_batch_submit_referral_tracking() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;

    let referral_code = soroban_sdk::BytesN::from_array(&t.env, &[1u8; 32]);

    let mut batch = soroban_sdk::Vec::new(&t.env);
    for _ in 0..3 {
        batch.push_back(InvoiceParams {
            freelancer: t.freelancer.clone(),
            payer: t.payer.clone(),
            amount: INVOICE_AMOUNT,
            due_date,
            discount_rate: DISCOUNT_RATE,
            token: t.token.address.clone(),
            referral_code: ReferralCode::Present(referral_code.clone()),
        });
    }

    let result = t.contract.try_submit_invoices_batch(&batch);
    assert!(result.is_ok());

    let ids = result.unwrap();
    assert_eq!(ids.len(), 3);

    // Verify referral count was incremented
    let referral_count = t.contract.get_referral_stats(&referral_code);
    assert_eq!(referral_count, 3);

    // Verify each invoice has the referral code
    for i in 0..3 {
        let invoice = t.contract.get_invoice(&ids.get(i).unwrap());
        assert_eq!(invoice.referral_code, ReferralCode::Present(referral_code.clone()));
    }
}

#[test]
fn test_batch_submit_exact_10_invoices_succeeds() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;

    let mut batch = soroban_sdk::Vec::new(&t.env);
    for _ in 0..10 {
        batch.push_back(InvoiceParams {
            freelancer: t.freelancer.clone(),
            payer: t.payer.clone(),
            amount: INVOICE_AMOUNT,
            due_date,
            discount_rate: DISCOUNT_RATE,
            token: t.token.address.clone(),
            referral_code: ReferralCode::None,
        });
    }

    let result = t.contract.try_submit_invoices_batch(&batch);
    assert!(result.is_ok());

    let ids = result.unwrap();
    assert_eq!(ids.len(), 10);
}

#[test]
fn test_batch_submit_mixed_valid_and_invalid_token() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;

    // Register an unapproved token
    let unapproved_admin = Address::generate(&t.env);
    let unapproved_contract = t.env.register_stellar_asset_contract_v2(unapproved_admin);
    let unapproved_address = unapproved_contract.address();

    let mut batch = soroban_sdk::Vec::new(&t.env);

    // Valid invoice
    batch.push_back(InvoiceParams {
        freelancer: t.freelancer.clone(),
        payer: t.payer.clone(),
        amount: INVOICE_AMOUNT,
        due_date,
        discount_rate: DISCOUNT_RATE,
        token: t.token.address.clone(),
        referral_code: ReferralCode::None,
    });

    // Invoice with unapproved token
    batch.push_back(InvoiceParams {
        freelancer: t.freelancer.clone(),
        payer: t.payer.clone(),
        amount: INVOICE_AMOUNT,
        due_date,
        discount_rate: DISCOUNT_RATE,
        token: unapproved_address,
        referral_code: ReferralCode::None,
    });

    let result = t.contract.try_submit_invoices_batch(&batch);
    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}

// ================================================================
// Tests for transfer_lp_position with various funding states (#479)
// ================================================================

#[test]
fn test_transfer_lp_position_rejects_non_funded_invoice() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    let new_lp = Address::generate(&t.env);
    let result = t.contract.try_transfer_lp_position(&invoice_id, &new_lp);
    assert_eq!(result, Err(Ok(ContractError::NotFunded)));
}

#[test]
fn test_transfer_lp_position_rejects_partially_funded_invoice() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    // Partially fund the invoice (half the amount).
    let partial_amount = INVOICE_AMOUNT / 2;
    t.contract
        .fund_invoice(&t.funder, &invoice_id, &partial_amount, &false);

    let invoice = t.contract.get_invoice(&invoice_id);
    assert_eq!(invoice.status, InvoiceStatus::PartiallyFunded);

    let new_lp = Address::generate(&t.env);
    let result = t.contract.try_transfer_lp_position(&invoice_id, &new_lp);
    assert_eq!(result, Err(Ok(ContractError::NotFunded)));
}

#[test]
fn test_transfer_lp_position_succeeds_for_fully_funded_invoice() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &false);

    let invoice = t.contract.get_invoice(&invoice_id);
    assert_eq!(invoice.status, InvoiceStatus::Funded);

    let new_lp = Address::generate(&t.env);
    t.contract.transfer_lp_position(&invoice_id, &new_lp);

    let updated = t.contract.get_invoice(&invoice_id);
    assert_eq!(updated.funder, Some(new_lp));
}

#[test]
fn test_transfer_lp_position_rejects_same_lp() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &false);

    // Transfer to the same LP should fail.
    let result = t.contract.try_transfer_lp_position(&invoice_id, &t.funder);
    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}

#[test]
fn test_transfer_lp_position_updates_funders_list() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &false);

    let new_lp = Address::generate(&t.env);
    t.contract.transfer_lp_position(&invoice_id, &new_lp);

    // Verify old LP's invoices list no longer contains this invoice.
    let old_lp_invoices = t.contract.list_invoices_by_lp(&t.funder, &0, &50);
    assert!(
        old_lp_invoices.iter().all(|inv| inv.id != invoice_id),
        "old LP should not have this invoice in their list"
    );

    // Verify new LP's invoices list contains this invoice.
    let new_lp_invoices = t.contract.list_invoices_by_lp(&new_lp, &0, &50);
    assert!(
        new_lp_invoices.iter().any(|inv| inv.id == invoice_id),
        "new LP should have this invoice in their list"
    );
}

#[test]
fn test_transfer_lp_position_emits_event() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &false);

    let events_before = t.env.events().all().len();
    let new_lp = Address::generate(&t.env);
    t.contract.transfer_lp_position(&invoice_id, &new_lp);

    let events = t.env.events().all();
    assert!(
        events.len() > events_before,
        "expected at least one new event"
    );
}

// ── convert_invoice_token tests (#478) ──────────────────────────────────────

#[test]
fn test_convert_invoice_token_success_in_pending() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    let result =
        t.contract
            .try_convert_invoice_token(&t.freelancer, &invoice_id, &t.eurc_address);
    assert!(result.is_ok());

    let invoice = t.contract.get_invoice(&invoice_id);
    assert_eq!(invoice.token, t.eurc_address);
    assert_eq!(invoice.status, InvoiceStatus::Pending);
}

#[test]
fn test_convert_invoice_token_rejects_when_not_pending() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    // Fully fund the invoice, moving it out of Pending.
    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &false);

    let result =
        t.contract
            .try_convert_invoice_token(&t.freelancer, &invoice_id, &t.eurc_address);
    assert_eq!(result, Err(Ok(ContractError::AlreadyFunded)));

    // Token must be unchanged.
    let invoice = t.contract.get_invoice(&invoice_id);
    assert_eq!(invoice.token, t.token.address);
}

#[test]
fn test_convert_invoice_token_rejects_unapproved_token() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    let unapproved_admin = Address::generate(&t.env);
    let unapproved_contract = t.env.register_stellar_asset_contract_v2(unapproved_admin);
    let unapproved_address = unapproved_contract.address();

    let result = t.contract.try_convert_invoice_token(
        &t.freelancer,
        &invoice_id,
        &unapproved_address,
    );
    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));

    let invoice = t.contract.get_invoice(&invoice_id);
    assert_eq!(invoice.token, t.token.address);
}

#[test]
fn test_convert_invoice_token_rejects_when_expired() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    // Advance the ledger past the due date.
    let mut ledger_info = t.env.ledger().get();
    ledger_info.timestamp = due_date + 1;
    t.env.ledger().set(ledger_info);

    let result =
        t.contract
            .try_convert_invoice_token(&t.freelancer, &invoice_id, &t.eurc_address);
    assert_eq!(result, Err(Ok(ContractError::InvoiceExpired)));

    // convert_invoice_token flips the invoice to Expired as a side effect,
    // mirroring update_invoice's expiry-detection behavior.
    let invoice = t.contract.get_invoice(&invoice_id);
    assert_eq!(invoice.status, InvoiceStatus::Expired);
}

#[test]
fn test_convert_invoice_token_emits_token_changed_event() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    let events_before = t.env.events().all().len();

    t.contract
        .convert_invoice_token(&t.freelancer, &invoice_id, &t.eurc_address);

    let events = t.env.events().all();
    assert_eq!(events.len(), events_before + 1, "expected exactly one new event");

    let last_event = events.last().expect("event should have been emitted");
    let contract_id = last_event.0.clone();
    let data = last_event.2.clone();
    assert_eq!(contract_id, t.contract.address);

    let decoded: InvoiceTokenChanged = data.into_val(&t.env);
    assert_eq!(decoded.invoice_id, invoice_id);
    assert_eq!(decoded.old_token, t.token.address);
    assert_eq!(decoded.new_token, t.eurc_address);
}
