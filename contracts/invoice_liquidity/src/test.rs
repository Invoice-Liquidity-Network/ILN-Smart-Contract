#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Event,
};

use crate::events::ReputationUpdated;

// ----------------------------------------------------------------
// Test helpers — shared setup used across all tests
// ----------------------------------------------------------------

/// All the actors and contract references a test needs
struct TestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: TokenClient<'static>,
    freelancer: Address,
    payer: Address,
    funder: Address,
}

/// Standard invoice values reused across tests
const INVOICE_AMOUNT: i128 = 1_000_000_000; // 100 USDC in stroops (1 USDC = 10_000_000)
const DISCOUNT_RATE: u32 = 300; // 3.00% in basis points
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30; // 30 days from now

fn setup() -> TestEnv {
    let env = Env::default();

    // Skip auth checks in tests — we test auth separately
    env.mock_all_auths();

    // ---- Deploy a mock USDC token contract ----
    let usdc_admin = Address::generate(&env);
    let usdc_contract_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_address = usdc_contract_id.address();

    let token = TokenClient::new(&env, &usdc_address);
    let token_admin = StellarAssetClient::new(&env, &usdc_address);

    // ---- Generate test wallets ----
    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let funder = Address::generate(&env);

    // ---- Mint USDC to the actors who need it ----
    // Funder needs enough to cover the invoice
    token_admin.mint(&funder, &(INVOICE_AMOUNT * 10));
    // Payer needs enough to settle the invoice
    token_admin.mint(&payer, &(INVOICE_AMOUNT * 10));

    let contract_id = env.register(InvoiceLiquidityContract, ());
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);
    
    // Fund the contract treasury so it can cover defaults
    token_admin.mint(&contract.address, &(INVOICE_AMOUNT * 100));

    let xlm_admin = Address::generate(&env);
    let xlm_contract_id = env.register_stellar_asset_contract_v2(xlm_admin);
    let xlm_address = xlm_contract_id.address();

    // Initialize with mock USDC and mock XLM SAC addresses
    contract.initialize(&usdc_admin, &usdc_address, &xlm_address);

    // ---- Set ledger timestamp to a known baseline ----
    let mut ledger_info = env.ledger().get();
    ledger_info.timestamp = 1_700_000_000;
    env.ledger().set(ledger_info);

    TestEnv {
        env,
        contract,
        token,
        freelancer,
        payer,
        funder,
    }
}

/// Helper: submit a standard invoice and return its ID
fn submit_standard_invoice(t: &TestEnv) -> u64 {
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
    )
}

// ----------------------------------------------------------------
// submit_invoice — happy path
// ----------------------------------------------------------------

#[test]
fn test_submit_invoice_returns_id() {
    let t = setup();
    let id = submit_standard_invoice(&t);

    // First invoice should always be ID 1
    assert_eq!(id, 1);
}

#[test]
fn test_submit_invoice_stores_correct_fields() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;

    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
    );

    let invoice = t.contract.get_invoice(&id);

    assert_eq!(invoice.id, id);
    assert_eq!(invoice.freelancer, t.freelancer);
    assert_eq!(invoice.payer, t.payer);
    assert_eq!(invoice.token, t.token.address);
    assert_eq!(invoice.amount, INVOICE_AMOUNT);
    assert_eq!(invoice.due_date, due_date);
    assert_eq!(invoice.discount_rate, DISCOUNT_RATE);
    assert_eq!(invoice.status, InvoiceStatus::Pending);
    assert!(invoice.funder.is_none());
    assert!(invoice.funded_at.is_none());
}

#[test]
fn test_submit_multiple_invoices_increment_ids() {
    let t = setup();

    let id1 = submit_standard_invoice(&t);
    let id2 = submit_standard_invoice(&t);
    let id3 = submit_standard_invoice(&t);

    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
    assert_eq!(id3, 3);
}

// ----------------------------------------------------------------
// submit_invoices_batch
// ----------------------------------------------------------------

#[test]
fn test_submit_invoices_batch_happy_path() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;

    let params = InvoiceParams {
        freelancer: t.freelancer.clone(),
        payer: t.payer.clone(),
        amount: INVOICE_AMOUNT,
        due_date,
        discount_rate: DISCOUNT_RATE,
        token: t.token.address.clone(),
    };

    let mut batch = Vec::new(&t.env);
    batch.push_back(params.clone());
    batch.push_back(params.clone());
    batch.push_back(params.clone());

    let ids = t.contract.submit_invoices_batch(&batch);

    assert_eq!(ids.len(), 3);
    assert_eq!(ids.get(0).unwrap(), 1);
    assert_eq!(ids.get(1).unwrap(), 2);
    assert_eq!(ids.get(2).unwrap(), 3);
}

#[test]
fn test_submit_invoices_batch_rejects_over_limit() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;

    let params = InvoiceParams {
        freelancer: t.freelancer.clone(),
        payer: t.payer.clone(),
        amount: INVOICE_AMOUNT,
        due_date,
        discount_rate: DISCOUNT_RATE,
        token: t.token.address.clone(),
    };

    let mut batch = Vec::new(&t.env);
    for _ in 0..11 {
        batch.push_back(params.clone());
    }

    let result = t.contract.try_submit_invoices_batch(&batch);

    assert_eq!(result, Err(Ok(ContractError::BatchTooLarge)));
}

#[test]
fn test_submit_invoices_batch_atomicity_fail() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;

    let mut batch = Vec::new(&t.env);

    // Valid invoice
    batch.push_back(InvoiceParams {
        freelancer: t.freelancer.clone(),
        payer: t.payer.clone(),
        amount: INVOICE_AMOUNT,
        due_date,
        discount_rate: DISCOUNT_RATE,
        token: t.token.address.clone(),
    });

    // Invalid invoice (amount = 0)
    batch.push_back(InvoiceParams {
        freelancer: t.freelancer.clone(),
        payer: t.payer.clone(),
        amount: 0,
        due_date,
        discount_rate: DISCOUNT_RATE,
        token: t.token.address.clone(),
    });

    let result = t.contract.try_submit_invoices_batch(&batch);

    assert_eq!(result, Err(Ok(ContractError::InvalidAmount)));

    // Verify no invoice was saved
    assert_eq!(t.contract.get_invoice_count(), 0);
}

// ----------------------------------------------------------------
// submit_invoice — validation errors
// ----------------------------------------------------------------

#[test]
fn test_submit_rejects_zero_amount() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;

    let result = t.contract.try_submit_invoice(
        &t.freelancer,
        &t.payer,
        &0,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
    );

    assert_eq!(result, Err(Ok(ContractError::InvalidAmount)));
}

#[test]
fn test_submit_rejects_negative_amount() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;

    let result = t.contract.try_submit_invoice(
        &t.freelancer,
        &t.payer,
        &-1,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
    );

    assert_eq!(result, Err(Ok(ContractError::InvalidAmount)));
}

#[test]
fn test_submit_rejects_past_due_date() {
    let t = setup();
    let past_due_date = t.env.ledger().timestamp() - 1; // 1 second in the past

    let result = t.contract.try_submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &past_due_date,
        &DISCOUNT_RATE,
        &t.token.address,
    );

    assert_eq!(result, Err(Ok(ContractError::InvalidDueDate)));
}

#[test]
fn test_submit_rejects_zero_discount_rate() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;

    let result = t.contract.try_submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &0,
        &t.token.address,
    );

    assert_eq!(result, Err(Ok(ContractError::InvalidDiscountRate)));
}

#[test]
fn test_submit_rejects_discount_rate_above_50_percent() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;

    let result = t.contract.try_submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &5_001, // 50.01% — just over the cap
        &t.token.address,
    );

    assert_eq!(result, Err(Ok(ContractError::InvalidDiscountRate)));
}

// ----------------------------------------------------------------
// update_invoice
// ----------------------------------------------------------------

#[test]
fn test_update_invoice_updates_pending_invoice_fields() {
    let t = setup();
    let id = submit_standard_invoice(&t);
    let updated_amount = INVOICE_AMOUNT + 250_000_000;
    let updated_due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET * 2;
    let updated_discount_rate = DISCOUNT_RATE + 100;

    t.contract.update_invoice(
        &t.freelancer,
        &id,
        &updated_amount,
        &updated_due_date,
        &updated_discount_rate,
    );

    let invoice = t.contract.get_invoice(&id);
    assert_eq!(invoice.amount, updated_amount);
    assert_eq!(invoice.due_date, updated_due_date);
    assert_eq!(invoice.discount_rate, updated_discount_rate);
    assert_eq!(invoice.payer, t.payer);
    assert_eq!(invoice.status, InvoiceStatus::Pending);
}

#[test]
fn test_update_invoice_emits_updated_event() {
    let t = setup();
    let id = submit_standard_invoice(&t);
    let updated_amount = INVOICE_AMOUNT + 250_000_000;
    let updated_due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET * 2;
    let updated_discount_rate = DISCOUNT_RATE + 100;

    t.contract.update_invoice(
        &t.freelancer,
        &id,
        &updated_amount,
        &updated_due_date,
        &updated_discount_rate,
    );

    let expected_event = InvoiceUpdated {
        invoice_id: id,
        freelancer: t.freelancer.clone(),
        payer: t.payer.clone(),
        token: t.token.address.clone(),
        amount: updated_amount,
        due_date: updated_due_date,
        discount_rate: updated_discount_rate,
        status: InvoiceStatus::Pending,
    };

    let events = t.env.events().all().filter_by_contract(&t.contract.address);
    assert_eq!(
        events.events().last(),
        Some(&expected_event.to_xdr(&t.env, &t.contract.address))
    );
}

#[test]
fn test_update_invoice_rejects_non_freelancer() {
    let t = setup();
    let id = submit_standard_invoice(&t);
    let impostor = Address::generate(&t.env);
    let updated_due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET * 2;

    let result = t.contract.try_update_invoice(
        &impostor,
        &id,
        &INVOICE_AMOUNT,
        &updated_due_date,
        &DISCOUNT_RATE,
    );

    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}

#[test]
fn test_update_funded_invoice_fails() {
    let t = setup();
    let id = submit_standard_invoice(&t);
    let updated_due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET * 2;

    t.contract.fund_invoice(&t.funder, &id, &INVOICE_AMOUNT);

    let result = t.contract.try_update_invoice(
        &t.freelancer,
        &id,
        &INVOICE_AMOUNT,
        &updated_due_date,
        &DISCOUNT_RATE,
    );

    assert_eq!(result, Err(Ok(ContractError::AlreadyFunded)));
}

#[test]
fn test_update_invoice_rejects_invalid_amount() {
    let t = setup();
    let id = submit_standard_invoice(&t);
    let updated_due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET * 2;

    let result =
        t.contract
            .try_update_invoice(&t.freelancer, &id, &0, &updated_due_date, &DISCOUNT_RATE);

    assert_eq!(result, Err(Ok(ContractError::InvalidAmount)));
}

#[test]
fn test_update_invoice_rejects_invalid_due_date() {
    let t = setup();
    let id = submit_standard_invoice(&t);
    let past_due_date = t.env.ledger().timestamp();

    let result = t.contract.try_update_invoice(
        &t.freelancer,
        &id,
        &INVOICE_AMOUNT,
        &past_due_date,
        &DISCOUNT_RATE,
    );

    assert_eq!(result, Err(Ok(ContractError::InvalidDueDate)));
}

#[test]
fn test_update_invoice_rejects_invalid_discount_rate() {
    let t = setup();
    let id = submit_standard_invoice(&t);
    let updated_due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET * 2;

    let result =
        t.contract
            .try_update_invoice(&t.freelancer, &id, &INVOICE_AMOUNT, &updated_due_date, &0);

    assert_eq!(result, Err(Ok(ContractError::InvalidDiscountRate)));
}

// ----------------------------------------------------------------
// transfer_invoice
// ----------------------------------------------------------------

#[test]
fn test_transfer_invoice_updates_freelancer() {
    let t = setup();
    let id = submit_standard_invoice(&t);

    let new_freelancer = Address::generate(&t.env);

    t.contract.transfer_invoice(&id, &new_freelancer);

    let invoice = t.contract.get_invoice(&id);
    assert_eq!(invoice.freelancer, new_freelancer);
}

#[test]
fn test_transfer_nonexistent_invoice_fails() {
    let t = setup();
    let new_freelancer = Address::generate(&t.env);

    let result = t.contract.try_transfer_invoice(&999, &new_freelancer);
    assert_eq!(result, Err(Ok(ContractError::InvoiceNotFound)));
}

#[test]
fn test_transfer_funded_invoice_fails() {
    let t = setup();
    let id = submit_standard_invoice(&t);

    t.contract.fund_invoice(&t.funder, &id, &INVOICE_AMOUNT);

    let new_freelancer = Address::generate(&t.env);
    let result = t.contract.try_transfer_invoice(&id, &new_freelancer);
    assert_eq!(result, Err(Ok(ContractError::AlreadyFunded)));
}

// ----------------------------------------------------------------
// fund_invoice — happy path
// ----------------------------------------------------------------

#[test]
fn test_fund_invoice_transfers_correct_amounts() {
    let t = setup();
    let id = submit_standard_invoice(&t);

    let funder_balance_before = t.token.balance(&t.funder);
    let freelancer_balance_before = t.token.balance(&t.freelancer);

    t.contract.fund_invoice(&t.funder, &id, &INVOICE_AMOUNT);

    let funder_balance_after = t.token.balance(&t.funder);
    let freelancer_balance_after = t.token.balance(&t.freelancer);

    // discount_amount = 1_000_000_000 * 300 / 10_000 = 30_000_000 (3 USDC)
    let discount_amount = INVOICE_AMOUNT * DISCOUNT_RATE as i128 / 10_000;
    let freelancer_payout = INVOICE_AMOUNT - discount_amount;

    // LP sent the required cost
    assert_eq!(
        funder_balance_before - funder_balance_after,
        freelancer_payout,
        "LP should have sent the cost amount"
    );

    // Freelancer received amount minus discount
    assert_eq!(
        freelancer_balance_after - freelancer_balance_before,
        freelancer_payout,
        "Freelancer should receive amount minus discount"
    );
}

#[test]
fn test_fund_invoice_updates_status_to_funded() {
    let t = setup();
    let id = submit_standard_invoice(&t);

    t.contract.fund_invoice(&t.funder, &id, &INVOICE_AMOUNT);

    let invoice = t.contract.get_invoice(&id);

    assert_eq!(invoice.status, InvoiceStatus::Funded);
    assert_eq!(invoice.funder, Some(t.funder.clone()));
    assert!(invoice.funded_at.is_some());
}

#[test]
fn test_fund_invoice_sets_funded_at_timestamp() {
    let t = setup();
    let id = submit_standard_invoice(&t);
    let now = t.env.ledger().timestamp();

    t.contract.fund_invoice(&t.funder, &id, &INVOICE_AMOUNT);

    let invoice = t.contract.get_invoice(&id);
    assert_eq!(invoice.funded_at, Some(now));
}

// ----------------------------------------------------------------
// fund_invoice — error cases
// ----------------------------------------------------------------

#[test]
fn test_fund_nonexistent_invoice_fails() {
    let t = setup();

    let result = t
        .contract
        .try_fund_invoice(&t.funder, &999, &INVOICE_AMOUNT);
    assert_eq!(result, Err(Ok(ContractError::InvoiceNotFound)));
}

#[test]
fn test_fund_already_funded_invoice_fails() {
    let t = setup();
    let id = submit_standard_invoice(&t);

    t.contract.fund_invoice(&t.funder, &id, &INVOICE_AMOUNT);

    // Second funder tries to fund the same invoice
    let second_funder = Address::generate(&t.env);
    let result = t
        .contract
        .try_fund_invoice(&second_funder, &id, &INVOICE_AMOUNT);

    assert_eq!(result, Err(Ok(ContractError::AlreadyFunded)));
}

// ----------------------------------------------------------------
// mark_paid — happy path
// ----------------------------------------------------------------

#[test]
fn test_mark_paid_releases_full_amount_to_lp() {
    let t = setup();
    let id = submit_standard_invoice(&t);

    t.contract.fund_invoice(&t.funder, &id, &INVOICE_AMOUNT);

    let funder_balance_before = t.token.balance(&t.funder);

    t.contract.mark_paid(&id);

    let funder_balance_after = t.token.balance(&t.funder);

    // LP should receive the full invoice amount (minus fee, which is 0 here)
    assert_eq!(
        funder_balance_after - funder_balance_before,
        INVOICE_AMOUNT,
        "LP should receive the full invoice amount when invoice is paid"
    );
}

#[test]
fn test_mark_paid_updates_status() {
    let t = setup();
    let id = submit_standard_invoice(&t);

    t.contract.fund_invoice(&t.funder, &id, &INVOICE_AMOUNT);
    t.contract.mark_paid(&id);

    let invoice = t.contract.get_invoice(&id);
    assert_eq!(invoice.status, InvoiceStatus::Paid);
}

#[test]
fn test_full_lifecycle_lp_earns_correct_yield() {
    let t = setup();
    let id = submit_standard_invoice(&t);

    // Record LP balance before the entire flow
    let lp_start = t.token.balance(&t.funder);

    // LP funds the invoice
    t.contract.fund_invoice(&t.funder, &id, &INVOICE_AMOUNT);

    // Payer settles
    t.contract.mark_paid(&id);

    let lp_end = t.token.balance(&t.funder);

    let expected_yield = INVOICE_AMOUNT * DISCOUNT_RATE as i128 / 10_000;

    assert_eq!(
        lp_end - lp_start,
        expected_yield,
        "LP net yield should equal the discount amount"
    );
}

#[test]
fn test_full_lifecycle_payer_balance_reduces_correctly() {
    let t = setup();
    let id = submit_standard_invoice(&t);

    let payer_start = t.token.balance(&t.payer);

    t.contract.fund_invoice(&t.funder, &id, &INVOICE_AMOUNT);
    t.contract.mark_paid(&id);

    let payer_end = t.token.balance(&t.payer);

    // Payer should have paid the full invoice amount
    assert_eq!(
        payer_start - payer_end,
        INVOICE_AMOUNT,
        "Payer should have paid the full invoice amount"
    );
}

// ----------------------------------------------------------------
// mark_paid — error cases
// ----------------------------------------------------------------

#[test]
fn test_mark_paid_on_pending_invoice_fails() {
    let t = setup();
    let id = submit_standard_invoice(&t);

    // Try to mark paid without funding first
    let result = t.contract.try_mark_paid(&id);
    assert_eq!(result, Err(Ok(ContractError::NotFunded)));
}

#[test]
fn test_mark_paid_twice_fails() {
    let t = setup();
    let id = submit_standard_invoice(&t);

    t.contract.fund_invoice(&t.funder, &id, &INVOICE_AMOUNT);
    t.contract.mark_paid(&id);

    // Paying again should fail
    let result = t.contract.try_mark_paid(&id);
    assert_eq!(result, Err(Ok(ContractError::AlreadyPaid)));
}

#[test]
fn test_mark_paid_nonexistent_invoice_fails() {
    let t = setup();

    let result = t.contract.try_mark_paid(&999);
    assert_eq!(result, Err(Ok(ContractError::InvoiceNotFound)));
}

#[test]
fn test_claim_default_success() {
    let t = setup();
    let id = submit_standard_invoice(&t);

    t.contract.fund_invoice(&t.funder, &id, &INVOICE_AMOUNT);

    // Move time forward past due date
    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 1;
    t.env.ledger().set(ledger);

    let funder_before = t.token.balance(&t.funder);

    t.contract.claim_default(&t.funder, &id);

    let funder_after = t.token.balance(&t.funder);

    let discount_amount = INVOICE_AMOUNT * DISCOUNT_RATE as i128 / 10_000;

    assert_eq!(
        funder_after - funder_before,
        INVOICE_AMOUNT - discount_amount,
        "LP should recover their contributed principal after default"
    );

    let invoice = t.contract.get_invoice(&id);
    assert_eq!(invoice.status, InvoiceStatus::Defaulted);
}

#[test]
fn test_claim_default_before_due_date_fails() {
    let t = setup();
    let id = submit_standard_invoice(&t);

    t.contract.fund_invoice(&t.funder, &id, &INVOICE_AMOUNT);

    let result = t.contract.try_claim_default(&t.funder, &id);
    assert_eq!(result, Err(Ok(ContractError::NotYetDefaulted)));
}

#[test]
fn test_claim_default_non_funder_fails() {
    let t = setup();
    let id = submit_standard_invoice(&t);

    t.contract.fund_invoice(&t.funder, &id, &INVOICE_AMOUNT);

    // Move time forward
    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 1;
    t.env.ledger().set(ledger);

    let attacker = Address::generate(&t.env);

    let result = t.contract.try_claim_default(&attacker, &id);
    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}

#[test]
fn test_claim_default_on_paid_invoice_fails() {
    let t = setup();
    let id = submit_standard_invoice(&t);

    t.contract.fund_invoice(&t.funder, &id, &INVOICE_AMOUNT);
    t.contract.mark_paid(&id);

    // Move time forward
    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 1;
    t.env.ledger().set(ledger);

    let result = t.contract.try_claim_default(&t.funder, &id);
    assert_eq!(result, Err(Ok(ContractError::AlreadyPaid)));
}

#[test]
fn test_claim_default_twice_fails() {
    let t = setup();
    let id = submit_standard_invoice(&t);

    t.contract.fund_invoice(&t.funder, &id, &INVOICE_AMOUNT);

    // Move time forward
    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 1;
    t.env.ledger().set(ledger);

    t.contract.claim_default(&t.funder, &id);

    let result = t.contract.try_claim_default(&t.funder, &id);
    assert_eq!(result, Err(Ok(ContractError::InvoiceDefaulted)));
}

#[test]
fn test_expire_pending_invoice_after_due_date() {
    let t = setup();
    let id = submit_standard_invoice(&t);

    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 1;
    t.env.ledger().set(ledger);

    t.contract.expire_invoice(&id);

    let invoice = t.contract.get_invoice(&id);
    assert_eq!(invoice.status, InvoiceStatus::Expired);
}

#[test]
fn test_expire_pending_invoice_before_due_date_fails() {
    let t = setup();
    let id = submit_standard_invoice(&t);

    let result = t.contract.try_expire_invoice(&id);
    assert_eq!(result, Err(Ok(ContractError::NotYetDefaulted)));

    let invoice = t.contract.get_invoice(&id);
    assert_eq!(invoice.status, InvoiceStatus::Pending);
}

#[test]
fn test_fund_expired_invoice_fails() {
    let t = setup();
    let id = submit_standard_invoice(&t);

    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 1;
    t.env.ledger().set(ledger);

    t.contract.expire_invoice(&id);

    let result = t.contract.try_fund_invoice(&t.funder, &id, &INVOICE_AMOUNT);
    assert_eq!(result, Err(Ok(ContractError::InvoiceExpired)));

    let invoice = t.contract.get_invoice(&id);
    assert_eq!(invoice.status, InvoiceStatus::Expired);
}

#[test]
fn test_new_payer_score_is_neutral() {
    let t = setup();

    let score = t.contract.payer_score(&t.payer);

    assert_eq!(score, 50);
}

#[test]
fn test_perfect_payer_score() {
    let t = setup();
    let id = submit_standard_invoice(&t);

    t.contract.fund_invoice(&t.funder, &id, &INVOICE_AMOUNT);
    t.contract.mark_paid(&id);

    let score = t.contract.payer_score(&t.payer);

    assert_eq!(score, 51);
}

#[test]
fn test_mark_paid_emits_reputation_updated_event() {
    let t = setup();
    let id = submit_standard_invoice(&t);

    t.contract.fund_invoice(&t.funder, &id, &INVOICE_AMOUNT);
    t.contract.mark_paid(&id);

    let expected = ReputationUpdated {
        address: t.payer.clone(),
        old_score: 50,
        new_score: 51,
        invoices_submitted: 1,
        invoices_paid: 1,
        invoices_defaulted: 0,
    }
    .to_xdr(&t.env, &t.contract.address);

    let contract_events = t.env.events().all().filter_by_contract(&t.contract.address);
    let emitted_events = contract_events.events();
    assert_eq!(
        emitted_events.get(emitted_events.len() - 2),
        Some(&expected),
        "mark_paid must emit ReputationUpdated with the incremented score snapshot"
    );
}

#[test]
fn test_payer_with_default() {
    let t = setup();
    let id = submit_standard_invoice(&t);

    t.contract.fund_invoice(&t.funder, &id, &INVOICE_AMOUNT);

    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 1;
    t.env.ledger().set(ledger);

    t.contract.claim_default(&t.funder, &id);

    let score = t.contract.payer_score(&t.payer);

    assert!(score < 50);
}

#[test]
fn test_claim_default_emits_reputation_updated_event_with_accumulated_counts() {
    let t = setup();
    let paid_id = submit_standard_invoice(&t);

    t.contract.fund_invoice(&t.funder, &paid_id, &INVOICE_AMOUNT);
    t.contract.mark_paid(&paid_id);

    let defaulted_id = submit_standard_invoice(&t);
    t.contract
        .fund_invoice(&t.funder, &defaulted_id, &INVOICE_AMOUNT);

    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 1;
    t.env.ledger().set(ledger);

    t.contract.claim_default(&t.funder, &defaulted_id);

    let expected = ReputationUpdated {
        address: t.payer.clone(),
        old_score: 51,
        new_score: 46,
        invoices_submitted: 2,
        invoices_paid: 1,
        invoices_defaulted: 1,
    }
    .to_xdr(&t.env, &t.contract.address);

    let contract_events = t.env.events().all().filter_by_contract(&t.contract.address);
    let emitted_events = contract_events.events();
    assert_eq!(
        emitted_events.get(emitted_events.len() - 2),
        Some(&expected),
        "claim_default must emit ReputationUpdated with the decremented score snapshot"
    );
}
