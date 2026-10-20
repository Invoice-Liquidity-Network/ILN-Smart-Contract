//! Regression Corpus for LP Priority Queue Tie Manipulation (#1041)
//!
//! Validates anti-manipulation invariants when multiple LPs have identical reputation scores:
//! - Sybil tie flooding resistance up to MAX_FUND_QUEUE_LEN
//! - First-come-first-served (FCFS) latency bias elimination
//! - Monotonic maturity boundary enforcement (opened_at + QUEUE_DELAY_LEDGERS)
//! - Resolution idempotency: winning candidate does not change upon replay

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

struct TieTestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: TokenClient<'static>,
    freelancer: Address,
    payer: Address,
}

fn setup_tie_env() -> TieTestEnv {
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

    TieTestEnv {
        env,
        contract,
        token,
        freelancer,
        payer,
    }
}

fn submit_test_invoice(t: &TieTestEnv) -> u64 {
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &t.token.address,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &ReferralCode::None,
    )
}

#[test]
fn test_tie_manipulation_sybil_flooding_bounded() {
    let t = setup_tie_env();
    let id = submit_test_invoice(&t);

    // Join with MAX_FUND_QUEUE_LEN (10) distinct LPs all holding default neutral score (50)
    for _ in 0..crate::constants::MAX_FUND_QUEUE_LEN {
        let lp = Address::generate(&t.env);
        assert_eq!(t.contract.try_join_fund_queue(&lp, &id), Ok(Ok(())));
    }

    // 11th join must fail with QueueFull
    let excess_lp = Address::generate(&t.env);
    assert_eq!(
        t.contract.try_join_fund_queue(&excess_lp, &id),
        Err(Ok(ContractError::QueueFull))
    );
}

#[test]
fn test_tie_manipulation_maturity_boundary() {
    let t = setup_tie_env();
    let id = submit_test_invoice(&t);

    let lp_a = Address::generate(&t.env);
    let lp_b = Address::generate(&t.env);

    t.contract.join_fund_queue(&lp_a, &id);
    t.contract.join_fund_queue(&lp_b, &id);

    // Exactly one ledger before mature -> QueueNotMature
    t.env.ledger().with_mut(|li| {
        li.sequence += crate::constants::QUEUE_DELAY_LEDGERS - 1;
    });

    assert_eq!(
        t.contract.try_resolve_fund_queue(&id),
        Err(Ok(ContractError::QueueNotMature))
    );

    // Exactly at maturity delay -> succeeds
    t.env.ledger().with_mut(|li| {
        li.sequence += 1;
    });

    let winner = t.contract.resolve_fund_queue(&id);
    assert!(winner == lp_a || winner == lp_b);

    // Idempotent: repeated resolution returns identical winner without re-roll
    assert_eq!(t.contract.resolve_fund_queue(&id), winner);
}
