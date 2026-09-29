//! Issue #842: bounded due_date cast.
//!
//! `submit_invoice`, `update_invoice`, and `submit_invoices_batch` narrowed
//! the caller-supplied `u64` due_date into the storage-side `u32` field with
//! `.try_into().unwrap()`. Replaced with `.try_into().map_err(|_|
//! ContractError::InvalidDueDate)?` so a value that does not fit `u32`
//! surfaces as a typed error rather than aborting the transaction.
//!
//! The upstream `validate_invoice_terms` already rejects `due_date >
//! u32::MAX` before the cast is reached, so both paths (before and after the
//! change) return `InvalidDueDate` on out-of-range input. The tests below
//! pin that behaviour end-to-end for each of the three call sites, and a
//! bare-Rust boundary test proves the substituted `.try_into().map_err(...)`
//! pattern returns the expected typed error, not a panic.

use invoice_liquidity::{
    ContractError, InvoiceLiquidityContract, InvoiceLiquidityContractClient, InvoiceParams,
    ReferralCode,
};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    vec, Address, Env, Vec,
};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;

/// Seconds in 365 days (matches MIN/MAX_INVOICE_DURATION in the crate).
const MAX_INVOICE_DURATION: u64 = 365 * 24 * 60 * 60;

/// Timestamp chosen so `now + MAX_INVOICE_DURATION == u32::MAX`. That makes
/// `due_date = u32::MAX` valid against every check in
/// `validate_invoice_terms`, so the cast is the last gate the value passes.
const NOW: u64 = u32::MAX as u64 - MAX_INVOICE_DURATION;

/// Max value that fits the storage-side `u32` due_date.
const MAX_VALID_DUE_DATE: u64 = u32::MAX as u64;

/// Exactly one past the storage-side `u32` upper bound.
const OVER_MAX_DUE_DATE: u64 = u32::MAX as u64 + 1;

struct DueDateEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: Address,
    freelancer: Address,
    payer: Address,
}

fn setup() -> DueDateEnv {
    let env = Env::default();
    env.mock_all_auths();

    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_addr = usdc_id.address();
    let token_admin = StellarAssetClient::new(&env, &usdc_addr);

    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    token_admin.mint(&freelancer, &(INVOICE_AMOUNT * 10));
    token_admin.mint(&payer, &(INVOICE_AMOUNT * 10));

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);

    let xlm_admin = Address::generate(&env);
    let xlm_id = env.register_stellar_asset_contract_v2(xlm_admin);
    let xlm_addr = xlm_id.address();
    let eurc_addr = Address::generate(&env);

    contract.initialize(&usdc_admin, &usdc_addr, &eurc_addr, &xlm_addr);

    let mut ledger = env.ledger().get();
    ledger.timestamp = NOW;
    ledger.sequence_number = 100;
    env.ledger().set(ledger);

    DueDateEnv {
        env,
        contract,
        token: usdc_addr,
        freelancer,
        payer,
    }
}

fn params(t: &DueDateEnv, due_date: u64) -> InvoiceParams {
    InvoiceParams {
        freelancer: t.freelancer.clone(),
        payer: t.payer.clone(),
        amount: INVOICE_AMOUNT,
        due_date,
        discount_rate: DISCOUNT_RATE,
        token: t.token.clone(),
        referral_code: ReferralCode::None,
    }
}

// ── submit_invoice ───────────────────────────────────────────────────────────

#[test]
fn submit_invoice_max_valid_due_date_succeeds() {
    let t = setup();
    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &MAX_VALID_DUE_DATE,
        &DISCOUNT_RATE,
        &t.token,
        &ReferralCode::None,
    );
    let invoice = t.contract.get_invoice(&id);
    assert_eq!(u64::from(invoice.due_date), MAX_VALID_DUE_DATE);
}

#[test]
fn submit_invoice_one_past_max_returns_invalid_due_date() {
    let t = setup();
    let result = t.contract.try_submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &OVER_MAX_DUE_DATE,
        &DISCOUNT_RATE,
        &t.token,
        &ReferralCode::None,
    );
    assert_eq!(result, Err(Ok(ContractError::InvalidDueDate)));
}

// ── update_invoice ───────────────────────────────────────────────────────────

#[test]
fn update_invoice_max_valid_due_date_succeeds() {
    let t = setup();

    // First submit at a lower due date so update_invoice has something to update.
    let submit_due = NOW + 60 * 60 * 24; // exactly at MIN_INVOICE_DURATION
    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &submit_due,
        &DISCOUNT_RATE,
        &t.token,
        &ReferralCode::None,
    );

    t.contract.update_invoice(
        &t.freelancer,
        &id,
        &INVOICE_AMOUNT,
        &MAX_VALID_DUE_DATE,
        &DISCOUNT_RATE,
    );

    let invoice = t.contract.get_invoice(&id);
    assert_eq!(u64::from(invoice.due_date), MAX_VALID_DUE_DATE);
}

#[test]
fn update_invoice_one_past_max_returns_invalid_due_date() {
    let t = setup();

    let submit_due = NOW + 60 * 60 * 24;
    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &submit_due,
        &DISCOUNT_RATE,
        &t.token,
        &ReferralCode::None,
    );

    let result = t.contract.try_update_invoice(
        &t.freelancer,
        &id,
        &INVOICE_AMOUNT,
        &OVER_MAX_DUE_DATE,
        &DISCOUNT_RATE,
    );
    assert_eq!(result, Err(Ok(ContractError::InvalidDueDate)));

    // State snapshot: the invoice's due_date must be unchanged after the
    // rejected update. Proves no partial write.
    let invoice = t.contract.get_invoice(&id);
    assert_eq!(u64::from(invoice.due_date), submit_due);
}

// ── submit_invoices_batch ────────────────────────────────────────────────────

#[test]
fn submit_invoices_batch_all_valid_succeeds() {
    let t = setup();
    let batch: Vec<InvoiceParams> = vec![&t.env, params(&t, MAX_VALID_DUE_DATE)];
    let ids = t.contract.submit_invoices_batch(&batch);
    assert_eq!(ids.len(), 1);
    let invoice = t.contract.get_invoice(&ids.get(0).unwrap());
    assert_eq!(u64::from(invoice.due_date), MAX_VALID_DUE_DATE);
}

/// Mix of valid and out-of-range entries: the batch must reject and no invoice
/// from the batch should be committed (proves no partial writes).
#[test]
fn submit_invoices_batch_mixed_rejects_and_writes_nothing() {
    let t = setup();

    let valid_due = NOW + 60 * 60 * 24;
    let batch: Vec<InvoiceParams> = vec![
        &t.env,
        params(&t, valid_due),
        params(&t, OVER_MAX_DUE_DATE),
        params(&t, valid_due),
    ];

    let total_before = t.contract.get_invoice_count();

    let result = t.contract.try_submit_invoices_batch(&batch);
    assert_eq!(result, Err(Ok(ContractError::InvalidDueDate)));

    let total_after = t.contract.get_invoice_count();
    assert_eq!(
        total_after, total_before,
        "batch must not commit any invoices when one entry is out of range"
    );
}

// ── Off-by-one pattern check ─────────────────────────────────────────────────

/// The substituted `.try_into::<u32>().map_err(|_| InvalidDueDate)` pattern
/// must produce the typed error for values one past the u32 upper bound.
/// This locks in the semantics of every call site touched.
#[test]
fn u64_to_u32_off_by_one_returns_typed_error_not_panic() {
    let over: u64 = u32::MAX as u64 + 1;
    let result: Result<u32, ContractError> =
        over.try_into().map_err(|_| ContractError::InvalidDueDate);
    assert_eq!(result.unwrap_err(), ContractError::InvalidDueDate);

    let at_max: u64 = u32::MAX as u64;
    let result_ok: Result<u32, ContractError> =
        at_max.try_into().map_err(|_| ContractError::InvalidDueDate);
    assert_eq!(result_ok.unwrap(), u32::MAX);
}
