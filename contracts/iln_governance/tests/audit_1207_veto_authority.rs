//! Issue #1207 — audit of governance veto authority and permanent
//! disablement: veto authorization, reason hash, permanent disablement and
//! the timelock policy after disablement.
//!
//! See `docs/governance-veto-audit.md`.

mod common;

use common::*;
use iln_governance::{
    GovContract, GovContractClient, GovernanceError, ProposalStatus, StorageKey, VetoStatus,
    MIN_ACTIVE_TIMELOCK_LEDGERS,
};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    vec, Address, BytesN, Env,
};

fn zero_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0u8; 32])
}

/// Configures a `threshold`-of-`n` veto multisig and returns the signers.
fn configure_multisig(h: &Harness, n: u32, threshold: u32) -> soroban_sdk::Vec<Address> {
    let mut signers = vec![&h.env];
    for _ in 0..n {
        signers.push_back(Address::generate(&h.env));
    }
    h.gov.configure_veto_multisig(&signers, &threshold);
    signers
}

// ── Multisig configuration ───────────────────────────────────────────────────

#[test]
fn invalid_multisig_configurations_are_rejected() {
    let h = setup();
    let a = Address::generate(&h.env);
    let b = Address::generate(&h.env);

    let empty = vec![&h.env];
    assert_eq!(
        h.gov.try_configure_veto_multisig(&empty, &1),
        Err(Ok(GovernanceError::InvalidVetoMultisigConfig))
    );
    assert_eq!(
        h.gov
            .try_configure_veto_multisig(&vec![&h.env, a.clone()], &0),
        Err(Ok(GovernanceError::InvalidVetoMultisigConfig))
    );
    assert_eq!(
        h.gov
            .try_configure_veto_multisig(&vec![&h.env, a.clone(), b.clone()], &3),
        Err(Ok(GovernanceError::InvalidVetoMultisigConfig))
    );
    assert_eq!(
        h.gov
            .try_configure_veto_multisig(&vec![&h.env, a.clone(), a.clone()], &1),
        Err(Ok(GovernanceError::InvalidVetoMultisigConfig))
    );
    assert_eq!(h.gov.get_veto_signers().len(), 0);
}

// ── Veto authorization ───────────────────────────────────────────────────────

#[test]
fn veto_before_multisig_is_configured_is_rejected() {
    let h = setup();
    let id = new_proposal(&h);
    assert_eq!(
        h.gov.try_veto_proposal(&h.admin, &id, &hash(&h.env, 0xAB)),
        Err(Ok(GovernanceError::VetoMultisigNotConfigured))
    );
}

#[test]
fn non_signer_cannot_veto() {
    let h = setup();
    configure_multisig(&h, 2, 1);
    let id = new_proposal(&h);
    let outsider = Address::generate(&h.env);

    assert_eq!(
        h.gov.try_veto_proposal(&outsider, &id, &hash(&h.env, 0xAB)),
        Err(Ok(GovernanceError::NotVetoSigner))
    );
    // The stored admin is not implicitly a signer.
    assert_eq!(
        h.gov.try_veto_proposal(&h.admin, &id, &hash(&h.env, 0xAB)),
        Err(Ok(GovernanceError::NotVetoSigner))
    );
    assert_eq!(h.gov.get_proposal(&id).status, ProposalStatus::Active);
}

#[test]
fn signer_must_authorize_the_veto_call() {
    let h = setup();
    let signers = configure_multisig(&h, 1, 1);
    let id = new_proposal(&h);

    h.env.set_auths(&[]);
    let res = h
        .gov
        .try_veto_proposal(&signers.get(0).unwrap(), &id, &hash(&h.env, 0xAB));
    assert!(res.is_err(), "veto without signer auth must fail");
}

#[test]
fn veto_of_unknown_proposal_is_rejected() {
    let h = setup();
    let signers = configure_multisig(&h, 1, 1);
    assert_eq!(
        h.gov
            .try_veto_proposal(&signers.get(0).unwrap(), &7, &hash(&h.env, 0xAB)),
        Err(Ok(GovernanceError::ProposalNotFound))
    );
}

// ── Reason hash / consent ────────────────────────────────────────────────────

#[test]
fn zero_reason_hash_is_rejected_for_veto() {
    let h = setup();
    let signers = configure_multisig(&h, 1, 1);
    let id = new_proposal(&h);
    assert_eq!(
        h.gov
            .try_veto_proposal(&signers.get(0).unwrap(), &id, &zero_hash(&h.env)),
        Err(Ok(GovernanceError::ConsentRequired))
    );
    assert_eq!(h.gov.get_proposal(&id).status, ProposalStatus::Active);
}

#[test]
fn two_of_three_veto_needs_distinct_signers_and_one_shared_reason() {
    let h = setup();
    let signers = configure_multisig(&h, 3, 2);
    let (s1, s2) = (signers.get(0).unwrap(), signers.get(1).unwrap());
    let id = new_proposal(&h);
    let reason_a = hash(&h.env, 0xAA);
    let reason_b = hash(&h.env, 0xBB);

    // First approval: pending, proposal untouched.
    h.gov.veto_proposal(&s1, &id, &reason_a);
    assert_eq!(h.gov.get_proposal(&id).status, ProposalStatus::Active);
    let state = h.gov.get_veto_state(&id);
    assert_eq!(state.status, VetoStatus::Pending);
    assert_eq!(state.approvals_count, 1);
    assert_eq!(state.threshold, 2);
    assert_eq!(h.gov.get_veto_reason_hash(&id), Some(reason_a.clone()));

    // The same signer cannot approve twice.
    assert_eq!(
        h.gov.try_veto_proposal(&s1, &id, &reason_a),
        Err(Ok(GovernanceError::VetoAlreadyApproved))
    );
    // A second signer must consent to the same reason.
    assert_eq!(
        h.gov.try_veto_proposal(&s2, &id, &reason_b),
        Err(Ok(GovernanceError::VetoReasonMismatch))
    );
    assert_eq!(h.gov.get_proposal(&id).status, ProposalStatus::Active);

    // Matching reason reaches the threshold and executes the veto.
    h.gov.veto_proposal(&s2, &id, &reason_a);
    assert_eq!(h.gov.get_proposal(&id).status, ProposalStatus::Vetoed);
    assert_eq!(h.gov.get_veto_state(&id).status, VetoStatus::Executed);
    assert_eq!(h.gov.get_veto_approvals(&id).len(), 0);
    assert_eq!(h.gov.get_veto_reason_hash(&id), None);

    // Terminal: a further veto attempt is refused.
    assert_eq!(
        h.gov
            .try_veto_proposal(&signers.get(2).unwrap(), &id, &reason_a),
        Err(Ok(GovernanceError::NotVetoable))
    );
}

/// The pending reason must not be resettable by archival of the temporary
/// `VetoReasonHash` entry: the pending `VetoState` keeps the consented reason.
#[test]
fn pending_reason_survives_loss_of_the_temporary_reason_entry() {
    let h = setup();
    let signers = configure_multisig(&h, 2, 2);
    let (s1, s2) = (signers.get(0).unwrap(), signers.get(1).unwrap());
    let id = new_proposal(&h);
    let reason_a = hash(&h.env, 0xAA);
    let reason_b = hash(&h.env, 0xBB);

    h.gov.veto_proposal(&s1, &id, &reason_a);

    // Simulate archival / expiry of the temporary consent entry.
    h.env.as_contract(&h.gov.address, || {
        h.env
            .storage()
            .temporary()
            .remove(&StorageKey::VetoReasonHash(id));
    });
    assert_eq!(h.gov.get_veto_reason_hash(&id), None);

    assert_eq!(
        h.gov.try_veto_proposal(&s2, &id, &reason_b),
        Err(Ok(GovernanceError::VetoReasonMismatch))
    );
    h.gov.veto_proposal(&s2, &id, &reason_a);
    assert_eq!(h.gov.get_proposal(&id).status, ProposalStatus::Vetoed);
}

// ── Vetoable states ──────────────────────────────────────────────────────────

#[test]
fn passed_proposal_is_vetoable_but_executed_is_not() {
    let h = setup();
    let signers = configure_multisig(&h, 1, 1);
    let s = signers.get(0).unwrap();

    let queued = queue_proposal(&h);
    h.gov.veto_proposal(&s, &queued, &hash(&h.env, 0xAB));
    assert_eq!(h.gov.get_proposal(&queued).status, ProposalStatus::Vetoed);

    let executed = queue_proposal(&h);
    h.gov.execute_proposal(&executed);
    assert_eq!(
        h.gov.try_veto_proposal(&s, &executed, &hash(&h.env, 0xAB)),
        Err(Ok(GovernanceError::NotVetoable))
    );
}

#[test]
fn rejected_proposal_is_not_vetoable() {
    let h = setup();
    let signers = configure_multisig(&h, 1, 1);
    let id = new_proposal(&h);
    advance_past_voting(&h.env);
    h.gov.execute_proposal(&id); // no votes -> Rejected
    assert_eq!(h.gov.get_proposal(&id).status, ProposalStatus::Rejected);

    assert_eq!(
        h.gov
            .try_veto_proposal(&signers.get(0).unwrap(), &id, &hash(&h.env, 0xAB)),
        Err(Ok(GovernanceError::NotVetoable))
    );
}

// ── Disablement: authorization and preconditions ─────────────────────────────

#[test]
fn disable_requires_an_active_timelock() {
    let h = setup();
    assert_eq!(
        h.gov.try_disable_veto_power(),
        Err(Ok(GovernanceError::TimelockNotActive))
    );
    h.gov
        .set_execution_delay(&h.admin, &(MIN_ACTIVE_TIMELOCK_LEDGERS - 1));
    assert_eq!(
        h.gov.try_disable_veto_power(),
        Err(Ok(GovernanceError::TimelockNotActive))
    );
    assert!(h.gov.is_veto_power_enabled());
    assert!(h.gov.get_veto_disable_record().is_none());
}

#[test]
fn disable_requires_the_iln_contract_to_authorize() {
    let h = setup();
    h.gov
        .set_execution_delay(&h.admin, &MIN_ACTIVE_TIMELOCK_LEDGERS);
    h.env.set_auths(&[]);
    assert!(h.gov.try_disable_veto_power().is_err());
    assert!(h.gov.is_veto_power_enabled());
}

#[test]
fn disable_before_initialize_fails_closed() {
    let env = Env::default();
    env.mock_all_auths();
    let gov = GovContractClient::new(&env, &env.register_contract(None, GovContract));
    assert_eq!(
        gov.try_disable_veto_power(),
        Err(Ok(GovernanceError::NotInitialized))
    );
}

#[test]
fn disable_with_zero_reason_is_rejected() {
    let h = setup();
    h.gov
        .set_execution_delay(&h.admin, &MIN_ACTIVE_TIMELOCK_LEDGERS);
    assert_eq!(
        h.gov.try_disable_veto_power_with_reason(&zero_hash(&h.env)),
        Err(Ok(GovernanceError::ConsentRequired))
    );
    assert!(h.gov.is_veto_power_enabled());
}

// ── Disablement: permanence and audit record ─────────────────────────────────

#[test]
fn disable_records_authorizer_ledger_and_reason_once() {
    let h = setup();
    h.gov
        .set_execution_delay(&h.admin, &MIN_ACTIVE_TIMELOCK_LEDGERS);
    let reason = hash(&h.env, 0xCD);
    let seq = h.env.ledger().sequence();

    h.gov.disable_veto_power_with_reason(&reason);
    assert!(!h.gov.is_veto_power_enabled());

    let record = h.gov.get_veto_disable_record().unwrap();
    assert_eq!(record.authorized_by, h.iln);
    assert_eq!(record.disabled_at_ledger, seq);
    assert_eq!(record.reason_hash, reason);
}

/// A repeat disable is refused and leaves the original record and the policy
/// version untouched (the audit record is write-once).
#[test]
fn repeat_disable_is_rejected_and_keeps_original_record() {
    let h = setup();
    h.gov
        .set_execution_delay(&h.admin, &MIN_ACTIVE_TIMELOCK_LEDGERS);
    h.gov.disable_veto_power_with_reason(&hash(&h.env, 0xCD));
    let record = h.gov.get_veto_disable_record().unwrap();
    let version = h.gov.get_timelock_policy_version();

    advance_ledgers(&h.env, 5);
    assert_eq!(
        h.gov.try_disable_veto_power_with_reason(&hash(&h.env, 0xEF)),
        Err(Ok(GovernanceError::VetoPowerAlreadyDisabled))
    );
    assert_eq!(
        h.gov.try_disable_veto_power(),
        Err(Ok(GovernanceError::VetoPowerAlreadyDisabled))
    );
    assert_eq!(h.gov.get_veto_disable_record().unwrap(), record);
    assert_eq!(h.gov.get_timelock_policy_version(), version);
}

#[test]
fn legacy_disable_records_an_all_zero_reason() {
    let h = setup();
    h.gov
        .set_execution_delay(&h.admin, &MIN_ACTIVE_TIMELOCK_LEDGERS);
    h.gov.disable_veto_power();
    let record = h.gov.get_veto_disable_record().unwrap();
    assert_eq!(record.reason_hash, zero_hash(&h.env));
}

#[test]
fn veto_after_disable_is_rejected_even_for_a_partially_approved_veto() {
    let h = setup();
    let signers = configure_multisig(&h, 2, 2);
    let (s1, s2) = (signers.get(0).unwrap(), signers.get(1).unwrap());
    let id = new_proposal(&h);
    let reason = hash(&h.env, 0xAA);

    h.gov.veto_proposal(&s1, &id, &reason); // 1 of 2
    h.gov
        .set_execution_delay(&h.admin, &MIN_ACTIVE_TIMELOCK_LEDGERS);
    h.gov.disable_veto_power();

    assert_eq!(
        h.gov.try_veto_proposal(&s2, &id, &reason),
        Err(Ok(GovernanceError::VetoPowerDisabled))
    );
    assert_eq!(h.gov.get_proposal(&id).status, ProposalStatus::Active);
}

// ── Policy after disablement ─────────────────────────────────────────────────

#[test]
fn delay_cannot_drop_below_the_floor_after_disable() {
    let h = setup();
    h.gov
        .set_execution_delay(&h.admin, &MIN_ACTIVE_TIMELOCK_LEDGERS);
    h.gov.disable_veto_power();

    assert_eq!(
        h.gov.try_set_execution_delay(&h.admin, &0),
        Err(Ok(GovernanceError::TimelockNotActive))
    );
    assert_eq!(
        h.gov
            .try_set_execution_delay(&h.admin, &(MIN_ACTIVE_TIMELOCK_LEDGERS - 1)),
        Err(Ok(GovernanceError::TimelockNotActive))
    );
    assert_eq!(h.gov.get_execution_delay(), MIN_ACTIVE_TIMELOCK_LEDGERS);

    // Raising it remains allowed.
    h.gov
        .set_execution_delay(&h.admin, &(MIN_ACTIVE_TIMELOCK_LEDGERS + 1));
    assert_eq!(h.gov.get_execution_delay(), MIN_ACTIVE_TIMELOCK_LEDGERS + 1);
}

#[test]
fn disable_bumps_the_policy_version_once() {
    let h = setup();
    h.gov
        .set_execution_delay(&h.admin, &MIN_ACTIVE_TIMELOCK_LEDGERS);
    let before = h.gov.get_timelock_policy_version();
    h.gov.disable_veto_power();
    assert_eq!(h.gov.get_timelock_policy_version(), before + 1);
}

/// A proposal queued under a zero delay while the veto was live must not run
/// instantly once the veto is retired: the policy change re-applies the active
/// timelock from the queue ledger.
#[test]
fn proposal_queued_before_disable_is_held_by_the_new_timelock() {
    let h = setup();
    let id = queue_proposal(&h); // delay 0: eta == queue ledger

    h.gov
        .set_execution_delay(&h.admin, &MIN_ACTIVE_TIMELOCK_LEDGERS);
    h.gov.disable_veto_power();

    assert_eq!(
        h.gov.try_execute_proposal(&id),
        Err(Ok(GovernanceError::TimelockNotExpired))
    );
    assert_eq!(h.gov.get_proposal(&id).status, ProposalStatus::Passed);
}

/// New proposals queued after disablement always carry at least the floor.
#[test]
fn proposals_queued_after_disable_carry_at_least_the_floor() {
    let h = setup();
    h.gov
        .set_execution_delay(&h.admin, &MIN_ACTIVE_TIMELOCK_LEDGERS);
    h.gov.disable_veto_power();

    let id = queue_proposal(&h);
    let queued_at = h.env.ledger().sequence();
    let eta = h.gov.get_proposal(&id).eta_ledger;
    assert!(eta >= queued_at + MIN_ACTIVE_TIMELOCK_LEDGERS);
}
