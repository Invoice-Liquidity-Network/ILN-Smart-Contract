//! Issue #1205 — audit of governance vote snapshot behaviour: voter balances
//! must come from proposal-ledger-bound checkpoints and flash-loan balances
//! must not influence votes.
//!
//! See `docs/governance-vote-snapshot-audit.md`. The two `residual_risk_*`
//! tests pin *verified limitations* of the checkpoint design; if a mitigation
//! lands they are expected to be flipped, not deleted.

mod common;

use common::*;
use iln_governance::GovernanceError;
use soroban_sdk::{testutils::Address as _, Address};

// ── Flash-funded balances ────────────────────────────────────────────────────

/// A balance acquired right before voting (no checkpoint) carries no weight.
#[test]
fn flash_funded_voter_without_checkpoint_cannot_vote() {
    let h = setup();
    let id = new_proposal(&h);

    let attacker = Address::generate(&h.env);
    h.token_admin.mint(&attacker, &1_000_000);

    assert_eq!(
        h.gov.try_cast_vote(&attacker, &id, &true),
        Err(Ok(GovernanceError::InsufficientHoldingPeriod))
    );
    assert_eq!(h.gov.get_proposal(&id).votes_for, 0);
}

/// A checkpoint recorded *after* the proposal was created is measured against
/// the proposal's creation ledger, so even a fully aged late checkpoint is
/// ineligible for that proposal.
#[test]
fn checkpoint_recorded_after_creation_is_ineligible() {
    let h = setup();
    let id = new_proposal(&h);

    let late = Address::generate(&h.env);
    h.token_admin.mint(&late, &1_000);
    h.gov.checkpoint_balance(&late);
    advance_ledgers(&h.env, 100);

    assert_eq!(h.gov.get_eligible_checkpoint(&late, &id), None);
    assert_eq!(
        h.gov.try_cast_vote(&late, &id, &true),
        Err(Ok(GovernanceError::InsufficientHoldingPeriod))
    );
}

/// `checkpoint.ledger + 10 <= proposal_created_ledger` is the exact rule: a
/// checkpoint nine ledgers before creation fails, ten ledgers before passes.
#[test]
fn holding_period_boundary_is_exact() {
    let h = setup();
    let voter = Address::generate(&h.env);
    h.token_admin.mint(&voter, &1_000);
    h.gov.checkpoint_balance(&voter);

    advance_ledgers(&h.env, HOLD_LEDGERS - 1);
    let too_early = new_proposal(&h);
    assert_eq!(
        h.gov.try_cast_vote(&voter, &too_early, &true),
        Err(Ok(GovernanceError::InsufficientHoldingPeriod))
    );

    advance_ledgers(&h.env, 1);
    let on_time = new_proposal(&h);
    h.gov.cast_vote(&voter, &on_time, &true);
    assert_eq!(h.gov.get_applied_vote_weight(&on_time, &voter), Some(1_000));
}

// ── Weight = min(checkpoint, current) ────────────────────────────────────────

#[test]
fn weight_is_capped_by_checkpoint_when_balance_grows_after_checkpoint() {
    let h = setup();
    let voter = aged_voter(&h, 1_000);
    h.token_admin.mint(&voter, &4_000); // flash-style top-up: balance 5_000
    let id = new_proposal(&h);

    h.gov.cast_vote(&voter, &id, &true);
    assert_eq!(h.gov.get_applied_vote_weight(&id, &voter), Some(1_000));
    assert_eq!(h.gov.get_proposal(&id).votes_for, 1_000);
}

#[test]
fn weight_is_capped_by_current_balance_when_balance_shrinks() {
    let h = setup();
    let voter = aged_voter(&h, 1_000);
    let sink = Address::generate(&h.env);
    h.token.transfer(&voter, &sink, &600); // current 400, checkpoint 1_000
    let id = new_proposal(&h);

    h.gov.cast_vote(&voter, &id, &false);
    assert_eq!(h.gov.get_applied_vote_weight(&id, &voter), Some(400));
    assert_eq!(h.gov.get_proposal(&id).votes_against, 400);
}

/// Refreshing a checkpoint after creation demotes the old one to the prior
/// slot instead of destroying it, and the inflated new checkpoint is not
/// eligible for the older proposal.
#[test]
fn refreshing_checkpoint_after_creation_cannot_inflate_weight() {
    let h = setup();
    let voter = aged_voter(&h, 1_000);
    let id = new_proposal(&h);

    advance_ledgers(&h.env, 1);
    h.token_admin.mint(&voter, &9_000);
    h.gov.checkpoint_balance(&voter); // latest = 10_000 at a post-creation ledger

    let eligible = h.gov.get_eligible_checkpoint(&voter, &id).unwrap();
    assert_eq!(eligible.balance, 1_000);

    h.gov.cast_vote(&voter, &id, &true);
    assert_eq!(h.gov.get_applied_vote_weight(&id, &voter), Some(1_000));
}

// ── Proposer snapshot ────────────────────────────────────────────────────────

/// The proposer's weight is the creation-time balance, regardless of later
/// top-ups or transfers.
#[test]
fn proposer_weight_is_creation_snapshot_not_later_balance() {
    let h = setup();
    let id = new_proposal(&h);

    h.token_admin.mint(&h.proposer, &50_000); // later top-up
    h.gov.cast_vote(&h.proposer, &id, &true);
    assert_eq!(
        h.gov.get_applied_vote_weight(&id, &h.proposer),
        Some(PROPOSER_BALANCE)
    );
}

#[test]
fn proposer_snapshot_survives_moving_funds_away_after_creation() {
    let h = setup();
    let id = new_proposal(&h);

    let sink = Address::generate(&h.env);
    h.token.transfer(&h.proposer, &sink, &PROPOSER_BALANCE);
    assert_eq!(h.token.balance(&h.proposer), 0);

    h.gov.cast_vote(&h.proposer, &id, &true);
    assert_eq!(
        h.gov.get_applied_vote_weight(&id, &h.proposer),
        Some(PROPOSER_BALANCE)
    );
}

// ── Vote receipts ────────────────────────────────────────────────────────────

#[test]
fn applied_weight_is_locked_and_second_vote_rejected() {
    let h = setup();
    let voter = aged_voter(&h, 1_000);
    let id = new_proposal(&h);

    h.gov.cast_vote(&voter, &id, &true);
    let sink = Address::generate(&h.env);
    h.token.transfer(&voter, &sink, &1_000);

    assert_eq!(h.gov.get_applied_vote_weight(&id, &voter), Some(1_000));
    assert!(h.gov.has_voted(&voter, &id));
    assert_eq!(
        h.gov.try_cast_vote(&voter, &id, &false),
        Err(Ok(GovernanceError::AlreadyVoted))
    );
    assert_eq!(h.gov.get_proposal(&id).votes_for, 1_000);
    assert_eq!(h.gov.get_proposal(&id).votes_against, 0);
}

#[test]
fn zero_balance_checkpointed_voter_has_no_voting_power() {
    let h = setup();
    let voter = Address::generate(&h.env);
    h.gov.checkpoint_balance(&voter); // balance 0
    advance_ledgers(&h.env, HOLD_LEDGERS + 1);
    let id = new_proposal(&h);

    assert_eq!(
        h.gov.try_cast_vote(&voter, &id, &true),
        Err(Ok(GovernanceError::NoVotingPower))
    );
}

#[test]
fn vote_after_voting_window_is_rejected() {
    let h = setup();
    let voter = aged_voter(&h, 1_000);
    let id = new_proposal(&h);
    advance_past_voting(&h.env);

    assert_eq!(
        h.gov.try_cast_vote(&voter, &id, &true),
        Err(Ok(GovernanceError::VotingEnded))
    );
}

#[test]
fn vote_on_unknown_proposal_is_rejected() {
    let h = setup();
    let voter = aged_voter(&h, 1_000);
    assert_eq!(
        h.gov.try_cast_vote(&voter, &99, &true),
        Err(Ok(GovernanceError::ProposalNotFound))
    );
}

// ── Verified residual risks (documented, not fixed here) ─────────────────────

/// RESIDUAL RISK: delegated weight is read live from `DelegatedToMe` at vote
/// time; it is not bound to the proposal's snapshot ledger. A delegation made
/// *after* a proposal was created still counts toward votes on it.
#[test]
fn residual_risk_delegation_after_creation_counts_toward_vote() {
    let h = setup();
    let delegator = aged_voter(&h, 1_000);
    let delegate = aged_voter(&h, 500);
    let id = new_proposal(&h);

    h.gov.delegate_votes(&delegator, &delegate);
    h.gov.cast_vote(&delegate, &id, &true);

    assert_eq!(h.gov.get_applied_vote_weight(&id, &delegate), Some(1_500));
}

/// RESIDUAL RISK: Soroban tokens expose no "balance at ledger N" query, so
/// weight is `min(checkpoint, balance at vote time)`. Two addresses that both
/// hold an aged checkpoint of the *same* tokens (A checkpoints, sends to B, B
/// checkpoints) can vote with those tokens in turn: B votes, returns the
/// tokens to A, A votes. Mitigation requires token-side snapshots or vote
/// locks and is out of scope for this audit PR.
#[test]
fn residual_risk_recycling_tokens_between_two_aged_checkpoints_double_counts() {
    let h = setup();
    let a = Address::generate(&h.env);
    let b = Address::generate(&h.env);
    h.token_admin.mint(&a, &1_000);

    h.gov.checkpoint_balance(&a);
    h.token.transfer(&a, &b, &1_000);
    advance_ledgers(&h.env, 1);
    h.gov.checkpoint_balance(&b);
    advance_ledgers(&h.env, HOLD_LEDGERS + 1);

    let id = new_proposal(&h);

    h.gov.cast_vote(&b, &id, &true);
    h.token.transfer(&b, &a, &1_000);
    h.gov.cast_vote(&a, &id, &true);

    // 1_000 tokens produced 2_000 votes.
    assert_eq!(h.gov.get_proposal(&id).votes_for, 2_000);
    assert_eq!(h.token.balance(&a) + h.token.balance(&b), 1_000);
}
