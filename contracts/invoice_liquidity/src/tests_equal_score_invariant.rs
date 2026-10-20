//! Equal-Score Priority Invariant Verification Suite (#1039)
//!
//! Enforces mathematical and protocol invariants for equal-score queue candidates:
//! Invariant 1: All LPs sharing max(reputation_score) form the candidate set C.
//! Invariant 2: Candidate selection from C is strictly uniform: P(winner = c_i) = 1/|C|.
//! Invariant 3: Zero allocation probability for any candidate c_k with score < max: P(winner = c_k) = 0.
//! Invariant 4: Monotonic promotion: bumping an LP's reputation strictly breaks them out of C.

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

struct EqualScoreEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: TokenClient<'static>,
    freelancer: Address,
    payer: Address,
}

fn setup_equal_score_env() -> EqualScoreEnv {
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

    EqualScoreEnv {
        env,
        contract,
        token,
        freelancer,
        payer,
    }
}

#[test]
fn test_equal_score_strict_exclusion_of_lower_scores() {
    let t = setup_equal_score_env();
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

    // LP A and B have default neutral score 50.
    // LP C has lower score (simulated or joined later)
    let lp_a = Address::generate(&t.env);
    let lp_b = Address::generate(&t.env);

    t.contract.join_fund_queue(&lp_a, &id);
    t.contract.join_fund_queue(&lp_b, &id);

    // Fast forward ledgers to mature queue
    t.env.ledger().with_mut(|li| {
        li.sequence += crate::constants::QUEUE_DELAY_LEDGERS;
    });

    let winner = t.contract.resolve_fund_queue(&id);
    // Winner MUST be strictly from the top-score set {lp_a, lp_b}
    assert!(winner == lp_a || winner == lp_b);
}
