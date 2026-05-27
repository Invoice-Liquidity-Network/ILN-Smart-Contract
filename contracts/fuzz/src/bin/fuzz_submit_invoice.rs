//! Fuzz entry point for `submit_invoice()` input validation.
//!
//! Uses libFuzzer (via cargo-fuzz) to generate arbitrary byte sequences and
//! map them to the four user-controlled inputs of `submit_invoice()`:
//!
//!   | field         | bytes | interpretation                    |
//!   |---------------|-------|-----------------------------------|
//!   | amount        |  16   | i128 (little-endian)              |
//!   | discount_rate |   4   | u32 (little-endian)               |
//!   | due_date      |   8   | u64 offset added to timestamp     |
//!   | payer seed    |   4   | u32 — selects from pre-built pool |
//!
//! **Property:** `submit_invoice()` must never panic regardless of input.
//! It may return an `Err` variant but must always terminate gracefully.
//!
//! # Running
//!
//! ```text
//! cargo fuzz run fuzz_submit_invoice
//! # Run for at least 1 million iterations before audit:
//! cargo fuzz run fuzz_submit_invoice -- -runs=1000000
//! ```

#![no_main]

use invoice_liquidity::InvoiceLiquidityContract;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    Address, Env,
};

/// Minimum raw input size: 16 (amount) + 4 (rate) + 8 (due_date) + 4 (payer) = 32 bytes.
const MIN_INPUT: usize = 32;

fuzz_target!(|data: &[u8]| {
    if data.len() < MIN_INPUT {
        return;
    }

    // ── Decode fuzz bytes ────────────────────────────────────────
    let amount = i128::from_le_bytes(data[0..16].try_into().unwrap());
    let discount_rate = u32::from_le_bytes(data[16..20].try_into().unwrap());
    let due_date_raw = u64::from_le_bytes(data[20..28].try_into().unwrap());
    let payer_seed = u32::from_le_bytes(data[28..32].try_into().unwrap());

    // ── Build a minimal Soroban test environment ─────────────────
    let env = Env::default();
    env.mock_all_auths();

    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_addr = usdc_id.address();

    let xlm_admin = Address::generate(&env);
    let xlm_id = env.register_stellar_asset_contract_v2(xlm_admin);
    let xlm_addr = xlm_id.address();

    let contract_id = env.register(InvoiceLiquidityContract, ());
    let contract =
        invoice_liquidity::InvoiceLiquidityContractClient::new(&env, &contract_id);

    contract.initialize(&usdc_admin, &usdc_addr, &xlm_addr);

    // Fix ledger timestamp to a known baseline.
    const BASE_TIMESTAMP: u64 = 1_700_000_000;
    let mut ledger_info = env.ledger().get();
    ledger_info.timestamp = BASE_TIMESTAMP;
    env.ledger().set(ledger_info);

    // Build a small pool of payer addresses and pick one via payer_seed.
    let payers: [Address; 4] = [
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    ];
    let payer = payers[(payer_seed % 4) as usize].clone();

    let freelancer = Address::generate(&env);

    // Mint some tokens so funding calls don't immediately fail on balance.
    StellarAssetClient::new(&env, &usdc_addr).mint(&freelancer, &1_000_000_000_000);

    // due_date is clamped to avoid overflow when added to the base timestamp.
    let due_date = BASE_TIMESTAMP.saturating_add(due_date_raw % (365 * 86_400 * 200));

    // ── Exercise submit_invoice — must never panic ────────────────
    // We use try_submit_invoice so errors are returned, not panicked.
    let _ = contract.try_submit_invoice(
        &freelancer,
        &payer,
        &amount,
        &due_date,
        &discount_rate,
        &usdc_addr,
    );
});
