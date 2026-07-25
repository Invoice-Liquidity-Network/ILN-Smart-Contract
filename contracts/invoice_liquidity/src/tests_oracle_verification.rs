#![cfg(test)]

//! Tests for issue #92 — optional oracle payer verification in fund_invoice().
//!
//! Scenarios covered:
//! 1. Verified payer + require_oracle_verification=true  → succeeds.
//! 2. Unverified payer + require_oracle_verification=true → PayerUnverified.
//! 3. Unverified payer + require_oracle_verification=false → succeeds (flag not set).

use super::*;
use crate::test::setup;

const INVOICE_AMOUNT: i128 = 1_000_000_000;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    Address, Env,
};

// ----------------------------------------------------------------
// Mock oracle: always returns verified = true with a fresh timestamp.
// "Fresh" means timestamp == current ledger sequence at call time.
// ----------------------------------------------------------------
#[contract]
struct MockVerifiedOracle;

#[contractimpl]
impl MockVerifiedOracle {
    pub fn get_payer_data(env: Env, _payer: Address) -> OracleVerificationResponse {
        OracleVerificationResponse {
            is_verified: true,
            timestamp: env.ledger().sequence(),
        }
    }
}

// ----------------------------------------------------------------
// Mock oracle: always returns verified = false with a fresh timestamp.
// ----------------------------------------------------------------
#[contract]
struct MockUnverifiedOracle;

impl MockUnverifiedOracle {
    pub fn get_payer_data(env: Env, _payer: Address) -> OracleVerificationResponse {
        OracleVerificationResponse {
            is_verified: false,
            timestamp: env.ledger().sequence(),
        }
    }
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

fn make_invoice(t: &crate::test::TestEnv) -> u64 {
    let now = t.env.ledger().timestamp();
    t.contract.submit_invoice(&ReferralCode::None).unwrap()
}

// ----------------------------------------------------------------
// Test 1: verified payer + flag=true → success
// ----------------------------------------------------------------
#[test]
fn test_oracle_verified_payer_passes() {
    let t = setup();

    // Register the verified mock oracle and wire it into contract config.
    let oracle_id = t.env.register_contract(None, MockVerifiedOracle);
    t.contract.set_price_oracle(&oracle_id).unwrap();

    let invoice_id = make_invoice(&t);

    // fund_invoice with require_oracle_verification=true should succeed because
    // the oracle confirms the payer is verified.
    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true)
        .unwrap();

    let invoice = t.contract.get_invoice(&invoice_id).unwrap();
    assert_eq!(invoice.status, InvoiceStatus::Funded);
}

// ----------------------------------------------------------------
// Test 2: unverified payer + flag=true → PayerUnverified error
// ----------------------------------------------------------------
#[test]
fn test_oracle_unverified_payer_with_flag_fails() {
    let t = setup();

    // Register the unverified mock oracle.
    let oracle_id = t.env.register_contract(None, MockUnverifiedOracle);
    t.contract.set_price_oracle(&oracle_id).unwrap();

    let invoice_id = make_invoice(&t);

    let result = t
        .contract
        .try_fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true);

    assert_eq!(
        result,
        Err(Ok(ContractError::PayerUnverified)),
        "expected PayerUnverified when oracle rejects payer and flag is set"
    );
}

// ----------------------------------------------------------------
// Test 3: unverified payer + flag=false → success (oracle not queried)
// ----------------------------------------------------------------
#[test]
fn test_oracle_unverified_payer_without_flag_passes() {
    let t = setup();

    // Even with an unverified oracle registered, flag=false means no query.
    let oracle_id = t.env.register_contract(None, MockUnverifiedOracle);
    t.contract.set_price_oracle(&oracle_id).unwrap();

    let invoice_id = make_invoice(&t);

    // require_oracle_verification=false → oracle is ignored, funding succeeds.
    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &false)
        .unwrap();

    let invoice = t.contract.get_invoice(&invoice_id).unwrap();
    assert_eq!(invoice.status, InvoiceStatus::Funded);
}

// ----------------------------------------------------------------
// Test 4: flag=true but no oracle configured → no-op, succeeds
// ----------------------------------------------------------------
#[test]
fn test_oracle_flag_true_no_oracle_configured_passes() {
    let t = setup();
    // No oracle set in config.

    let invoice_id = make_invoice(&t);

    // With no oracle configured the flag is a no-op.
    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true)
        .unwrap();

    let invoice = t.contract.get_invoice(&invoice_id).unwrap();
    assert_eq!(invoice.status, InvoiceStatus::Funded);
}
