#![cfg(test)]

//! Issue #1168 — executable coverage for the invoice state-transition table.
//!
//! This module is the test half of `docs/invoice-state-transitions.md`. Each
//! test pins one edge of the lifecycle (a state entry point's accepted `from`
//! state and its resulting `to` state) or one rejection path. Together they
//! assert the invariants declared in `invoice.rs` (`SM1`/`SM2`) and restated
//! in the document:
//!
//! * INV-ST1 — `submit_invoice` creates an invoice in `Pending`.
//! * INV-ST2 — each entry point only ever writes the `to` state(s) declared
//!   for it.
//! * INV-ST3 — terminal states (`Paid`, `Expired`, `Cancelled`) are absorbing.
//! * INV-ST4 — an invalid `(from, entry point)` pair returns a distinct typed
//!   `ContractError`, never a silent success.
//! * INV-ST5 — `amount_funded == amount` ⇔ funding-complete, `amount_paid ==
//!   amount` ⇔ `Paid`.
//! * INV-ST6 — a `Pending` invoice past due cannot be funded/queued as live.

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, BytesN, Env,
};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30; // 30 days

/// Matches the `dispute_timeout_ledgers` written by `initialize`.
const DISPUTE_TIMEOUT_LEDGERS: u32 = 10_000;

struct TestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: Address,
    #[allow(dead_code)]
    admin: Address,
    freelancer: Address,
    payer: Address,
    lp: Address,
}

fn setup() -> TestEnv {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let lp = Address::generate(&env);

    let token_admin_addr = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin_addr);
    let token = token_contract.address();
    let token_admin = StellarAssetClient::new(&env, &token);

    token_admin.mint(&payer, &(INVOICE_AMOUNT * 10));
    token_admin.mint(&lp, &(INVOICE_AMOUNT * 10));

    let eurc = Address::generate(&env);
    let xlm_admin = Address::generate(&env);
    let xlm = env.register_stellar_asset_contract_v2(xlm_admin).address();

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);
    contract.initialize(&admin, &token, &eurc, &xlm);

    // Treasury reserve so LP refunds (cancel / default / upheld dispute) can be
    // covered after the LP's contribution has already been forwarded to the
    // freelancer at funding time. Sized to exactly one LP contribution.
    let lp_contribution = INVOICE_AMOUNT - (INVOICE_AMOUNT * DISCOUNT_RATE as i128 / 10_000);
    token_admin.mint(&contract.address, &lp_contribution);

    let mut ledger = env.ledger().get();
    ledger.timestamp = 1_700_000_000;
    ledger.sequence_number = 100;
    env.ledger().set(ledger);

    TestEnv {
        env,
        contract,
        token,
        admin,
        freelancer,
        payer,
        lp,
    }
}

fn due_date(t: &TestEnv) -> u64 {
    t.env.ledger().timestamp() + DUE_DATE_OFFSET
}

fn submit(t: &TestEnv) -> u64 {
    t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date(t),
        &DISCOUNT_RATE,
        &t.token,
        &ReferralCode::None,
    )
}

/// Create a fresh invoice already fully funded (status `Funded`).
fn submit_funded(t: &TestEnv) -> u64 {
    let id = submit(t);
    t.contract
        .fund_invoice(&t.lp, &id, &INVOICE_AMOUNT, &false);
    id
}

fn status(t: &TestEnv, id: u64) -> InvoiceStatus {
    t.contract.get_invoice(&id).status
}

fn set_timestamp(t: &TestEnv, timestamp: u64) {
    let mut ledger = t.env.ledger().get();
    ledger.timestamp = timestamp;
    t.env.ledger().set(ledger);
}

fn set_sequence(t: &TestEnv, sequence_number: u32) {
    let mut ledger = t.env.ledger().get();
    ledger.sequence_number = sequence_number;
    t.env.ledger().set(ledger);
}

fn hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

// ================================================================
// INV-ST1 / T1 — creation
// ================================================================

#[test]
fn submit_creates_pending_invoice() {
    let t = setup();
    let id = submit(&t);

    let invoice = t.contract.get_invoice(&id);
    assert_eq!(invoice.status, InvoiceStatus::Pending);
    assert_eq!(invoice.amount_funded, 0);
    assert_eq!(invoice.amount_paid, 0);
}

// ================================================================
// T5 / T6 / INV-ST5 — funding
// ================================================================

#[test]
fn partial_funding_reaches_partially_funded() {
    let t = setup();
    let id = submit(&t);
    t.contract
        .fund_invoice(&t.lp, &id, &(INVOICE_AMOUNT / 2), &false);

    let invoice = t.contract.get_invoice(&id);
    assert_eq!(invoice.status, InvoiceStatus::PartiallyFunded);
    assert!(invoice.amount_funded > 0 && invoice.amount_funded < INVOICE_AMOUNT);
}

#[test]
fn full_funding_reaches_funded() {
    let t = setup();
    let id = submit(&t);
    t.contract
        .fund_invoice(&t.lp, &id, &INVOICE_AMOUNT, &false);

    let invoice = t.contract.get_invoice(&id);
    assert_eq!(invoice.status, InvoiceStatus::Funded);
    assert_eq!(invoice.amount_funded, INVOICE_AMOUNT); // INV-ST5
}

#[test]
fn partial_then_remainder_reaches_funded() {
    let t = setup();
    let id = submit(&t);

    t.contract
        .fund_invoice(&t.lp, &id, &(INVOICE_AMOUNT / 4), &false);
    assert_eq!(status(&t, id), InvoiceStatus::PartiallyFunded);

    t.contract
        .fund_invoice(&t.lp, &id, &(INVOICE_AMOUNT - INVOICE_AMOUNT / 4), &false);
    assert_eq!(status(&t, id), InvoiceStatus::Funded);
}

#[test]
fn funding_a_funded_invoice_rejected() {
    let t = setup();
    let id = submit_funded(&t);

    let res = t.contract.try_fund_invoice(&t.lp, &id, &1, &false);
    assert_eq!(res, Err(Ok(ContractError::AlreadyFunded)));
    assert_eq!(status(&t, id), InvoiceStatus::Funded);
}

// ================================================================
// T8 / T9 — cancellation
// ================================================================

#[test]
fn cancel_pending_reaches_cancelled() {
    let t = setup();
    let id = submit(&t);

    t.contract.cancel_invoice(&id);
    assert_eq!(status(&t, id), InvoiceStatus::Cancelled);
}

#[test]
fn cancel_partially_funded_reaches_cancelled_and_refunds_lp() {
    let t = setup();
    let id = submit(&t);
    t.contract
        .fund_invoice(&t.lp, &id, &(INVOICE_AMOUNT / 2), &false);

    let token = TokenClient::new(&t.env, &t.token);
    let before = token.balance(&t.lp);

    t.contract.cancel_invoice(&id);

    assert_eq!(status(&t, id), InvoiceStatus::Cancelled);
    assert!(
        token.balance(&t.lp) > before,
        "LP contribution must be refunded when a partially funded invoice is cancelled"
    );
}

#[test]
fn cancel_funded_rejected() {
    let t = setup();
    let id = submit_funded(&t);

    let res = t.contract.try_cancel_invoice(&id);
    assert_eq!(res, Err(Ok(ContractError::AlreadyFunded)));
    assert_eq!(status(&t, id), InvoiceStatus::Funded);
}

// ================================================================
// T10 — expiry (and side-effect expiry, INV-ST6)
// ================================================================

#[test]
fn expire_pending_after_due_reaches_expired() {
    let t = setup();
    let id = submit(&t);
    set_timestamp(&t, due_date(&t) + 1);

    t.contract.expire_invoice(&id);
    assert_eq!(status(&t, id), InvoiceStatus::Expired);
}

#[test]
fn expire_before_due_rejected() {
    let t = setup();
    let id = submit(&t);

    let res = t.contract.try_expire_invoice(&id);
    assert_eq!(res, Err(Ok(ContractError::NotYetDefaulted)));
    assert_eq!(status(&t, id), InvoiceStatus::Pending);
}

#[test]
fn expire_funded_rejected() {
    let t = setup();
    let id = submit_funded(&t);
    set_timestamp(&t, due_date(&t) + 1);

    let res = t.contract.try_expire_invoice(&id);
    assert_eq!(res, Err(Ok(ContractError::AlreadyFunded)));
    assert_eq!(status(&t, id), InvoiceStatus::Funded);
}

#[test]
fn update_pending_past_due_implicitly_expires() {
    let t = setup();
    let id = submit(&t);
    let due = due_date(&t);
    set_timestamp(&t, due); // `update_invoice` treats now == due_date as past due

    let res = t.contract.try_update_invoice(
        &t.freelancer,
        &id,
        &INVOICE_AMOUNT,
        &(due + DUE_DATE_OFFSET),
        &DISCOUNT_RATE,
    );

    assert_eq!(res, Err(Ok(ContractError::InvoiceExpired)));
    // The implicit Pending -> Expired transition is persisted before the error.
    assert_eq!(status(&t, id), InvoiceStatus::Expired);
}

#[test]
fn convert_pending_past_due_implicitly_expires() {
    let t = setup();
    let id = submit(&t);
    let due = due_date(&t);
    set_timestamp(&t, due);

    let res = t
        .contract
        .try_convert_invoice_token(&t.freelancer, &id, &t.token);

    assert_eq!(res, Err(Ok(ContractError::InvoiceExpired)));
    assert_eq!(status(&t, id), InvoiceStatus::Expired);
}

// ================================================================
// T11 / T12 — payment
// ================================================================

#[test]
fn partial_payment_keeps_funded() {
    let t = setup();
    let id = submit_funded(&t);

    t.contract.mark_paid(&id, &(INVOICE_AMOUNT / 2));

    let invoice = t.contract.get_invoice(&id);
    assert_eq!(invoice.status, InvoiceStatus::Funded);
    assert_eq!(invoice.amount_paid, INVOICE_AMOUNT / 2);
}

#[test]
fn full_payment_reaches_paid() {
    let t = setup();
    let id = submit_funded(&t);

    t.contract.mark_paid(&id, &INVOICE_AMOUNT);

    let invoice = t.contract.get_invoice(&id);
    assert_eq!(invoice.status, InvoiceStatus::Paid);
    assert_eq!(invoice.amount_paid, INVOICE_AMOUNT); // INV-ST5
}

#[test]
fn mark_paid_unfunded_rejected() {
    let t = setup();
    let id = submit(&t);

    let res = t.contract.try_mark_paid(&id, &INVOICE_AMOUNT);
    assert_eq!(res, Err(Ok(ContractError::NotFunded)));
}

// ================================================================
// T13 / T14 / T15 — default and appeal
// ================================================================

#[test]
fn claim_default_reaches_defaulted() {
    let t = setup();
    let id = submit_funded(&t);
    set_timestamp(&t, due_date(&t) + 1);

    t.contract.claim_default(&t.lp, &id);
    assert_eq!(status(&t, id), InvoiceStatus::Defaulted);
}

#[test]
fn claim_default_before_due_rejected() {
    let t = setup();
    let id = submit_funded(&t);

    let res = t.contract.try_claim_default(&t.lp, &id);
    assert_eq!(res, Err(Ok(ContractError::NotYetDefaulted)));
    assert_eq!(status(&t, id), InvoiceStatus::Funded);
}

#[test]
fn appeal_default_reaches_appealed() {
    let t = setup();
    let id = submit_funded(&t);
    set_timestamp(&t, due_date(&t) + 1);
    t.contract.claim_default(&t.lp, &id);

    t.contract.appeal_default(&id, &hash(&t.env, 1));
    assert_eq!(status(&t, id), InvoiceStatus::Appealed);
}

#[test]
fn appeal_non_defaulted_rejected() {
    let t = setup();
    let id = submit_funded(&t);

    let res = t.contract.try_appeal_default(&id, &hash(&t.env, 1));
    assert_eq!(res, Err(Ok(ContractError::NotDefaulted)));
    assert_eq!(status(&t, id), InvoiceStatus::Funded);
}

#[test]
fn resolve_appeal_upheld_reaches_defaulted() {
    let t = setup();
    let id = submit_funded(&t);
    set_timestamp(&t, due_date(&t) + 1);
    t.contract.claim_default(&t.lp, &id);
    t.contract.appeal_default(&id, &hash(&t.env, 1));

    t.contract.resolve_appeal(&id, &true);
    // Appeal upheld reverses the payer penalty but the invoice stays Defaulted.
    assert_eq!(status(&t, id), InvoiceStatus::Defaulted);
}

#[test]
fn resolve_appeal_rejected_reaches_defaulted() {
    let t = setup();
    let id = submit_funded(&t);
    set_timestamp(&t, due_date(&t) + 1);
    t.contract.claim_default(&t.lp, &id);
    t.contract.appeal_default(&id, &hash(&t.env, 1));

    t.contract.resolve_appeal(&id, &false);
    assert_eq!(status(&t, id), InvoiceStatus::Defaulted);
}

// ================================================================
// T16 / T17 / T18 / T19 — disputes
// ================================================================

#[test]
fn dispute_pending_reaches_disputed() {
    let t = setup();
    let id = submit(&t);

    t.contract.dispute_invoice(&id, &hash(&t.env, 2));
    assert_eq!(status(&t, id), InvoiceStatus::Disputed);
}

#[test]
fn dispute_funded_reaches_disputed() {
    let t = setup();
    let id = submit_funded(&t);

    t.contract.dispute_invoice(&id, &hash(&t.env, 2));
    assert_eq!(status(&t, id), InvoiceStatus::Disputed);
}

#[test]
fn dispute_paid_rejected() {
    let t = setup();
    let id = submit_funded(&t);
    t.contract.mark_paid(&id, &INVOICE_AMOUNT);

    let res = t.contract.try_dispute_invoice(&id, &hash(&t.env, 2));
    assert_eq!(res, Err(Ok(ContractError::AlreadyPaid)));
}

#[test]
fn resolve_dispute_upheld_reaches_cancelled() {
    let t = setup();
    let id = submit_funded(&t);
    t.contract.dispute_invoice(&id, &hash(&t.env, 2));

    t.contract.resolve_dispute(&id, &hash(&t.env, 3), &1);
    assert_eq!(status(&t, id), InvoiceStatus::Cancelled);
}

#[test]
fn resolve_dispute_rejected_restores_funded() {
    let t = setup();
    let id = submit_funded(&t);
    t.contract.dispute_invoice(&id, &hash(&t.env, 2));

    t.contract.resolve_dispute(&id, &hash(&t.env, 3), &2);
    // Freelancer upheld: restore the pre-dispute funding-derived state.
    assert_eq!(status(&t, id), InvoiceStatus::Funded);
}

#[test]
fn resolve_dispute_rejected_restores_partially_funded() {
    let t = setup();
    let id = submit(&t);
    t.contract
        .fund_invoice(&t.lp, &id, &(INVOICE_AMOUNT / 2), &false);
    t.contract.dispute_invoice(&id, &hash(&t.env, 2));

    t.contract.resolve_dispute(&id, &hash(&t.env, 3), &2);
    assert_eq!(status(&t, id), InvoiceStatus::PartiallyFunded);
}

#[test]
fn resolve_dispute_non_disputed_rejected() {
    let t = setup();
    let id = submit_funded(&t);

    let res = t
        .contract
        .try_resolve_dispute(&id, &hash(&t.env, 3), &1);
    assert_eq!(res, Err(Ok(ContractError::NotDisputed)));
}

#[test]
fn auto_resolve_dispute_after_timeout_restores_funded() {
    let t = setup();
    let id = submit_funded(&t);
    t.contract.dispute_invoice(&id, &hash(&t.env, 2));

    set_sequence(&t, 100 + DISPUTE_TIMEOUT_LEDGERS + 1);
    t.contract.auto_resolve_dispute(&id);
    assert_eq!(status(&t, id), InvoiceStatus::Funded);
}

#[test]
fn auto_resolve_dispute_before_timeout_rejected() {
    let t = setup();
    let id = submit_funded(&t);
    t.contract.dispute_invoice(&id, &hash(&t.env, 2));

    let res = t.contract.try_auto_resolve_dispute(&id);
    assert_eq!(res, Err(Ok(ContractError::Unauthorized)));
    assert_eq!(status(&t, id), InvoiceStatus::Disputed);
}

// ================================================================
// INV-ST3 — terminal states are absorbing
// ================================================================

#[test]
fn paid_is_terminal() {
    let t = setup();
    let id = submit_funded(&t);
    t.contract.mark_paid(&id, &INVOICE_AMOUNT);
    assert_eq!(status(&t, id), InvoiceStatus::Paid);
    set_timestamp(&t, due_date(&t) + 1);

    assert_eq!(
        t.contract.try_cancel_invoice(&id),
        Err(Ok(ContractError::AlreadyPaid))
    );
    assert_eq!(
        t.contract.try_expire_invoice(&id),
        Err(Ok(ContractError::AlreadyPaid))
    );
    assert_eq!(
        t.contract.try_dispute_invoice(&id, &hash(&t.env, 4)),
        Err(Ok(ContractError::AlreadyPaid))
    );
    assert_eq!(status(&t, id), InvoiceStatus::Paid);
}

#[test]
fn cancelled_is_terminal() {
    let t = setup();
    let id = submit(&t);
    t.contract.cancel_invoice(&id);
    assert_eq!(status(&t, id), InvoiceStatus::Cancelled);

    assert_eq!(
        t.contract.try_cancel_invoice(&id),
        Err(Ok(ContractError::AlreadyCancelled))
    );
    assert_eq!(
        t.contract.try_fund_invoice(&t.lp, &id, &1, &false),
        Err(Ok(ContractError::AlreadyCancelled))
    );
    assert_eq!(
        t.contract.try_dispute_invoice(&id, &hash(&t.env, 4)),
        Err(Ok(ContractError::AlreadyCancelled))
    );
    assert_eq!(status(&t, id), InvoiceStatus::Cancelled);
}

#[test]
fn expired_is_terminal() {
    let t = setup();
    let id = submit(&t);
    set_timestamp(&t, due_date(&t) + 1);
    t.contract.expire_invoice(&id);
    assert_eq!(status(&t, id), InvoiceStatus::Expired);

    assert_eq!(
        t.contract.try_expire_invoice(&id),
        Err(Ok(ContractError::InvoiceExpired))
    );
    assert_eq!(
        t.contract.try_fund_invoice(&t.lp, &id, &1, &false),
        Err(Ok(ContractError::InvoiceExpired))
    );
    assert_eq!(
        t.contract.try_dispute_invoice(&id, &hash(&t.env, 4)),
        Err(Ok(ContractError::InvoiceExpired))
    );
    assert_eq!(status(&t, id), InvoiceStatus::Expired);
}

// ================================================================
// INV-ST4 / SM2 — invalid (from, entry point) pairs
// ================================================================

#[test]
fn update_invoice_requires_pending() {
    let t = setup();
    let id = submit_funded(&t);

    let res = t.contract.try_update_invoice(
        &t.freelancer,
        &id,
        &INVOICE_AMOUNT,
        &(due_date(&t) + DUE_DATE_OFFSET),
        &DISCOUNT_RATE,
    );
    assert_eq!(res, Err(Ok(ContractError::AlreadyFunded)));
}

#[test]
fn transfer_invoice_requires_pending() {
    let t = setup();
    let id = submit_funded(&t);
    let new_freelancer = Address::generate(&t.env);

    let res = t.contract.try_transfer_invoice(&id, &new_freelancer);
    assert_eq!(res, Err(Ok(ContractError::AlreadyFunded)));
}

#[test]
fn transfer_lp_position_requires_funded() {
    let t = setup();
    let id = submit(&t);
    t.contract
        .fund_invoice(&t.lp, &id, &(INVOICE_AMOUNT / 2), &false);
    let new_lp = Address::generate(&t.env);

    let res = t.contract.try_transfer_lp_position(&id, &new_lp);
    assert_eq!(res, Err(Ok(ContractError::NotFunded)));
}

#[test]
fn transfer_lp_position_on_funded_self_loops_state() {
    let t = setup();
    let id = submit_funded(&t);
    let new_lp = Address::generate(&t.env);

    t.contract.transfer_lp_position(&id, &new_lp);
    // T7: ownership changes, status stays Funded.
    assert_eq!(status(&t, id), InvoiceStatus::Funded);
}
