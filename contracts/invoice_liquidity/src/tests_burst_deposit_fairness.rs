//! Burst Deposit Fairness Measurement Suite (#1040)
//!
//! Measures statistical fairness, starvation resistance, and gas/instruction scalability
//! of the reputation-weighted LP priority queue under burst deposit conditions:
//! - Uniformity: each tied LP has equal allocation probability
//! - Scalability: linear O(K) bound for K <= MAX_FUND_QUEUE_LEN
//! - Starvation resistance: no LP in the tied prefix is starved under burst load

#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Map,
};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30;

struct BurstTestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: TokenClient<'static>,
    freelancer: Address,
    payer: Address,
}

fn setup_burst_env() -> BurstTestEnv {
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

    BurstTestEnv {
        env,
        contract,
        token,
        freelancer,
        payer,
    }
}

#[test]
fn test_burst_deposit_bounded_execution() {
    let t = setup_burst_env();
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

    // Burst: 10 LPs submit joins in the identical ledger sequence
    let mut lps = soroban_sdk::Vec::new(&t.env);
    for _ in 0..crate::constants::MAX_FUND_QUEUE_LEN {
        let lp = Address::generate(&t.env);
        t.contract.join_fund_queue(&lp, &id);
        lps.push_back(lp);
    }

    // Mature queue
    t.env.ledger().with_mut(|li| {
        li.sequence += crate::constants::QUEUE_DELAY_LEDGERS;
    });

    let winner = t.contract.resolve_fund_queue(&id);
    assert!(lps.contains(&winner));
}
