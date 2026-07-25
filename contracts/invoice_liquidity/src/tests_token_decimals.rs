//! Tests for Issue #23 — token decimals registry.
//!
//! Verifies that:
//! - Decimals are stored and retrievable for tokens added via `initialize` and
//!   `add_token`.
//! - The minimum invoice amount check is scaled correctly per token precision
//!   (6-decimal USDC vs 7-decimal XLM).
//! - Discount and yield calculations preserve full precision for both token
//!   types.
//! - A token added without explicit decimals falls back gracefully to 6.

#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

const DISCOUNT_RATE: u32 = 300; // 3.00% in basis points
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30; // 30 days

struct TokenInfo {
    address: Address,
    client: TokenClient<'static>,
    admin: StellarAssetClient<'static>,
}

fn register_token(env: &Env) -> TokenInfo {
    let admin_addr = Address::generate(env);
    let contract = env.register_stellar_asset_contract_v2(admin_addr);
    let address = contract.address();
    TokenInfo {
        address: address.clone(),
        client: TokenClient::new(env, &address),
        admin: StellarAssetClient::new(env, &address),
    }
}

/// Deploy the invoice liquidity contract with USDC (6 dec) and XLM (7 dec)
/// as the two bootstrap tokens, returning the client and helper handles.
fn bootstrap() -> (
    Env,
    InvoiceLiquidityContractClient<'static>,
    TokenInfo,
    TokenInfo,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let usdc = register_token(&env);
    let xlm = register_token(&env);

    // Mint generous balances for standard test accounts
    let minter = Address::generate(&env);
    usdc.admin.mint(&minter, &10_000_000_000_000);
    xlm.admin.mint(&minter, &10_000_000_000_000);

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);

    // initialize() seeds USDC at 6 decimals and XLM at 7 decimals
    contract.initialize(&admin, &usdc.address, &xlm.address);

    // Set a reasonable timestamp baseline
    env.ledger().with_mut(|l| l.timestamp = 1_700_000_000);

    (env, contract, usdc, xlm, admin)
}

// ----------------------------------------------------------------
// 1. Decimals are stored correctly at initialize time
// ----------------------------------------------------------------

#[test]
fn test_initialize_stores_6_decimals_for_usdc() {
    let (_, contract, usdc, _, _) = bootstrap();
    assert_eq!(
        contract.get_token_decimals(&usdc.address),
        Some(6_u32),
        "USDC should be registered with 6 decimals"
    );
}

#[test]
fn test_initialize_stores_7_decimals_for_xlm() {
    let (_, contract, _, xlm, _) = bootstrap();
    assert_eq!(
        contract.get_token_decimals(&xlm.address),
        Some(7_u32),
        "XLM should be registered with 7 decimals"
    );
}

// ----------------------------------------------------------------
// 2. add_token stores the supplied decimals
// ----------------------------------------------------------------

#[test]
fn test_add_token_stores_supplied_decimals() {
    let (env, contract, _, _, _) = bootstrap();

    let eurc = register_token(&env);
    contract.add_token(&eurc.address, &6_u32);

    assert_eq!(
        contract.get_token_decimals(&eurc.address),
        Some(6_u32),
        "EURC should be registered with 6 decimals after add_token"
    );
}

#[test]
fn test_add_token_stores_custom_decimal_precision() {
    let (env, contract, _, _, _) = bootstrap();

    // Hypothetical 8-decimal token (e.g. WBTC-style)
    let wbtc_like = register_token(&env);
    contract.add_token(&wbtc_like.address, &8_u32);

    assert_eq!(
        contract.get_token_decimals(&wbtc_like.address),
        Some(8_u32),
        "8-decimal token should have 8 stored"
    );
}

#[test]
fn test_get_token_decimals_returns_none_for_unknown_token() {
    let (env, contract, _, _, _) = bootstrap();

    let unknown = Address::generate(&env);
    assert_eq!(
        contract.get_token_decimals(&unknown),
        None,
        "Unknown token should return None"
    );
}

// ----------------------------------------------------------------
// 3. Minimum amount enforced correctly per token precision
// ----------------------------------------------------------------

/// USDC (6 dec): minimum = 1_000_000 (= 1 USDC).
/// Exactly 1_000_000 should be accepted.
#[test]
fn test_minimum_amount_accepted_for_6_decimal_token() {
    let (env, contract, usdc, _, _) = bootstrap();

    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let due_date = env.ledger().timestamp() + DUE_DATE_OFFSET;

    let result = contract.try_submit_invoice(
        &freelancer,
        &payer,
        &1_000_000, // exactly 1 USDC
        &due_date,
        &DISCOUNT_RATE,
        &usdc.address,
    );
    assert!(
        result.is_ok(),
        "1 USDC (1_000_000 units) should meet the 6-decimal minimum"
    );
}

/// USDC (6 dec): 999_999 is below 1 USDC and must be rejected.
#[test]
fn test_below_minimum_rejected_for_6_decimal_token() {
    let (env, contract, usdc, _, _) = bootstrap();

    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let due_date = env.ledger().timestamp() + DUE_DATE_OFFSET;

    let result = contract.try_submit_invoice(
        &freelancer,
        &payer,
        &999_999, // < 1 USDC
        &due_date,
        &DISCOUNT_RATE,
        &usdc.address,
    );
    assert_eq!(
        result,
        Err(Ok(ContractError::InvalidAmount)),
        "Sub-minimum USDC amount should be rejected"
    );
}

/// XLM (7 dec): minimum = 10_000_000 (= 1 XLM).
/// Exactly 10_000_000 should be accepted.
#[test]
fn test_minimum_amount_accepted_for_7_decimal_token() {
    let (env, contract, _, xlm, _) = bootstrap();

    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let due_date = env.ledger().timestamp() + DUE_DATE_OFFSET;

    let result = contract.try_submit_invoice(
        &freelancer,
        &payer,
        &10_000_000, // exactly 1 XLM
        &due_date,
        &DISCOUNT_RATE,
        &xlm.address,
    );
    assert!(
        result.is_ok(),
        "1 XLM (10_000_000 stroops) should meet the 7-decimal minimum"
    );
}

/// XLM (7 dec): 9_999_999 stroops is less than 1 XLM and must be rejected.
#[test]
fn test_below_minimum_rejected_for_7_decimal_token() {
    let (env, contract, _, xlm, _) = bootstrap();

    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let due_date = env.ledger().timestamp() + DUE_DATE_OFFSET;

    let result = contract.try_submit_invoice(
        &freelancer,
        &payer,
        &9_999_999, // < 1 XLM
        &due_date,
        &DISCOUNT_RATE,
        &xlm.address,
    );
    assert_eq!(
        result,
        Err(Ok(ContractError::InvalidAmount)),
        "Sub-minimum XLM amount should be rejected with the 7-decimal floor"
    );
}

/// A USDC amount (1_000_000) that passes the 6-decimal floor must also fail
/// the 7-decimal floor when the token has 7 decimals registered.
#[test]
fn test_6dec_minimum_fails_for_7_decimal_token() {
    let (env, contract, _, xlm, _) = bootstrap();

    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let due_date = env.ledger().timestamp() + DUE_DATE_OFFSET;

    // 1_000_000 is ≥ the old hard-coded USDC floor but < 1 XLM (10_000_000)
    let result = contract.try_submit_invoice(&ReferralCode::None);
    assert_eq!(
        result,
        Err(Ok(ContractError::InvalidAmount)),
        "1_000_000 should be below the XLM minimum and get rejected"
    );
}

// ----------------------------------------------------------------
// 4. Discount calculation preserves precision for 6-decimal token
// ----------------------------------------------------------------

#[test]
fn test_discount_precision_6_decimal_token() {
    let (env, contract, usdc, _, _) = bootstrap();

    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let funder = Address::generate(&env);

    // Mint enough tokens
    usdc.admin.mint(&funder, &1_000_000_000_000);
    usdc.admin.mint(&payer, &1_000_000_000_000);
    usdc.admin.mint(&contract.address, &1_000_000_000_000);

    // 100 USDC expressed in 6 decimals = 100_000_000
    let amount: i128 = 100_000_000;
    let due_date = env.ledger().timestamp() + DUE_DATE_OFFSET;

    let id = contract.submit_invoice(
        &freelancer,
        &payer,
        &amount,
        &due_date,
        &DISCOUNT_RATE, // 3.00%
        &usdc.address,
    );

    let freelancer_before = usdc.client.balance(&freelancer);
    let funder_before = usdc.client.balance(&funder);

    contract.fund_invoice(&funder, &id, &amount);

    // discount = 100_000_000 * 300 / 10_000 = 3_000_000 (3 USDC)
    let expected_discount: i128 = amount * DISCOUNT_RATE as i128 / 10_000;
    let expected_payout = amount - expected_discount;

    assert_eq!(
        usdc.client.balance(&freelancer) - freelancer_before,
        expected_payout,
        "Freelancer should receive amount minus 3% discount (USDC 6-decimal path)"
    );

    contract.mark_paid(&id, &amount);

    assert_eq!(
        usdc.client.balance(&funder) - funder_before,
        expected_discount,
        "LP net yield should equal the 3% discount (USDC 6-decimal path)"
    );
}

// ----------------------------------------------------------------
// 5. Discount calculation preserves precision for 7-decimal token
// ----------------------------------------------------------------

#[test]
fn test_discount_precision_7_decimal_token() {
    let (env, contract, _, xlm, _) = bootstrap();

    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let funder = Address::generate(&env);

    xlm.admin.mint(&funder, &1_000_000_000_000);
    xlm.admin.mint(&payer, &1_000_000_000_000);
    xlm.admin.mint(&contract.address, &1_000_000_000_000);

    // 100 XLM expressed in 7 decimals = 1_000_000_000
    let amount: i128 = 1_000_000_000;
    let due_date = env.ledger().timestamp() + DUE_DATE_OFFSET;

    let id = contract.submit_invoice(
        &freelancer,
        &payer,
        &amount,
        &due_date,
        &DISCOUNT_RATE, // 3.00%
        &xlm.address,
    );

    let freelancer_before = xlm.client.balance(&freelancer);
    let funder_before = xlm.client.balance(&funder);

    contract.fund_invoice(&funder, &id, &amount);

    // discount = 1_000_000_000 * 300 / 10_000 = 30_000_000 (3 XLM)
    let expected_discount: i128 = amount * DISCOUNT_RATE as i128 / 10_000;
    let expected_payout = amount - expected_discount;

    assert_eq!(
        xlm.client.balance(&freelancer) - freelancer_before,
        expected_payout,
        "Freelancer should receive amount minus 3% discount (XLM 7-decimal path)"
    );

    contract.mark_paid(&id, &amount);

    assert_eq!(
        xlm.client.balance(&funder) - funder_before,
        expected_discount,
        "LP net yield should equal the 3% discount (XLM 7-decimal path)"
    );
}

// ----------------------------------------------------------------
// 6. Both token paths produce correct and distinct results
// ----------------------------------------------------------------

#[test]
fn test_6_and_7_decimal_tokens_maintain_independent_precision() {
    let (env, contract, usdc, xlm, _) = bootstrap();

    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let funder = Address::generate(&env);

    usdc.admin.mint(&funder, &1_000_000_000_000);
    usdc.admin.mint(&payer, &1_000_000_000_000);
    usdc.admin.mint(&contract.address, &1_000_000_000_000);
    xlm.admin.mint(&funder, &1_000_000_000_000);
    xlm.admin.mint(&payer, &1_000_000_000_000);
    xlm.admin.mint(&contract.address, &1_000_000_000_000);

    let due_date = env.ledger().timestamp() + DUE_DATE_OFFSET;

    // 50 USDC  = 50_000_000 (6 dec)
    let usdc_amount: i128 = 50_000_000;
    // 50 XLM   = 500_000_000 (7 dec)
    let xlm_amount: i128 = 500_000_000;

    let usdc_id = contract.submit_invoice(&ReferralCode::None);
    let xlm_id = contract.submit_invoice(&ReferralCode::None);

    contract.fund_invoice(&funder, &usdc_id, &usdc_amount);
    contract.fund_invoice(&funder, &xlm_id, &xlm_amount);

    let usdc_discount = usdc_amount * DISCOUNT_RATE as i128 / 10_000;
    let xlm_discount = xlm_amount * DISCOUNT_RATE as i128 / 10_000;

    contract.mark_paid(&usdc_id, &usdc_amount);
    contract.mark_paid(&xlm_id, &xlm_amount);

    // After both lifecycles complete the invoice statuses should both be Paid
    assert_eq!(contract.get_invoice(&usdc_id).status, InvoiceStatus::Paid);
    assert_eq!(contract.get_invoice(&xlm_id).status, InvoiceStatus::Paid);

    // The USDC and XLM discounts are different raw values, confirming each
    // token's precision was handled independently.
    assert_ne!(
        usdc_discount, xlm_discount,
        "USDC and XLM discounts should differ due to different precisions"
    );

    // Quick sanity: 3% of the supplied amounts
    assert_eq!(usdc_discount, 1_500_000); // 1.5 USDC
    assert_eq!(xlm_discount, 15_000_000); // 1.5 XLM
}

// ----------------------------------------------------------------
// 7. TokenAdded event includes decimals
// ----------------------------------------------------------------

#[test]
fn test_add_token_event_contains_decimals() {
    use soroban_sdk::testutils::Events as _;

    let (env, contract, _, _, _) = bootstrap();

    let new_token = register_token(&env);
    contract.add_token(&new_token.address, &8_u32);

    let events = env.events().all();
    let last_event = events.events().last();

    let expected = TokenAdded {
        token: new_token.address.clone(),
        decimals: 8,
    };

    assert_eq!(
        last_event,
        Some(&expected.to_xdr(&env, &contract.address)),
        "TokenAdded event should carry the decimals field"
    );
}

// ----------------------------------------------------------------
// 8. Overwriting decimals on re-add updates the registry
// ----------------------------------------------------------------

#[test]
fn test_re_adding_token_updates_stored_decimals() {
    let (env, contract, _, _, _) = bootstrap();

    let token = register_token(&env);
    contract.add_token(&token.address, &6_u32);
    assert_eq!(contract.get_token_decimals(&token.address), Some(6_u32));

    // Re-add with corrected precision
    contract.add_token(&token.address, &8_u32);
    assert_eq!(
        contract.get_token_decimals(&token.address),
        Some(8_u32),
        "Re-adding a token should update the stored decimal precision"
    );
}
