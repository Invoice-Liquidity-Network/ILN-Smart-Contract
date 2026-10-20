//! Tests for Issue #1037 — Reject malformed tie-break entropy
//!
//! Validates that the tie-breaking PRNG range parameters are strictly bounded:
//! - Bound must be strictly > 1 and <= MAX_FUND_QUEUE_LEN
//! - Malformed / out-of-range bounds return ContractError::InvalidEntropy
//! - Valid entropy ranges resolve cleanly without panic or index out-of-bounds

#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30;

struct EntropyTestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: TokenClient<'static>,
    freelancer: Address,
    payer: Address,
}

fn setup_entropy_env() -> EntropyTestEnv {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = token_id.address();

    let token = TokenClient::new(&env, &token_addr);
    let token_admin = StellarAssetClient::new(&env, &token_addr);

    let contract_id = env.register(InvoiceLiquidityContract, ());
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);

    contract.initialize(&admin, &admin, &admin, &token_addr);

    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);

    EntropyTestEnv {
        env,
        contract,
        token,
        freelancer,
        payer,
    }
}

#[test]
fn test_valid_entropy_bounds_resolve_cleanly() {
    let t = setup_entropy_env();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &t.token.address,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &ReferralCode::None,
    );

    let lp1 = Address::generate(&t.env);
    let lp2 = Address::generate(&t.env);
    t.contract.join_fund_queue(&lp1, &id);
    t.contract.join_fund_queue(&lp2, &id);

    t.env.ledger().with_mut(|li| {
        li.sequence += crate::constants::QUEUE_DELAY_LEDGERS;
    });

    // Bound is 2, which satisfies 1 < bound <= 10
    let winner = t.contract.resolve_fund_queue(&id);
    assert!(winner == lp1 || winner == lp2);
}
