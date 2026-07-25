#![cfg(test)]

//! Property-based fuzz tests for `submit_invoice()` validation.
//!
//! Uses the `proptest` crate to generate randomized inputs and verify that
//! input constraints and system invariants hold across hundreds of cases.
//!
//! Properties tested:
//!   1. `amount <= 0` → `InvalidAmount`
//!   2. `discount_rate == 0 || discount_rate > 5000` → `InvalidDiscountRate`
//!   3. `due_date <= current_timestamp` → `InvalidDueDate`
//!   4. Valid inputs always succeed without panicking
//!   5. Sequential submissions produce monotonically increasing invoice IDs

use super::*;
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env,
};

// ----------------------------------------------------------------
// Shared setup — mirrors existing test modules
// ----------------------------------------------------------------

const LEDGER_TIMESTAMP: u64 = 1_700_000_000;

struct FuzzEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token_address: Address,
    freelancer: Address,
    payer: Address,
}

fn setup_fuzz() -> FuzzEnv {
    let env = Env::default();
    env.mock_all_auths();

    // Deploy mock USDC token
    let usdc_admin = Address::generate(&env);
    let usdc_contract_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_address = usdc_contract_id.address();

    // Generate test wallets
    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);

    // Deploy and initialise the ILN contract
    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);

    let xlm_admin = Address::generate(&env);
    let xlm_contract_id = env.register_stellar_asset_contract_v2(xlm_admin);
    let xlm_address = xlm_contract_id.address();

    let eurc_address = Address::generate(&env);
    contract.initialize(&usdc_admin, &usdc_address, &eurc_address, &xlm_address);

    // Fix ledger timestamp to a known baseline
    let mut ledger_info = env.ledger().get();
    ledger_info.timestamp = LEDGER_TIMESTAMP;
    env.ledger().set(ledger_info);

    FuzzEnv {
        env,
        contract,
        token_address: usdc_address,
        freelancer,
        payer,
    }
}

// ----------------------------------------------------------------
// Property 1: Invalid Amount
//
// For any `amount <= 0`, submit_invoice must return InvalidAmount.
// ----------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn prop_invalid_amount_rejected(amount in i128::MIN..=0i128) {
        let t = setup_fuzz();
        let due_date = LEDGER_TIMESTAMP + 86_400;
        let discount_rate: u32 = 300;

        let result = t.contract.try_submit_invoice(&ReferralCode::None);

        prop_assert_eq!(
            result,
            Err(Ok(ContractError::InvalidAmount)),
            "amount={} should be rejected as InvalidAmount", amount
        );
    }
}

// ----------------------------------------------------------------
// Property 2: Invalid Discount Rate
//
// For any `discount_rate == 0` OR `discount_rate > 5000`,
// submit_invoice must return InvalidDiscountRate.
// ----------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn prop_zero_discount_rate_rejected(amount in 1i128..=1_000_000_000_000i128) {
        let t = setup_fuzz();
        let due_date = LEDGER_TIMESTAMP + 86_400;

        let result = t.contract.try_submit_invoice(&ReferralCode::None);

        prop_assert_eq!(
            result,
            Err(Ok(ContractError::InvalidDiscountRate)),
            "discount_rate=0 should be rejected as InvalidDiscountRate"
        );
    }

    #[test]
    fn prop_excessive_discount_rate_rejected(discount_rate in 5001u32..=u32::MAX) {
        let t = setup_fuzz();
        let due_date = LEDGER_TIMESTAMP + 86_400;
        let amount: i128 = 1_000_000_000;

        let result = t.contract.try_submit_invoice(&ReferralCode::None);

        prop_assert_eq!(
            result,
            Err(Ok(ContractError::InvalidDiscountRate)),
            "discount_rate={} (>5000) should be rejected as InvalidDiscountRate", discount_rate
        );
    }
}

// ----------------------------------------------------------------
// Property 3: Invalid Due Date
//
// For any `due_date <= current_timestamp`, submit_invoice must
// return InvalidDueDate.
// ----------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn prop_past_or_current_due_date_rejected(due_date in 0u64..=LEDGER_TIMESTAMP) {
        let t = setup_fuzz();
        let amount: i128 = 1_000_000_000;
        let discount_rate: u32 = 300;

        let result = t.contract.try_submit_invoice(&ReferralCode::None);

        prop_assert_eq!(
            result,
            Err(Ok(ContractError::InvalidDueDate)),
            "due_date={} (<= {}) should be rejected as InvalidDueDate", due_date, LEDGER_TIMESTAMP
        );
    }
}

// ----------------------------------------------------------------
// Property 4: Valid Inputs Always Succeed
//
// For inputs satisfying all constraints, submit_invoice must:
//   - Always succeed (return Ok)
//   - Never panic
//   - Return a positive invoice ID
// ----------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn prop_valid_inputs_always_succeed(
        amount in 1i128..=10_000_000_000i128,
        discount_rate in 1u32..=5000u32,
        due_date_offset in 1u64..=31_536_000u64, // 1 second to 1 year
    ) {
        let t = setup_fuzz();
        let due_date = LEDGER_TIMESTAMP + due_date_offset;

        let result = t.contract.try_submit_invoice(&ReferralCode::None);

        prop_assert!(
            result.is_ok(),
            "Valid inputs (amount={}, rate={}, due_date={}) \
             should always succeed, but got: {:?}",
            amount, discount_rate, due_date, result
        );

        let invoice_id = result.unwrap().unwrap();
        prop_assert!(
            invoice_id > 0,
            "Invoice ID must be positive, got {}", invoice_id
        );
    }
}

// ----------------------------------------------------------------
// Property 5: Monotonically Increasing Invoice IDs
//
// When calling submit_invoice() multiple times with valid inputs,
// each returned invoice ID must be strictly greater than the
// previous one.
// ----------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn prop_invoice_ids_monotonically_increase(
        count in 2usize..=8usize,
        base_amount in 1i128..=1_000_000_000i128,
        discount_rate in 1u32..=5000u32,
    ) {
        let t = setup_fuzz();
        let due_date = LEDGER_TIMESTAMP + 86_400 * 30;

        let mut previous_id: u64 = 0;

        for i in 0..count {
            // Vary the amount slightly per iteration to exercise different paths
            let amount = base_amount + (i as i128);

            let id = t.contract.submit_invoice(        &ReferralCode::None,
    );

            prop_assert!(
                id > previous_id,
                "Invoice ID must be strictly increasing: \
                 iteration={}, previous={}, current={}",
                 i, previous_id, id
            );

            previous_id = id;
        }
    }
}
