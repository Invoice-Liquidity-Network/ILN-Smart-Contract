extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Events as _, Ledger},
    xdr::ContractEvent,
    Address, BytesN, Env, Event,
};

#[contracttype]
enum MockStorageKey {
    FeeRate,
}

#[contract]
pub struct MockIln;

#[contractimpl]
impl MockIln {
    pub fn update_fee_rate(env: Env, rate: u32) {
        env.storage()
            .instance()
            .set(&MockStorageKey::FeeRate, &rate);
    }

    pub fn get_fee_rate(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&MockStorageKey::FeeRate)
            .unwrap_or(0)
    }
}

struct LifecycleTestEnv {
    env: Env,
    governance: GovContractClient<'static>,
    iln: MockIlnClient<'static>,
    proposer: Address,
    voter_a: Address,
    voter_b: Address,
    _gov_token_admin: soroban_sdk::token::StellarAssetClient<'static>,
}

fn setup() -> LifecycleTestEnv {
    let env = Env::default();
    env.mock_all_auths();

    let gov_token_admin_addr = Address::generate(&env);
    let gov_token_id = env.register_stellar_asset_contract_v2(gov_token_admin_addr);
    let gov_token = gov_token_id.address();
    let gov_token_admin = soroban_sdk::token::StellarAssetClient::new(&env, &gov_token);

    let proposer = Address::generate(&env);
    let voter_a = Address::generate(&env);
    let voter_b = Address::generate(&env);

    gov_token_admin.mint(&proposer, &1_000);
    gov_token_admin.mint(&voter_a, &2_000);
    gov_token_admin.mint(&voter_b, &500);

    let iln_id = env.register_contract(None, MockIln);
    let iln = MockIlnClient::new(&env, &iln_id);

    let governance_id = env.register_contract(None, GovContract);
    let governance = GovContractClient::new(&env, &governance_id);
    governance.initialize(&iln_id, &gov_token);

    let mut ledger = env.ledger().get();
    ledger.timestamp = 1_700_000_000;
    env.ledger().set(ledger);

    LifecycleTestEnv {
        env,
        governance,
        iln,
        proposer,
        voter_a,
        voter_b,
        _gov_token_admin: gov_token_admin,
    }
}

fn dummy_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[1_u8; 32])
}

fn create_fee_proposal(t: &LifecycleTestEnv) -> u64 {
    t.governance.create_proposal(
        &t.proposer,
        &ProposalAction::UpdateFeeRate(250),
        &dummy_hash(&t.env),
        &250_i128,
    )
}

fn proposal_created_event(
    env: &Env,
    contract: &Address,
    proposal_id: u64,
    proposer: &Address,
    action_type: ProposalAction,
    proposed_value: i128,
    created_at: u64,
    voting_end: u64,
) -> ContractEvent {
    ProposalCreated {
        proposal_id,
        proposer: proposer.clone(),
        action_type,
        proposed_value,
        created_at,
        voting_end,
    }
    .to_xdr(env, contract)
}

fn proposal_executed_event(
    env: &Env,
    contract: &Address,
    proposal_id: u64,
    action_type: ProposalAction,
    proposed_value: i128,
    votes_for: i128,
    votes_against: i128,
) -> ContractEvent {
    ProposalExecuted {
        proposal_id,
        action_type,
        proposed_value,
        votes_for,
        votes_against,
    }
    .to_xdr(env, contract)
}

fn vote_event(
    env: &Env,
    contract: &Address,
    proposal_id: u64,
    voter: &Address,
    support: bool,
    weight: i128,
) -> ContractEvent {
    VoteCast {
        proposal_id,
        voter: voter.clone(),
        support,
        weight,
    }
    .to_xdr(env, contract)
}

#[test]
fn full_lifecycle_updates_parameter_and_emits_events() {
    let t = setup();
    let proposal_id = create_fee_proposal(&t);
    let created_at = 1_700_000_000_u64;
    let voting_end = created_at + 259_200;

    let created_events = t
        .env
        .events()
        .all();
    assert_eq!(
        created_events.events().last(),
        Some(&proposal_created_event(
            &t.env,
            &t.governance.address,
            proposal_id,
            &t.proposer,
            ProposalAction::UpdateFeeRate(250),
            250,
            created_at,
            voting_end,
        )),
    );
    let proposal = t.governance.get_proposal(&proposal_id);
    assert_eq!(proposal.status, ProposalStatus::Active);
    assert_eq!(proposal.created_at, created_at);
    assert_eq!(proposal.voting_end, voting_end);

    t.governance.cast_vote(&t.proposer, &proposal_id, &true);
    let gov_events = t
        .env
        .events()
        .all();
    assert_eq!(
        gov_events.events().last(),
        Some(&vote_event(
            &t.env,
            &t.governance.address,
            proposal_id,
            &t.proposer,
            true,
            1_000
        )),
    );

    t.governance.cast_vote(&t.voter_a, &proposal_id, &true);
    let gov_events = t
        .env
        .events()
        .all();
    assert_eq!(
        gov_events.events().last(),
        Some(&vote_event(
            &t.env,
            &t.governance.address,
            proposal_id,
            &t.voter_a,
            true,
            2_000
        )),
    );

    t.governance.cast_vote(&t.voter_b, &proposal_id, &false);
    let gov_events = t
        .env
        .events()
        .all();
    assert_eq!(
        gov_events.events().last(),
        Some(&vote_event(
            &t.env,
            &t.governance.address,
            proposal_id,
            &t.voter_b,
            false,
            500
        )),
    );

    let mut ledger = t.env.ledger().get();
    ledger.timestamp = proposal.voting_end + 1;
    t.env.ledger().set(ledger);

    t.governance.execute_proposal(&proposal_id);
    let exec_events = t
        .env
        .events()
        .all();
    assert_eq!(
        exec_events.events().last(),
        Some(&proposal_executed_event(
            &t.env,
            &t.governance.address,
            proposal_id,
            ProposalAction::UpdateFeeRate(250),
            250,
            3_000,
            500,
        )),
    );

    assert_eq!(t.iln.get_fee_rate(), 250);
    let updated = t.governance.get_proposal(&proposal_id);
    assert_eq!(updated.status, ProposalStatus::Executed);
    assert_eq!(updated.votes_for, 3_000);
    assert_eq!(updated.votes_against, 500);
}

#[test]
fn quorum_not_met_rejects_proposal_without_executing_update() {
    let t = setup();
    let proposal_id = create_fee_proposal(&t);

    t.governance.cast_vote(&t.voter_b, &proposal_id, &false);

    let mut ledger = t.env.ledger().get();
    ledger.timestamp = t.governance.get_proposal(&proposal_id).voting_end + 1;
    t.env.ledger().set(ledger);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        t.governance.execute_proposal(&proposal_id);
    }));
    assert!(
        result.is_err(),
        "execution should fail when quorum is not met"
    );

    let proposal = t.governance.get_proposal(&proposal_id);
    assert_eq!(proposal.status, ProposalStatus::Active);
    assert_eq!(proposal.votes_for, 0);
    assert_eq!(proposal.votes_against, 500);
    assert_eq!(t.iln.get_fee_rate(), 0);
    assert!(t.env.events().all().events().is_empty());
}

#[test]
fn execution_before_voting_window_ends_is_rejected() {
    let t = setup();
    let proposal_id = create_fee_proposal(&t);

    t.governance.cast_vote(&t.proposer, &proposal_id, &true);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        t.governance.execute_proposal(&proposal_id);
    }));
    assert!(
        result.is_err(),
        "execution should fail before the voting window closes"
    );

    let proposal = t.governance.get_proposal(&proposal_id);
    assert_eq!(proposal.status, ProposalStatus::Active);
    assert_eq!(proposal.votes_for, 1_000);
    assert_eq!(proposal.votes_against, 0);
    assert_eq!(t.iln.get_fee_rate(), 0);
    assert!(t.env.events().all().events().is_empty());
}

#[test]
fn double_vote_is_rejected_and_does_not_change_counts() {
    let t = setup();
    let proposal_id = create_fee_proposal(&t);

    t.governance.cast_vote(&t.voter_a, &proposal_id, &true);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        t.governance.cast_vote(&t.voter_a, &proposal_id, &false);
    }));
    assert!(result.is_err(), "second vote from same address must fail");

    let proposal = t.governance.get_proposal(&proposal_id);
    assert_eq!(proposal.status, ProposalStatus::Active);
    assert_eq!(proposal.votes_for, 2_000);
    assert_eq!(proposal.votes_against, 0);
    assert!(t.governance.has_voted(&t.voter_a, &proposal_id));
    assert!(t.env.events().all().events().is_empty());
}
