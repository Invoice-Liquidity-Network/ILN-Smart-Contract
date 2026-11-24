//! Authorization audit for `reputation_bonus` (see
//! `docs/reputation-bonus-authorization-audit.md`).
//!
//! Each test sets state up with mocked auths, then drops them with
//! `set_auths(&[])` before the call under test so `require_auth` is enforced.

#![cfg(test)]

use reputation_bonus::config::Config;
use reputation_bonus::errors::ContractError;
use reputation_bonus::{ReputationBonusContract, ReputationBonusContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env,
};

const DUE_DATE: u64 = 1_000;

fn cfg(threshold: u32, bonus: u32, min_rate: u32) -> Config {
    Config {
        high_rep_threshold: threshold,
        bonus_bps: bonus,
        min_discount_rate_bps: min_rate,
    }
}

/// Initialised contract with a stored config. Mocked auths are active.
fn setup() -> (Env, ReputationBonusContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register_contract(None, ReputationBonusContract);
    let client = ReputationBonusContractClient::new(&env, &id);
    client.init(&admin);
    client.set_config(&cfg(80, 200, 100));
    (env, client, admin)
}

fn assert_config(client: &ReputationBonusContractClient, expected: &Config) {
    assert_eq!(&client.get_config(), expected);
}

// ── init ─────────────────────────────────────────────────────────────────────

#[test]
fn init_twice_is_rejected_and_admin_is_unchanged() {
    let (env, client, admin) = setup();
    let attacker = Address::generate(&env);

    assert_eq!(
        client.try_init(&attacker),
        Err(Ok(ContractError::AlreadyInitialized))
    );

    // The attacker did not become admin; the original admin still can.
    assert_eq!(
        client.try_update_config(&attacker, &10, &10, &10),
        Err(Ok(ContractError::ConfigErrorUnauthorized))
    );
    client.update_config(&admin, &90, &300, &150);
    assert_config(&client, &cfg(90, 300, 150));
}

// ── set_config ───────────────────────────────────────────────────────────────

#[test]
fn set_config_before_init_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, ReputationBonusContract);
    let client = ReputationBonusContractClient::new(&env, &id);

    assert_eq!(
        client.try_set_config(&cfg(80, 200, 100)),
        Err(Ok(ContractError::ConfigErrorUnauthorized))
    );
    assert!(client.try_get_config().is_err());
}

#[test]
fn set_config_without_admin_signature_is_rejected() {
    let (env, client, _admin) = setup();
    let before = client.get_config();

    env.set_auths(&[]);
    assert!(client.try_set_config(&cfg(1, 1, 1)).is_err());

    assert_config(&client, &before);
}

#[test]
fn set_config_with_admin_signature_still_validates_bounds() {
    let (_env, client, _admin) = setup();
    let before = client.get_config();

    assert_eq!(
        client.try_set_config(&cfg(101, 200, 100)),
        Err(Ok(ContractError::ConfigErrorInvalidHighRepThreshold))
    );
    assert_eq!(
        client.try_set_config(&cfg(80, 501, 100)),
        Err(Ok(ContractError::ConfigErrorInvalidBonusBps))
    );
    assert_eq!(
        client.try_set_config(&cfg(80, 200, 0)),
        Err(Ok(ContractError::ConfigErrorInvalidMinDiscountRate))
    );
    assert_config(&client, &before);
}

// ── update_config ────────────────────────────────────────────────────────────

#[test]
fn update_config_by_signed_non_admin_is_rejected() {
    let (env, client, _admin) = setup();
    let before = client.get_config();
    let other = Address::generate(&env);

    assert_eq!(
        client.try_update_config(&other, &90, &300, &150),
        Err(Ok(ContractError::ConfigErrorUnauthorized))
    );
    assert_config(&client, &before);
}

#[test]
fn update_config_without_admin_signature_is_rejected() {
    let (env, client, admin) = setup();
    let before = client.get_config();

    env.set_auths(&[]);
    assert!(client.try_update_config(&admin, &90, &300, &150).is_err());

    assert_config(&client, &before);
}

// ── invoice flow ─────────────────────────────────────────────────────────────

#[test]
fn submit_invoice_without_freelancer_signature_is_rejected() {
    let (env, client, _admin) = setup();
    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);

    env.set_auths(&[]);
    assert!(client
        .try_submit_invoice(&freelancer, &payer, &1_000, &DUE_DATE, &500)
        .is_err());

    assert_eq!(client.get_reputation(&freelancer).invoices_submitted, 0);
    assert_eq!(client.get_reputation(&payer).invoices_submitted, 0);
}

#[test]
fn mark_paid_without_payer_signature_is_rejected() {
    let (env, client, _admin) = setup();
    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let inv = client.submit_invoice(&freelancer, &payer, &1_000, &DUE_DATE, &500);

    env.set_auths(&[]);
    assert!(client.try_mark_paid(&inv.id).is_err());

    assert_eq!(client.get_reputation(&freelancer).invoices_paid, 0);
    assert_eq!(client.get_reputation(&payer).invoices_paid, 0);
}

#[test]
fn handle_default_is_rejected_until_invoice_is_overdue() {
    let (env, client, _admin) = setup();
    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let inv = client.submit_invoice(&freelancer, &payer, &1_000, &DUE_DATE, &500);

    // Not yet due, and exactly at the due date, are both refused and leave
    // both parties' reputation untouched.
    for now in [0_u64, DUE_DATE] {
        env.ledger().set_timestamp(now);
        assert_eq!(
            client.try_handle_default(&inv.id),
            Err(Ok(ContractError::InvoiceNotOverdue))
        );
        assert_eq!(client.get_reputation(&freelancer).invoices_defaulted, 0);
        assert_eq!(client.get_reputation(&payer).invoices_defaulted, 0);
    }

    // One second past the due date anyone may default it, exactly once.
    env.ledger().set_timestamp(DUE_DATE + 1);
    client.handle_default(&inv.id);
    assert_eq!(client.get_reputation(&freelancer).invoices_defaulted, 1);
    assert_eq!(client.get_reputation(&payer).invoices_defaulted, 1);

    assert_eq!(
        client.try_handle_default(&inv.id),
        Err(Ok(ContractError::IllegalState))
    );
    assert_eq!(client.get_reputation(&freelancer).invoices_defaulted, 1);
}

#[test]
fn settled_invoice_cannot_be_defaulted_or_paid_again() {
    let (env, client, _admin) = setup();
    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let inv = client.submit_invoice(&freelancer, &payer, &1_000, &DUE_DATE, &500);
    client.mark_paid(&inv.id);

    env.ledger().set_timestamp(DUE_DATE + 1);
    assert_eq!(
        client.try_handle_default(&inv.id),
        Err(Ok(ContractError::IllegalState))
    );
    assert_eq!(
        client.try_mark_paid(&inv.id),
        Err(Ok(ContractError::IllegalState))
    );
    assert_eq!(client.get_reputation(&freelancer).invoices_paid, 1);
    assert_eq!(client.get_reputation(&freelancer).invoices_defaulted, 0);
}
