//! Issue #843: admin-storage reads on a fresh (un-initialised) instance now
//! return `ContractError::NotInitialized` instead of panicking via
//! `.unwrap()`.
//!
//! Coverage: deploy a raw contract (skip `initialize`), invoke a
//! representative set of admin-gated entry points, and assert every one
//! returns the typed error. Then repeat post-init to confirm the happy
//! path is unchanged.

use invoice_liquidity::{
    constants::ADMIN_CHANGE_COOLDOWN_LEDGERS, ContractError, InvoiceLiquidityContract,
    InvoiceLiquidityContractClient,
};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env,
};

fn setup_uninitialised() -> (Env, InvoiceLiquidityContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let client = InvoiceLiquidityContractClient::new(&env, &contract_id);
    (env, client)
}

fn setup_initialised() -> (Env, InvoiceLiquidityContractClient<'static>, Address) {
    let (env, client) = setup_uninitialised();
    let admin = Address::generate(&env);

    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin);
    let usdc = usdc_id.address();

    let xlm_admin = Address::generate(&env);
    let xlm_id = env.register_stellar_asset_contract_v2(xlm_admin);
    let xlm = xlm_id.address();

    let eurc = Address::generate(&env);

    client.initialize(&admin, &usdc, &eurc, &xlm);

    // Advance past the widest admin-cooldown window (set_admin's) so
    // subsequent admin actions can run without hitting the rate limit.
    let mut ledger = env.ledger().get();
    ledger.sequence_number += ADMIN_CHANGE_COOLDOWN_LEDGERS as u32 + 10;
    ledger.timestamp += 3600;
    env.ledger().set(ledger);

    (env, client, admin)
}

// ── Pre-init: each admin-gated entry point returns NotInitialized ────────────

#[test]
fn set_admin_pre_init_returns_not_initialized() {
    let (env, client) = setup_uninitialised();
    let new_admin = Address::generate(&env);
    let result = client.try_set_admin(&new_admin);
    assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
}

#[test]
fn update_fee_rate_pre_init_returns_not_initialized() {
    let (_env, client) = setup_uninitialised();
    let result = client.try_update_fee_rate(&500);
    assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
}

#[test]
fn update_max_discount_pre_init_returns_not_initialized() {
    let (_env, client) = setup_uninitialised();
    let result = client.try_update_max_discount(&2000);
    assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
}

#[test]
fn pause_pre_init_returns_not_initialized() {
    let (_env, client) = setup_uninitialised();
    let result = client.try_pause();
    assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
}

#[test]
fn unpause_pre_init_returns_not_initialized() {
    let (_env, client) = setup_uninitialised();
    let result = client.try_unpause();
    assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
}

#[test]
fn set_min_payer_reputation_pre_init_returns_not_initialized() {
    let (_env, client) = setup_uninitialised();
    let result = client.try_set_min_payer_reputation(&10);
    assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
}

#[test]
fn set_max_invoice_amount_pre_init_returns_not_initialized() {
    let (_env, client) = setup_uninitialised();
    let result = client.try_set_max_invoice_amount(&1_000_000);
    assert_eq!(result, Err(Ok(ContractError::NotInitialized)));
}

// ── Post-init: happy path still succeeds ─────────────────────────────────────

#[test]
fn update_fee_rate_after_init_succeeds() {
    let (_env, client, _admin) = setup_initialised();
    client.update_fee_rate(&500);
}

#[test]
fn pause_after_init_succeeds() {
    let (_env, client, _admin) = setup_initialised();
    client.pause();
}

#[test]
fn set_admin_after_init_succeeds() {
    let (env, client, _admin) = setup_initialised();
    let new_admin = Address::generate(&env);
    client.set_admin(&new_admin);
}
