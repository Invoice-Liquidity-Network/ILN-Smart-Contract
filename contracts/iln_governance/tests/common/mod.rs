//! Shared harness for the governance audit tests (Issues #1204-#1207).
//!
//! Each `tests/audit_*.rs` file declares `mod common;`. The harness registers
//! a governance contract, a Stellar-asset governance token and a mock ILN
//! contract, then checkpoints the proposer so the setup mirrors the
//! steady-state path used by `src/test.rs`.
#![allow(dead_code)]

use iln_governance::{GovContract, GovContractClient, ProposalAction};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, BytesN, Env,
};

/// Mock ILN contract whose governance-callable setter succeeds.
pub mod mock_iln_ok {
    use soroban_sdk::{contract, contractimpl, Env};

    #[contract]
    pub struct MockIlnOk;

    #[contractimpl]
    impl MockIlnOk {
        pub fn update_fee_rate(_env: Env, _rate: u32) {}
    }
}

/// Mock ILN contract whose governance-callable setter always fails. Lives in
/// its own module so the `#[contractimpl]`-generated symbols do not collide
/// with `MockIlnOk`'s identically named function.
pub mod mock_iln_failing {
    use soroban_sdk::{contract, contracterror, contractimpl, Env};

    #[contracterror]
    #[derive(Copy, Clone, Debug, PartialEq)]
    pub enum MockFailError {
        AlwaysFails = 1,
    }

    #[contract]
    pub struct MockIlnFailing;

    #[contractimpl]
    impl MockIlnFailing {
        pub fn update_fee_rate(_env: Env, _rate: u32) -> Result<(), MockFailError> {
            Err(MockFailError::AlwaysFails)
        }
    }
}

pub const START_TIMESTAMP: u64 = 1_700_000_000;
/// Voting window length used by the contract (seconds).
pub const VOTING_PERIOD_SECS: u64 = 259_200;
/// Seeded governance-token total supply. With the default 10% quorum the
/// quorum is 1_000 votes, which equals the proposer's balance.
pub const TOTAL_SUPPLY: i128 = 10_000;
/// Default proposer holding gate and the proposer's starting balance.
pub const PROPOSER_BALANCE: i128 = 1_000;
/// Mirrors the contract's private `MIN_VOTE_HOLD_LEDGERS`.
pub const HOLD_LEDGERS: u32 = 10;

pub struct Harness {
    pub env: Env,
    pub gov: GovContractClient<'static>,
    pub token: TokenClient<'static>,
    pub token_admin: StellarAssetClient<'static>,
    pub iln: Address,
    pub admin: Address,
    pub proposer: Address,
}

/// Governance wired to a mock ILN whose setter succeeds.
pub fn setup() -> Harness {
    build(false)
}

/// Governance wired to a mock ILN whose setter always fails.
pub fn setup_failing_iln() -> Harness {
    build(true)
}

fn build(failing: bool) -> Harness {
    let env = Env::default();
    env.mock_all_auths();

    let token_admin_addr = Address::generate(&env);
    let token_addr = env
        .register_stellar_asset_contract_v2(token_admin_addr)
        .address();
    let token = TokenClient::new(&env, &token_addr);
    let token_admin = StellarAssetClient::new(&env, &token_addr);

    let proposer = Address::generate(&env);
    let admin = Address::generate(&env);
    token_admin.mint(&proposer, &PROPOSER_BALANCE);

    let iln = if failing {
        env.register_contract(None, mock_iln_failing::MockIlnFailing)
    } else {
        env.register_contract(None, mock_iln_ok::MockIlnOk)
    };
    let dist = Address::generate(&env);
    let rep = Address::generate(&env);

    let gov_id = env.register_contract(None, GovContract);
    let gov = GovContractClient::new(&env, &gov_id);
    gov.initialize(&iln, &dist, &rep, &token_addr, &admin, &TOTAL_SUPPLY);

    let mut ledger = env.ledger().get();
    ledger.timestamp = START_TIMESTAMP;
    env.ledger().set(ledger);

    gov.checkpoint_balance(&proposer);
    advance_ledgers(&env, HOLD_LEDGERS + 1);

    Harness {
        env,
        gov,
        token,
        token_admin,
        iln,
        admin,
        proposer,
    }
}

pub fn hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

pub fn advance_ledgers(env: &Env, n: u32) {
    let mut ledger = env.ledger().get();
    ledger.sequence_number += n;
    env.ledger().set(ledger);
}

/// Moves the clock just past the end of the voting window.
pub fn advance_past_voting(env: &Env) {
    let mut ledger = env.ledger().get();
    ledger.timestamp += VOTING_PERIOD_SECS + 1;
    env.ledger().set(ledger);
}

/// Creates a fee proposal from the harness proposer.
pub fn new_proposal(h: &Harness) -> u64 {
    h.gov.create_proposal(
        &h.proposer,
        &ProposalAction::UpdateFeeRate(200),
        &hash(&h.env, 1),
        &200_i128,
    )
}

/// Mints `amount` to a fresh address, records its checkpoint and ages it past
/// the holding period, so it is eligible on proposals created afterwards.
pub fn aged_voter(h: &Harness, amount: i128) -> Address {
    let voter = Address::generate(&h.env);
    h.token_admin.mint(&voter, &amount);
    h.gov.checkpoint_balance(&voter);
    advance_ledgers(&h.env, HOLD_LEDGERS + 1);
    voter
}

/// Creates a proposal, has the proposer vote for it (weight == quorum) and
/// moves it `Active -> Passed` under the currently configured delay. Returns
/// the proposal id.
pub fn queue_proposal(h: &Harness) -> u64 {
    let id = new_proposal(h);
    h.gov.cast_vote(&h.proposer, &id, &true);
    advance_past_voting(&h.env);
    h.gov.execute_proposal(&id);
    id
}
