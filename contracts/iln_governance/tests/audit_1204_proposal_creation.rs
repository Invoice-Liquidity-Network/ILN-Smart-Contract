//! Issue #1204 — audit of governance proposal-creation authorization:
//! proposer thresholds, snapshot ledger, quorum and duplicate proposals.
//!
//! See `docs/governance-proposal-creation-audit.md` for the verified findings
//! these tests pin.

mod common;

use common::*;
use iln_governance::{
    BalanceCheckpoint, GovContract, GovContractClient, GovernanceError, ProposalAction,
    ProposalStatus,
};
use soroban_sdk::{testutils::Address as _, Address, Env};

// ── Proposer threshold ───────────────────────────────────────────────────────

#[test]
fn proposer_below_threshold_is_rejected_and_nothing_is_stored() {
    let h = setup();
    let poor = Address::generate(&h.env);
    h.token_admin.mint(&poor, &(PROPOSER_BALANCE - 1));

    let res = h.gov.try_create_proposal(
        &poor,
        &ProposalAction::UpdateFeeRate(200),
        &hash(&h.env, 1),
        &200_i128,
    );
    assert_eq!(res, Err(Ok(GovernanceError::InsufficientProposerBalance)));
    assert!(matches!(
        h.gov.try_get_proposal(&1),
        Err(Ok(GovernanceError::ProposalNotFound))
    ));
}

#[test]
fn proposer_with_zero_balance_is_rejected() {
    let h = setup();
    let nobody = Address::generate(&h.env);
    let res = h.gov.try_create_proposal(
        &nobody,
        &ProposalAction::UpdateFeeRate(200),
        &hash(&h.env, 1),
        &200_i128,
    );
    assert_eq!(res, Err(Ok(GovernanceError::InsufficientProposerBalance)));
}

#[test]
fn proposer_exactly_at_threshold_is_accepted() {
    let h = setup();
    assert_eq!(h.token.balance(&h.proposer), PROPOSER_BALANCE);
    let id = new_proposal(&h);
    assert_eq!(id, 1);
    assert_eq!(h.gov.get_proposal(&id).status, ProposalStatus::Active);
}

/// The gate reads the *live* balance, not a checkpoint: moving funds away
/// after checkpointing drops the proposer below the gate.
#[test]
fn threshold_is_checked_against_live_balance() {
    let h = setup();
    let other = Address::generate(&h.env);
    h.token.transfer(&h.proposer, &other, &600);

    let res = h.gov.try_create_proposal(
        &h.proposer,
        &ProposalAction::UpdateFeeRate(200),
        &hash(&h.env, 1),
        &200_i128,
    );
    assert_eq!(res, Err(Ok(GovernanceError::InsufficientProposerBalance)));
}

#[test]
fn proposer_must_authorize_creation() {
    let h = setup();
    h.env.set_auths(&[]);
    let res = h.gov.try_create_proposal(
        &h.proposer,
        &ProposalAction::UpdateFeeRate(200),
        &hash(&h.env, 1),
        &200_i128,
    );
    assert!(res.is_err(), "creation without proposer auth must fail");
}

#[test]
fn creation_before_initialize_fails_closed() {
    let env = Env::default();
    env.mock_all_auths();
    let gov = GovContractClient::new(&env, &env.register_contract(None, GovContract));
    let who = Address::generate(&env);
    let res = gov.try_create_proposal(
        &who,
        &ProposalAction::UpdateFeeRate(200),
        &hash(&env, 1),
        &200_i128,
    );
    assert_eq!(res, Err(Ok(GovernanceError::NotInitialized)));
}

// ── Threshold configuration (finding: non-positive gate) ─────────────────────

#[test]
fn set_min_proposal_balance_rejects_non_positive_values() {
    let h = setup();
    assert_eq!(
        h.gov.try_set_min_proposal_balance(&0),
        Err(Ok(GovernanceError::InvalidMinProposalBalance))
    );
    assert_eq!(
        h.gov.try_set_min_proposal_balance(&-1),
        Err(Ok(GovernanceError::InvalidMinProposalBalance))
    );
    // Rejected writes leave the gate untouched.
    assert_eq!(h.gov.get_min_proposal_balance(), PROPOSER_BALANCE);

    h.gov.set_min_proposal_balance(&1);
    assert_eq!(h.gov.get_min_proposal_balance(), 1);
}

// ── Snapshot ledger and proposer binding ─────────────────────────────────────

#[test]
fn creation_records_snapshot_ledger_proposer_and_seed_checkpoint() {
    let h = setup();
    // A proposer with no prior checkpoint.
    let fresh = Address::generate(&h.env);
    h.token_admin.mint(&fresh, &PROPOSER_BALANCE);
    assert!(h.gov.get_voter_checkpoint(&fresh).is_none());

    let seq = h.env.ledger().sequence();
    let id = h.gov.create_proposal(
        &fresh,
        &ProposalAction::UpdateFeeRate(200),
        &hash(&h.env, 1),
        &200_i128,
    );

    assert_eq!(h.gov.get_proposal_created_ledger(&id), Some(seq));
    assert_eq!(h.gov.get_proposal_proposer(&id), Some(fresh.clone()));
    assert_eq!(
        h.gov.get_voter_checkpoint(&fresh),
        Some(BalanceCheckpoint {
            balance: PROPOSER_BALANCE,
            ledger: seq
        })
    );
}

/// An older, longer-aged checkpoint must not be overwritten by creation.
#[test]
fn creation_preserves_existing_proposer_checkpoint() {
    let h = setup();
    let before = h.gov.get_voter_checkpoint(&h.proposer).unwrap();
    new_proposal(&h);
    assert_eq!(h.gov.get_voter_checkpoint(&h.proposer), Some(before));
}

#[test]
fn voting_window_and_initial_tallies_are_fixed_at_creation() {
    let h = setup();
    let id = new_proposal(&h);
    let p = h.gov.get_proposal(&id);
    assert_eq!(p.created_at, START_TIMESTAMP);
    assert_eq!(p.voting_end, START_TIMESTAMP + VOTING_PERIOD_SECS);
    assert_eq!(p.votes_for, 0);
    assert_eq!(p.votes_against, 0);
    assert_eq!(p.eta_ledger, 0);
}

// ── Duplicate proposals ──────────────────────────────────────────────────────

/// There is no de-duplication: identical (proposer, action, hash, value)
/// tuples yield independent proposals with distinct, sequential ids.
#[test]
fn identical_proposals_are_independent_and_sequential() {
    let h = setup();
    let a = new_proposal(&h);
    let b = new_proposal(&h);
    assert_eq!((a, b), (1, 2));

    let pa = h.gov.get_proposal(&a);
    let pb = h.gov.get_proposal(&b);
    assert_eq!(pa.description_hash, pb.description_hash);
    assert_eq!(pa.action_type, pb.action_type);
    assert_eq!(pa.status, ProposalStatus::Active);
    assert_eq!(pb.status, ProposalStatus::Active);
    assert_eq!(h.gov.list_proposals(&None, &None, &10).len(), 2);
}

/// With a deposit configured every duplicate escrows its own deposit, which is
/// the only cost-based brake on proposal spam.
#[test]
fn each_duplicate_escrows_its_own_deposit() {
    let h = setup();
    h.gov.set_min_proposal_balance(&100);
    h.gov.set_min_proposal_deposit(&300);

    let a = new_proposal(&h);
    let b = new_proposal(&h);
    assert_eq!(h.gov.get_proposal_deposit(&a), 300);
    assert_eq!(h.gov.get_proposal_deposit(&b), 300);
    assert_eq!(h.token.balance(&h.proposer), PROPOSER_BALANCE - 600);
    assert_eq!(h.token.balance(&h.gov.address), 600);
}

#[test]
fn deposit_larger_than_balance_is_rejected_atomically() {
    let h = setup();
    h.gov.set_min_proposal_deposit(&(PROPOSER_BALANCE + 500));

    let res = h.gov.try_create_proposal(
        &h.proposer,
        &ProposalAction::UpdateFeeRate(200),
        &hash(&h.env, 1),
        &200_i128,
    );
    assert_eq!(res, Err(Ok(GovernanceError::InsufficientProposerBalance)));
    assert_eq!(h.token.balance(&h.proposer), PROPOSER_BALANCE);
    assert!(matches!(
        h.gov.try_get_proposal(&1),
        Err(Ok(GovernanceError::ProposalNotFound))
    ));
}

#[test]
fn deposit_cannot_be_negative() {
    let h = setup();
    assert_eq!(
        h.gov.try_set_min_proposal_deposit(&-1),
        Err(Ok(GovernanceError::InvalidProposalDeposit))
    );
}

// ── Quorum ───────────────────────────────────────────────────────────────────

/// Quorum is *not* evaluated (or snapshotted) at creation: it is computed at
/// execution from the then-current stored supply and quorum bps. A supply
/// change after creation therefore changes the outcome of an in-flight
/// proposal.
#[test]
fn quorum_is_read_at_execution_not_at_creation() {
    let h = setup();
    let id = new_proposal(&h);
    h.gov.cast_vote(&h.proposer, &id, &true);

    // At creation time the 1_000 votes would meet a 10% quorum of 10_000.
    // Raising the tracked supply raises the quorum to 10_000.
    h.gov.set_gov_token_total_supply(&100_000);

    advance_past_voting(&h.env);
    h.gov.execute_proposal(&id);

    // Issue #1007: the miss is committed as `Rejected` (not rolled back).
    assert_eq!(h.gov.get_proposal(&id).status, ProposalStatus::Rejected);
}

#[test]
fn quorum_met_at_exact_boundary_passes() {
    let h = setup();
    // quorum = 10_000 * 1_000 bps / 10_000 = 1_000; proposer weight = 1_000.
    let id = new_proposal(&h);
    h.gov.cast_vote(&h.proposer, &id, &true);
    advance_past_voting(&h.env);
    h.gov.execute_proposal(&id);
    assert_eq!(h.gov.get_proposal(&id).status, ProposalStatus::Passed);
}
