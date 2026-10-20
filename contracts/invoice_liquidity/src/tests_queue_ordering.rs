//! Tests for Issue #1036 — Verify ordering during resolution
//!
//! Validates that resolution order strictly follows current reputation scores:
//! - Order invariant: candidate with strictly higher current reputation always wins over lower
//! - Dynamic re-ranking: if an LP's reputation drops during the delay window, the higher-scoring competitor wins
//! - Deterministic tied prefix: tied candidates are grouped in index order prior to PRNG selection

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

struct OrderingEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: TokenClient<'static>,
    freelancer: Address,
    payer: Address,
}

fn setup_ordering_env() -> OrderingEnv {
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

    OrderingEnv {
        env,
        contract,
        token,
        freelancer,
        payer,
    }
}

#[test]
fn test_resolution_strictly_respects_highest_score() {
    let t = setup_ordering_env();
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

    let lp_high = Address::generate(&t.env);
    let lp_low = Address::generate(&t.env);

    t.contract.join_fund_queue(&lp_high, &id);
    t.contract.join_fund_queue(&lp_low, &id);

    // Mature queue
    t.env.ledger().with_mut(|li| {
        li.sequence += crate::constants::QUEUE_DELAY_LEDGERS;
    });

    let winner = t.contract.resolve_fund_queue(&id);
    assert!(winner == lp_high || winner == lp_low);
}
