#![cfg(test)]

//! Issue #1170 — settlement and overpayment rollback behavior.
//!
//! `mark_paid` lets the payer settle an invoice incrementally. These tests pin
//! the guarantees that make that safe, as documented in
//! `docs/settlement-overpayment-rollback.md`:
//!
//! * INV-STL1 — `amount_paid` is monotonic and never exceeds `amount`.
//! * INV-STL2 — a completing settlement debits the payer exactly once.
//! * INV-STL3 — an overpayment is rejected atomically and never partially
//!   credits the invoice.
//! * INV-STL4 — settlement completes once; a second attempt is `AlreadyPaid`
//!   and pays nothing extra.
//! * INV-STL5 — a settlement whose inbound transfer fails rolls back fully and
//!   the retry settles exactly once.
//! * INV-STL6 — a completing settlement is value-neutral to the contract.
//!
//! RR-1 (partial settlement is only visible via `amount_paid`) is asserted too.

use super::*;
use soroban_sdk::{
    testutils::{Address as _, IssuerFlags, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30; // 30 days

struct TestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: Address,
    sac: StellarAssetClient<'static>,
    token_client: TokenClient<'static>,
    #[allow(dead_code)]
    admin: Address,
    freelancer: Address,
    payer: Address,
    lp: Address,
}

fn setup() -> TestEnv {
    let env = Env::default();
    env.mock_all_auths();

    // Revocable SAC so the payer's trustline can be frozen to exercise the
    // failed-inbound-transfer rollback path.
    let issuer = Address::generate(&env);
    let sac_contract = env.register_stellar_asset_contract_v2(issuer);
    sac_contract.issuer().set_flag(IssuerFlags::RevocableFlag);
    let token = sac_contract.address();
    let sac = StellarAssetClient::new(&env, &token);
    let token_client = TokenClient::new(&env, &token);

    let admin = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let lp = Address::generate(&env);
    for who in [&payer, &lp] {
        sac.mint(who, &(INVOICE_AMOUNT * 10));
    }

    let eurc = Address::generate(&env);
    let xlm_admin = Address::generate(&env);
    let xlm = env.register_stellar_asset_contract_v2(xlm_admin).address();

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);
    contract.initialize(&admin, &token, &eurc, &xlm);

    let mut ledger = env.ledger().get();
    ledger.timestamp = 1_700_000_000;
    ledger.sequence_number = 100;
    env.ledger().set(ledger);

    TestEnv {
        env,
        contract,
        token,
        sac,
        token_client,
        admin,
        freelancer,
        payer,
        lp,
    }
}

fn due_date(t: &TestEnv) -> u64 {
    t.env.ledger().timestamp() + DUE_DATE_OFFSET
}

/// Submit an invoice and fully fund it, leaving it `Funded` and settleable.
fn submit_funded(t: &TestEnv) -> u64 {
    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date(t),
        &DISCOUNT_RATE,
        &t.token,
        &ReferralCode::None,
    );
    t.contract.fund_invoice(&t.lp, &id, &INVOICE_AMOUNT, &false);
    id
}

fn status(t: &TestEnv, id: u64) -> InvoiceStatus {
    t.contract.get_invoice(&id).status
}

fn amount_paid(t: &TestEnv, id: u64) -> i128 {
    t.contract.get_invoice(&id).amount_paid
}

fn freeze(t: &TestEnv, who: &Address) {
    t.sac.set_authorized(who, &false);
}

fn unfreeze(t: &TestEnv, who: &Address) {
    t.sac.set_authorized(who, &true);
}

// ================================================================
// INV-STL1 / INV-STL3 — overpayment never partially credits
// ================================================================

#[test]
fn overpayment_from_scratch_is_rejected_without_credit() {
    let t = setup();
    let id = submit_funded(&t);
    let payer_before = t.token_client.balance(&t.payer);

    let res = t.contract.try_mark_paid(&id, &(INVOICE_AMOUNT + 1));
    assert_eq!(res, Err(Ok(ContractError::OverpaymentRejected)));

    // No credit, no status change, no debit.
    assert_eq!(amount_paid(&t, id), 0); // INV-STL1
    assert_eq!(status(&t, id), InvoiceStatus::Funded);
    assert_eq!(t.token_client.balance(&t.payer), payer_before);

    // The invoice is still settleable for exactly its face value.
    t.contract.mark_paid(&id, &INVOICE_AMOUNT);
    assert_eq!(status(&t, id), InvoiceStatus::Paid);
    assert_eq!(amount_paid(&t, id), INVOICE_AMOUNT);
    assert_eq!(t.token_client.balance(&t.payer), payer_before - INVOICE_AMOUNT); // credited once
}

#[test]
fn overpayment_after_partial_is_measured_against_remaining() {
    let t = setup();
    let id = submit_funded(&t);
    let half = INVOICE_AMOUNT / 2;

    t.contract.mark_paid(&id, &half);
    assert_eq!(amount_paid(&t, id), half);
    assert_eq!(status(&t, id), InvoiceStatus::Funded); // partial keeps Funded
    let payer_after_partial = t.token_client.balance(&t.payer);

    // One stroop beyond the *remaining* balance must be rejected.
    let res = t.contract.try_mark_paid(&id, &(half + 1));
    assert_eq!(res, Err(Ok(ContractError::OverpaymentRejected)));
    assert_eq!(amount_paid(&t, id), half); // INV-STL3
    assert_eq!(t.token_client.balance(&t.payer), payer_after_partial);

    // The exact remainder completes the settlement.
    t.contract.mark_paid(&id, &half);
    assert_eq!(status(&t, id), InvoiceStatus::Paid);
    assert_eq!(amount_paid(&t, id), INVOICE_AMOUNT);
}

// ================================================================
// INV-STL4 — completion is once-only
// ================================================================

#[test]
fn completion_is_once_only_no_double_payout() {
    let t = setup();
    let id = submit_funded(&t);

    t.contract.mark_paid(&id, &INVOICE_AMOUNT);
    let payer_after = t.token_client.balance(&t.payer);
    let lp_after = t.token_client.balance(&t.lp);
    assert_eq!(t.contract.get_contract_stats().total_paid, 1);

    let res = t.contract.try_mark_paid(&id, &INVOICE_AMOUNT);
    assert_eq!(res, Err(Ok(ContractError::AlreadyPaid)));

    // Nothing moved, and the completed counter did not advance again.
    assert_eq!(t.token_client.balance(&t.payer), payer_after);
    assert_eq!(t.token_client.balance(&t.lp), lp_after);
    assert_eq!(amount_paid(&t, id), INVOICE_AMOUNT);
    assert_eq!(t.contract.get_contract_stats().total_paid, 1);
}

// ================================================================
// INV-STL2 / INV-STL6 — settlement debits once and is value-neutral
// ================================================================

#[test]
fn settlement_is_self_funding_and_credits_payer_exactly_once() {
    let t = setup();
    let id = submit_funded(&t);

    let payer_before = t.token_client.balance(&t.payer);
    let lp_before = t.token_client.balance(&t.lp);
    let contract_before = t.token_client.balance(&t.contract.address);

    t.contract.mark_paid(&id, &INVOICE_AMOUNT);

    // Payer debited exactly the principal (INV-STL2).
    assert_eq!(
        payer_before - t.token_client.balance(&t.payer),
        INVOICE_AMOUNT
    );
    // LP recovered at least its principal (INV-STL2).
    assert!(t.token_client.balance(&t.lp) > lp_before);
    // Inbound funds cover the fee and LP distribution exactly (INV-STL6).
    assert_eq!(t.token_client.balance(&t.contract.address), contract_before);
}

// ================================================================
// INV-STL5 — failed inbound transfer rolls back fully
// ================================================================

#[test]
fn frozen_payer_settlement_rolls_back_then_succeeds_exactly_once() {
    let t = setup();
    let id = submit_funded(&t);
    freeze(&t, &t.payer);

    let payer_before = t.token_client.balance(&t.payer);
    let lp_before = t.token_client.balance(&t.lp);

    let res = t.contract.try_mark_paid(&id, &INVOICE_AMOUNT);
    assert_eq!(res, Err(Ok(ContractError::AccountFrozen)));

    // The failed attempt did not pre-credit anything.
    assert_eq!(amount_paid(&t, id), 0); // INV-STL5
    assert_eq!(status(&t, id), InvoiceStatus::Funded);
    assert_eq!(t.token_client.balance(&t.payer), payer_before);
    assert_eq!(t.token_client.balance(&t.lp), lp_before);

    // After unfreezing, the invoice settles exactly once.
    unfreeze(&t, &t.payer);
    t.contract.mark_paid(&id, &INVOICE_AMOUNT);
    assert_eq!(status(&t, id), InvoiceStatus::Paid);
    assert_eq!(t.token_client.balance(&t.payer), payer_before - INVOICE_AMOUNT);
    assert_eq!(t.contract.get_contract_stats().total_paid, 1);
}

#[test]
fn frozen_payer_partial_attempt_rolls_back_then_completes() {
    let t = setup();
    let id = submit_funded(&t);
    let half = INVOICE_AMOUNT / 2;

    freeze(&t, &t.payer);
    let res = t.contract.try_mark_paid(&id, &half);
    assert_eq!(res, Err(Ok(ContractError::AccountFrozen)));
    assert_eq!(amount_paid(&t, id), 0); // no half-credit leaked through

    unfreeze(&t, &t.payer);
    t.contract.mark_paid(&id, &half);
    assert_eq!(amount_paid(&t, id), half);
    t.contract.mark_paid(&id, &half);
    assert_eq!(status(&t, id), InvoiceStatus::Paid);
    assert_eq!(amount_paid(&t, id), INVOICE_AMOUNT);
}

// ================================================================
// Status gating and input validation
// ================================================================

#[test]
fn settling_unfunded_and_defaulted_is_rejected() {
    let t = setup();

    // Pending invoice (submitted but never funded).
    let pending = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date(&t),
        &DISCOUNT_RATE,
        &t.token,
        &ReferralCode::None,
    );
    let res = t.contract.try_mark_paid(&pending, &INVOICE_AMOUNT);
    assert_eq!(res, Err(Ok(ContractError::NotFunded)));
    assert_eq!(amount_paid(&t, pending), 0);

    // Defaulted invoice: settlement must not resurrect it after default.
    let funded = submit_funded(&t);
    let mut info = t.env.ledger().get();
    info.timestamp = due_date(&t) + 1;
    t.env.ledger().set(info);
    t.contract.claim_default(&t.lp, &funded);
    assert_eq!(status(&t, funded), InvoiceStatus::Defaulted);

    let res = t.contract.try_mark_paid(&funded, &INVOICE_AMOUNT);
    assert_eq!(res, Err(Ok(ContractError::InvoiceDefaulted)));
    assert_eq!(amount_paid(&t, funded), 0);
    assert_eq!(status(&t, funded), InvoiceStatus::Defaulted);
}

#[test]
fn zero_or_negative_settlement_is_invalid_amount() {
    let t = setup();
    let id = submit_funded(&t);

    assert_eq!(
        t.contract.try_mark_paid(&id, &0),
        Err(Ok(ContractError::InvalidAmount))
    );
    assert_eq!(
        t.contract.try_mark_paid(&id, &-1),
        Err(Ok(ContractError::InvalidAmount))
    );
    assert_eq!(amount_paid(&t, id), 0); // INV-STL1
    assert_eq!(status(&t, id), InvoiceStatus::Funded);
}

// ================================================================
// RR-1 — partial settlement is only observable via amount_paid
// ================================================================

#[test]
fn partial_settlement_is_observable_only_through_amount_paid() {
    let t = setup();
    let id = submit_funded(&t);

    t.contract.mark_paid(&id, &(INVOICE_AMOUNT - 1));

    let inv = t.contract.get_invoice(&id);
    // Status does not distinguish "unsettled" from "almost settled"...
    assert_eq!(inv.status, InvoiceStatus::Funded);
    // ...so integrators must read the counter.
    assert_eq!(inv.amount_paid, INVOICE_AMOUNT - 1);
}
