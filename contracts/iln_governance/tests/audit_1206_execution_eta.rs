//! Issue #1206 — audit of governance execution ETA and replay protection:
//! delayed execution, current-ledger rejection, replay, veto and stale
//! proposal execution.
//!
//! See `docs/governance-execution-eta-audit.md`. `residual_risk_*` tests pin
//! verified limitations that are documented rather than changed here.

mod common;

use common::*;
use iln_governance::{GovernanceError, ProposalStatus};
use soroban_sdk::{
    testutils::{Address as _, Events},
    vec, Address,
};

// ── Queueing: Active -> Passed ───────────────────────────────────────────────

#[test]
fn execute_during_voting_window_is_rejected() {
    let h = setup();
    let id = new_proposal(&h);
    h.gov.cast_vote(&h.proposer, &id, &true);

    assert_eq!(
        h.gov.try_execute_proposal(&id),
        Err(Ok(GovernanceError::VotingOngoing))
    );
    assert_eq!(h.gov.get_proposal(&id).status, ProposalStatus::Active);
}

#[test]
fn queueing_stamps_eta_and_does_not_execute() {
    let h = setup();
    h.gov.set_execution_delay(&h.admin, &10);
    let id = queue_proposal(&h);
    let queued_at = h.env.ledger().sequence();

    let p = h.gov.get_proposal(&id);
    assert_eq!(p.status, ProposalStatus::Passed);
    assert_eq!(p.eta_ledger, queued_at + 10);
    assert_eq!(h.gov.get_proposal_eta(&id), queued_at + 10);
    assert!(!h.gov.is_proposal_executed(&id));
    assert_eq!(h.gov.get_execution_nonce(), 0);
}

/// The delay in force at creation is a floor: lowering the delay while the
/// proposal is still being voted on cannot shorten its timelock.
#[test]
fn creation_time_delay_is_a_floor_for_the_queued_eta() {
    let h = setup();
    h.gov.set_execution_delay(&h.admin, &100);
    let id = new_proposal(&h);
    h.gov.set_execution_delay(&h.admin, &0);

    h.gov.cast_vote(&h.proposer, &id, &true);
    advance_past_voting(&h.env);
    h.gov.execute_proposal(&id);

    let queued_at = h.env.ledger().sequence();
    let policy = h.gov.get_proposal_timelock_policy(&id).unwrap();
    assert!(policy.queued);
    assert_eq!(policy.applied_delay, 100);
    assert_eq!(h.gov.get_proposal(&id).eta_ledger, queued_at + 100);
}

// ── Current-ledger rejection ─────────────────────────────────────────────────

#[test]
fn execution_before_eta_is_rejected_and_at_eta_is_accepted() {
    let h = setup();
    h.gov.set_execution_delay(&h.admin, &10);
    let id = queue_proposal(&h);

    // Same ledger as queueing.
    assert_eq!(
        h.gov.try_execute_proposal(&id),
        Err(Ok(GovernanceError::TimelockNotExpired))
    );
    // eta - 1.
    advance_ledgers(&h.env, 9);
    assert_eq!(
        h.gov.try_execute_proposal(&id),
        Err(Ok(GovernanceError::TimelockNotExpired))
    );
    // eta.
    advance_ledgers(&h.env, 1);
    h.gov.execute_proposal(&id);

    assert_eq!(h.gov.get_proposal(&id).status, ProposalStatus::Executed);
    assert!(h.gov.is_proposal_executed(&id));
    assert_eq!(h.gov.get_execution_nonce(), 1);
}

#[test]
fn zero_delay_proposal_executes_on_the_next_call() {
    let h = setup();
    let id = queue_proposal(&h);
    h.gov.execute_proposal(&id);
    assert_eq!(h.gov.get_proposal(&id).status, ProposalStatus::Executed);
}

/// Raising the delay after queueing re-applies the larger delay from the
/// queue ledger; the stored `eta_ledger` is left as recorded.
#[test]
fn raising_delay_after_queue_extends_the_effective_eta() {
    let h = setup();
    h.gov.set_execution_delay(&h.admin, &10);
    let id = queue_proposal(&h);
    let stored_eta = h.gov.get_proposal(&id).eta_ledger;
    h.gov.set_execution_delay(&h.admin, &50);

    advance_ledgers(&h.env, 49);
    assert_eq!(
        h.gov.try_execute_proposal(&id),
        Err(Ok(GovernanceError::TimelockNotExpired))
    );
    advance_ledgers(&h.env, 1);
    h.gov.execute_proposal(&id);

    assert_eq!(h.gov.get_proposal(&id).status, ProposalStatus::Executed);
    assert_eq!(h.gov.get_proposal(&id).eta_ledger, stored_eta);
}

/// A delay reduction is refused while a scheduled eta is still in the future,
/// so it cannot be used to overtake a queued proposal.
#[test]
fn delay_reduction_is_blocked_while_a_proposal_is_scheduled() {
    let h = setup();
    h.gov.set_execution_delay(&h.admin, &100);
    queue_proposal(&h);

    assert_eq!(
        h.gov.try_set_execution_delay(&h.admin, &0),
        Err(Ok(GovernanceError::DelayReductionBypassesScheduled))
    );
    assert_eq!(h.gov.get_execution_delay(), 100);
}

#[test]
fn execution_delay_is_bounded() {
    let h = setup();
    h.gov
        .set_execution_delay(&h.admin, &iln_governance::MAX_EXECUTION_DELAY_LEDGERS);
    assert_eq!(
        h.gov.try_set_execution_delay(
            &h.admin,
            &(iln_governance::MAX_EXECUTION_DELAY_LEDGERS + 1)
        ),
        Err(Ok(GovernanceError::InvalidExecutionDelay))
    );
}

// ── Replay protection ────────────────────────────────────────────────────────

#[test]
fn executed_proposal_cannot_be_replayed() {
    let h = setup();
    let id = queue_proposal(&h);
    h.gov.execute_proposal(&id);
    assert_eq!(h.gov.get_execution_nonce(), 1);

    for _ in 0..3 {
        assert_eq!(
            h.gov.try_execute_proposal(&id),
            Err(Ok(GovernanceError::ProposalAlreadyExecuted))
        );
    }
    assert_eq!(h.gov.get_execution_nonce(), 1, "replay must not bump nonce");
    assert!(h.gov.is_proposal_executed(&id));
}

#[test]
fn nonce_counts_each_executed_proposal_once() {
    let h = setup();
    let a = queue_proposal(&h);
    let b = queue_proposal(&h);
    h.gov.execute_proposal(&a);
    assert_eq!(h.gov.get_execution_nonce(), 1);
    h.gov.execute_proposal(&b);
    assert_eq!(h.gov.get_execution_nonce(), 2);
    assert!(h.gov.is_proposal_executed(&a) && h.gov.is_proposal_executed(&b));
}

#[test]
fn unknown_proposal_cannot_be_executed() {
    let h = setup();
    assert_eq!(
        h.gov.try_execute_proposal(&42),
        Err(Ok(GovernanceError::ProposalNotFound))
    );
}

// ── Veto ─────────────────────────────────────────────────────────────────────

#[test]
fn vetoed_queued_proposal_stays_dead_after_eta() {
    let h = setup();
    h.gov.set_execution_delay(&h.admin, &10);
    let signer = Address::generate(&h.env);
    h.gov
        .configure_veto_multisig(&vec![&h.env, signer.clone()], &1);

    let id = queue_proposal(&h);
    h.gov.veto_proposal(&signer, &id, &hash(&h.env, 0xAB));
    assert_eq!(h.gov.get_proposal(&id).status, ProposalStatus::Vetoed);

    advance_ledgers(&h.env, 1_000);
    assert_eq!(
        h.gov.try_execute_proposal(&id),
        Err(Ok(GovernanceError::ProposalCancelled))
    );
    assert!(!h.gov.is_proposal_executed(&id));
    assert_eq!(h.gov.get_execution_nonce(), 0);
}

// ── Pause ────────────────────────────────────────────────────────────────────

/// Pause blocks both the queue and the execute steps; unpausing does not skip
/// the timelock.
#[test]
fn pause_blocks_execution_without_shortening_the_timelock() {
    let h = setup();
    h.gov.set_execution_delay(&h.admin, &10);
    let id = queue_proposal(&h);

    h.gov.pause(&h.admin);
    assert!(h.gov.is_paused());
    advance_ledgers(&h.env, 10);
    assert_eq!(
        h.gov.try_execute_proposal(&id),
        Err(Ok(GovernanceError::ContractPaused))
    );

    h.gov.unpause(&h.admin);
    h.gov.execute_proposal(&id);
    assert_eq!(h.gov.get_proposal(&id).status, ProposalStatus::Executed);
}

#[test]
fn only_the_stored_admin_can_pause() {
    let h = setup();
    let stranger = Address::generate(&h.env);
    assert_eq!(
        h.gov.try_pause(&stranger),
        Err(Ok(GovernanceError::Unauthorized))
    );
    assert!(!h.gov.is_paused());
}

// ── Failed execution is retryable ────────────────────────────────────────────

#[test]
fn failed_cross_contract_call_leaves_proposal_passed_and_retryable() {
    let h = setup_failing_iln();
    let id = queue_proposal(&h);

    h.gov.execute_proposal(&id); // returns Ok so the failure event commits
    let failed_event_seen = h
        .env
        .events()
        .all()
        .events()
        .iter()
        .any(|e| std::format!("{:?}", e).contains("proposal_execution_failed"));
    assert!(failed_event_seen, "proposal_execution_failed must be emitted");

    assert_eq!(h.gov.get_proposal(&id).status, ProposalStatus::Passed);
    assert!(!h.gov.is_proposal_executed(&id));
    assert_eq!(h.gov.get_execution_nonce(), 0);

    // Retry is allowed and keeps the original eta.
    let eta = h.gov.get_proposal(&id).eta_ledger;
    h.gov.execute_proposal(&id);
    assert_eq!(h.gov.get_proposal(&id).status, ProposalStatus::Passed);
    assert_eq!(h.gov.get_proposal(&id).eta_ledger, eta);
}

// ── Rejection is committed (Issue #1007) ─────────────────────────────────────

#[test]
fn quorum_miss_commits_rejected_and_is_terminal() {
    let h = setup();
    let id = new_proposal(&h); // no votes: below quorum
    advance_past_voting(&h.env);

    h.gov.execute_proposal(&id);
    assert_eq!(h.gov.get_proposal(&id).status, ProposalStatus::Rejected);
    assert_eq!(h.gov.get_proposal(&id).eta_ledger, 0);

    assert_eq!(
        h.gov.try_execute_proposal(&id),
        Err(Ok(GovernanceError::AlreadyResolved))
    );
    assert!(!h.gov.is_proposal_executed(&id));
}

#[test]
fn majority_against_commits_rejected() {
    let h = setup();
    let id = new_proposal(&h);
    h.gov.cast_vote(&h.proposer, &id, &false);
    advance_past_voting(&h.env);

    h.gov.execute_proposal(&id);
    assert_eq!(h.gov.get_proposal(&id).status, ProposalStatus::Rejected);
}

// ── Verified residual risk ───────────────────────────────────────────────────

/// RESIDUAL RISK: a `Passed` proposal has an earliest-execution ledger but no
/// latest-execution ledger. Anyone may execute it arbitrarily long after its
/// eta, by which time the parameters it carries may be stale. Once the veto is
/// retired there is no on-chain way to cancel it. Mitigation (an expiry /
/// grace period) is an API change and out of scope for this audit PR.
#[test]
fn residual_risk_passed_proposal_has_no_expiry() {
    let h = setup();
    h.gov.set_execution_delay(&h.admin, &10);
    let id = queue_proposal(&h);
    let eta = h.gov.get_proposal(&id).eta_ledger;

    advance_ledgers(&h.env, 1_000);
    assert!(h.env.ledger().sequence() > eta + 900);

    h.gov.execute_proposal(&id);
    assert_eq!(h.gov.get_proposal(&id).status, ProposalStatus::Executed);
}
