#![cfg(test)]

//! Issue #1169 — cross-state invariant tests for partial funding.
//!
//! Partial funding couples three pieces of state that must never drift apart:
//! the aggregate counter `invoice.amount_funded`, the derived `InvoiceStatus`
//! (`PartiallyFunded` / `Funded`), and the per-funder ledger written by
//! `fund_invoice` (`get_invoice_funders`). Cancellation moves value back out of
//! the contract, and the fund queue decides *who* may fund — both must leave
//! the funding state untouched. These tests exercise those couplings together,
//! rather than each entry point in isolation.
//!
//! Invariants asserted (see the `B1`/`B3` balance invariants in `invoice.rs`):
//!
//! * INV-PF1 — `amount_funded == Σ funders[i].amount` at every observable
//!   point. The counter and the ledger advance by the same delta, so they can
//!   never disagree.
//! * INV-PF2 — while the invoice is in a fundable state, `status` is a pure
//!   function of `amount_funded` vs `amount`:
//!   `0 == amount_funded -> Pending`,
//!   `0 < amount_funded < amount -> PartiallyFunded`,
//!   `amount_funded == amount -> Funded`.
//! * INV-PF3 — `amount_funded <= amount`; a call that would overfund is
//!   rejected with `OverfundingRejected` and leaves the counter, the ledger and
//!   the status byte-for-byte unchanged.
//! * INV-PF4 — a repeat funder accumulates into a single ledger entry and the
//!   counter advances by exactly the same delta.
//! * INV-PF5 — cancelling a live invoice refunds each funder its net cost
//!   (net-zero) and does **not** rewrite `amount_funded` or the ledger.
//! * INV-PF6 — queue operations (join / resolve) never mutate `amount_funded`,
//!   the ledger, or the status; they only gate *who* may fund.
//! * INV-PF7 — a dispute round-trip preserves the partial counter/ledger and
//!   the restored invoice can still be funded to completion.

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, BytesN, Env, Vec,
};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30; // 30 days

struct TestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: Address,
    #[allow(dead_code)]
    admin: Address,
    freelancer: Address,
    payer: Address,
    lp_a: Address,
    lp_b: Address,
    lp_c: Address,
}

fn setup() -> TestEnv {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let lp_a = Address::generate(&env);
    let lp_b = Address::generate(&env);
    let lp_c = Address::generate(&env);

    let token_admin_addr = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin_addr);
    let token = token_contract.address();
    let token_admin = StellarAssetClient::new(&env, &token);

    for lp in [&lp_a, &lp_b, &lp_c] {
        token_admin.mint(lp, &(INVOICE_AMOUNT * 10));
    }
    token_admin.mint(&payer, &(INVOICE_AMOUNT * 10));

    let eurc = Address::generate(&env);
    let xlm_admin = Address::generate(&env);
    let xlm = env.register_stellar_asset_contract_v2(xlm_admin).address();

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);
    // Treasury reserve so cancellation refunds (paid out of the contract) can
    // always be covered.
    token_admin.mint(&contract.address, &(INVOICE_AMOUNT * 1000));

    contract.initialize(&admin, &token, &eurc, &xlm);

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
        lp_a,
        lp_b,
        lp_c,
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

fn fund(t: &TestEnv, lp: &Address, id: u64, amount: i128) {
    t.contract.fund_invoice(lp, &id, &amount, &false);
}

fn invoice(t: &TestEnv, id: u64) -> Invoice {
    t.contract.get_invoice(&id)
}

fn status(t: &TestEnv, id: u64) -> InvoiceStatus {
    invoice(t, id).status
}

/// Read the per-funder ledger from contract storage.
fn funders(t: &TestEnv, id: u64) -> Vec<(Address, i128)> {
    t.env
        .as_contract(&t.contract.address, || get_invoice_funders(&t.env, id))
}

fn funders_sum(t: &TestEnv, id: u64) -> i128 {
    let list = funders(t, id);
    let mut total = 0i128;
    for i in 0..list.len() {
        total += list.get(i).unwrap().1;
    }
    total
}

/// Net cost the contract pulls from an LP for a given gross fund amount.
fn net_cost(gross: i128) -> i128 {
    gross - gross * DISCOUNT_RATE as i128 / 10_000
}

fn advance_ledgers(t: &TestEnv, delta: u32) {
    let mut info = t.env.ledger().get();
    info.sequence_number += delta;
    info.timestamp += u64::from(delta) * 5;
    t.env.ledger().set(info);
}

// ================================================================
// INV-PF1 / INV-PF2 — counter, ledger and status stay a single truth
// ================================================================

#[test]
fn zero_funding_is_pending_with_empty_ledger() {
    let t = setup();
    let id = submit(&t);

    let inv = invoice(&t, id);
    assert_eq!(inv.status, InvoiceStatus::Pending); // INV-PF2
    assert_eq!(inv.amount_funded, 0);
    assert_eq!(funders_sum(&t, id), 0); // INV-PF1
    assert_eq!(funders(&t, id).len(), 0);
    assert!(inv.funder.is_none());
}

#[test]
fn partial_funding_keeps_counter_ledger_and_status_in_lockstep() {
    let t = setup();
    let id = submit(&t);

    // First partial contribution.
    fund(&t, &t.lp_a, id, INVOICE_AMOUNT / 4);
    let inv = invoice(&t, id);
    assert_eq!(inv.status, InvoiceStatus::PartiallyFunded); // INV-PF2
    assert_eq!(inv.amount_funded, INVOICE_AMOUNT / 4);
    assert_eq!(funders_sum(&t, id), INVOICE_AMOUNT / 4); // INV-PF1
    assert_eq!(funders(&t, id).len(), 1);
    // Still partially funded: no payout has happened, so `funder` stays unset.
    assert!(inv.funder.is_none());

    // Second partial contribution from a different LP.
    fund(&t, &t.lp_b, id, INVOICE_AMOUNT / 2);
    let inv = invoice(&t, id);
    assert_eq!(inv.status, InvoiceStatus::PartiallyFunded);
    assert_eq!(inv.amount_funded, INVOICE_AMOUNT / 4 + INVOICE_AMOUNT / 2);
    assert_eq!(funders_sum(&t, id), inv.amount_funded); // INV-PF1
    assert_eq!(funders(&t, id).len(), 2);

    // Final contribution completes funding.
    fund(&t, &t.lp_c, id, INVOICE_AMOUNT - inv.amount_funded);
    let inv = invoice(&t, id);
    assert_eq!(inv.status, InvoiceStatus::Funded); // INV-PF2
    assert_eq!(inv.amount_funded, INVOICE_AMOUNT);
    assert_eq!(funders_sum(&t, id), INVOICE_AMOUNT); // INV-PF1
    assert_eq!(funders(&t, id).len(), 3);
    assert_eq!(inv.funder, Some(t.lp_c.clone())); // completing LP recorded
}

#[test]
fn exact_remainder_reaches_funded_at_the_boundary() {
    let t = setup();
    let id = submit(&t);

    // One stroop short of complete -> still partial.
    fund(&t, &t.lp_a, id, INVOICE_AMOUNT - 1);
    assert_eq!(status(&t, id), InvoiceStatus::PartiallyFunded);
    assert_eq!(invoice(&t, id).amount_funded, INVOICE_AMOUNT - 1);

    // The single remaining stroop flips it to Funded.
    fund(&t, &t.lp_b, id, 1);
    assert_eq!(status(&t, id), InvoiceStatus::Funded); // INV-PF2 boundary
    assert_eq!(invoice(&t, id).amount_funded, INVOICE_AMOUNT);
    assert_eq!(funders_sum(&t, id), INVOICE_AMOUNT); // INV-PF1
}

// ================================================================
// INV-PF4 — repeat funder accumulates in a single ledger entry
// ================================================================

#[test]
fn same_funder_accumulates_into_one_ledger_entry() {
    let t = setup();
    let id = submit(&t);

    fund(&t, &t.lp_a, id, INVOICE_AMOUNT / 4);
    fund(&t, &t.lp_a, id, INVOICE_AMOUNT / 4);

    let inv = invoice(&t, id);
    assert_eq!(inv.status, InvoiceStatus::PartiallyFunded);
    assert_eq!(inv.amount_funded, INVOICE_AMOUNT / 2);

    let list = funders(&t, id);
    assert_eq!(list.len(), 1, "repeat funder must not add a second entry");
    assert_eq!(list.get(0).unwrap().0, t.lp_a);
    assert_eq!(list.get(0).unwrap().1, INVOICE_AMOUNT / 2); // INV-PF4
    assert_eq!(funders_sum(&t, id), inv.amount_funded); // INV-PF1
}

// ================================================================
// INV-PF3 — overfunding is rejected atomically
// ================================================================

#[test]
fn overfunding_rejected_and_state_untouched() {
    let t = setup();
    let id = submit(&t);
    fund(&t, &t.lp_a, id, INVOICE_AMOUNT / 2);

    let before = invoice(&t, id);
    let ledger_before = funders(&t, id);

    // Would push amount_funded past amount.
    let res = t
        .contract
        .try_fund_invoice(&t.lp_b, &id, &(INVOICE_AMOUNT / 2 + 1), &false);
    assert_eq!(res, Err(Ok(ContractError::OverfundingRejected)));

    let after = invoice(&t, id);
    assert_eq!(after.status, InvoiceStatus::PartiallyFunded);
    assert_eq!(after.amount_funded, before.amount_funded); // counter intact
    assert_eq!(funders(&t, id), ledger_before); // ledger intact
    assert_eq!(funders_sum(&t, id), after.amount_funded); // INV-PF1
}

#[test]
fn funding_a_fully_funded_invoice_is_already_funded_not_overfunded() {
    let t = setup();
    let id = submit(&t);
    fund(&t, &t.lp_a, id, INVOICE_AMOUNT);

    let res = t.contract.try_fund_invoice(&t.lp_b, &id, &1, &false);
    assert_eq!(res, Err(Ok(ContractError::AlreadyFunded)));
    assert_eq!(invoice(&t, id).amount_funded, INVOICE_AMOUNT); // INV-PF3
    assert_eq!(funders_sum(&t, id), INVOICE_AMOUNT);
}

// ================================================================
// INV-PF5 — cancellation refunds funders without rewriting funding state
// ================================================================

#[test]
fn cancel_pending_leaves_counter_and_ledger_at_zero() {
    let t = setup();
    let id = submit(&t);

    t.contract.cancel_invoice(&id);

    let inv = invoice(&t, id);
    assert_eq!(inv.status, InvoiceStatus::Cancelled);
    assert_eq!(inv.amount_funded, 0);
    assert_eq!(funders_sum(&t, id), 0);
    assert_eq!(funders(&t, id).len(), 0);
}

#[test]
fn cancel_partial_refunds_every_funder_net_zero_and_preserves_ledger() {
    let t = setup();
    let id = submit(&t);
    let fund_a = INVOICE_AMOUNT / 3;
    let fund_b = INVOICE_AMOUNT / 4;
    fund(&t, &t.lp_a, id, fund_a);
    fund(&t, &t.lp_b, id, fund_b);

    let inv_before = invoice(&t, id);
    let ledger_before = funders(&t, id);

    let token = TokenClient::new(&t.env, &t.token);
    let a_before = token.balance(&t.lp_a);
    let b_before = token.balance(&t.lp_b);

    t.contract.cancel_invoice(&id);

    // Everyone made whole (refund exactly offsets the funding cost).
    assert_eq!(token.balance(&t.lp_a) - a_before, net_cost(fund_a));
    assert_eq!(token.balance(&t.lp_b) - b_before, net_cost(fund_b));

    let inv_after = invoice(&t, id);
    assert_eq!(inv_after.status, InvoiceStatus::Cancelled);
    // Cancellation is not a funding event: the counter and ledger are preserved.
    assert_eq!(inv_after.amount_funded, inv_before.amount_funded);
    assert_eq!(funders(&t, id), ledger_before);
    assert_eq!(funders_sum(&t, id), inv_after.amount_funded); // INV-PF1 holds post-cancel
}

#[test]
fn cancel_fully_funded_rejected_and_counter_preserved() {
    let t = setup();
    let id = submit(&t);
    fund(&t, &t.lp_a, id, INVOICE_AMOUNT);

    let res = t.contract.try_cancel_invoice(&id);
    assert_eq!(res, Err(Ok(ContractError::AlreadyFunded)));

    let inv = invoice(&t, id);
    assert_eq!(inv.status, InvoiceStatus::Funded);
    assert_eq!(inv.amount_funded, INVOICE_AMOUNT);
    assert_eq!(funders_sum(&t, id), INVOICE_AMOUNT);
}

// ================================================================
// INV-PF6 — the fund queue gates who may fund but never moves funding state
// ================================================================

#[test]
fn queue_join_allowed_while_pending_and_partial_without_mutating_funding() {
    let t = setup();
    let id = submit(&t);

    // Join while Pending.
    t.contract.join_fund_queue(&t.lp_a, &id);
    let inv = invoice(&t, id);
    assert_eq!(inv.status, InvoiceStatus::Pending);
    assert_eq!(inv.amount_funded, 0);
    assert_eq!(funders_sum(&t, id), 0);

    // Partial funding, then join while PartiallyFunded.
    fund(&t, &t.lp_b, id, INVOICE_AMOUNT / 2);
    t.contract.join_fund_queue(&t.lp_c, &id);

    let inv = invoice(&t, id);
    assert_eq!(inv.status, InvoiceStatus::PartiallyFunded);
    assert_eq!(inv.amount_funded, INVOICE_AMOUNT / 2); // unaffected by joins
    assert_eq!(funders_sum(&t, id), INVOICE_AMOUNT / 2);
    assert_eq!(funders(&t, id).len(), 1);
}

#[test]
fn queue_join_rejected_once_funded() {
    let t = setup();
    let id = submit(&t);
    fund(&t, &t.lp_a, id, INVOICE_AMOUNT);

    let res = t.contract.try_join_fund_queue(&t.lp_b, &id);
    assert_eq!(res, Err(Ok(ContractError::AlreadyFunded)));
    assert_eq!(status(&t, id), InvoiceStatus::Funded);
}

#[test]
fn queue_resolution_is_side_effect_free_then_approved_lp_funds_partially() {
    let t = setup();
    let id = submit(&t);
    t.contract.join_fund_queue(&t.lp_a, &id);
    t.contract.join_fund_queue(&t.lp_b, &id);

    advance_ledgers(&t, QUEUE_DELAY_LEDGERS);
    let winner = t.contract.resolve_fund_queue(&id);
    let loser = if winner == t.lp_a { t.lp_b.clone() } else { t.lp_a.clone() };

    // Resolution announces a winner but does not fund anything.
    let inv = invoice(&t, id);
    assert_eq!(inv.status, InvoiceStatus::Pending); // INV-PF6
    assert_eq!(inv.amount_funded, 0);
    assert_eq!(funders_sum(&t, id), 0);

    // A non-approved LP cannot fund.
    let res = t
        .contract
        .try_fund_invoice(&loser, &id, &(INVOICE_AMOUNT / 2), &false);
    assert_eq!(res, Err(Ok(ContractError::NotApprovedFunder)));
    assert_eq!(invoice(&t, id).amount_funded, 0); // still untouched

    // The approved LP funds partially; counter and ledger now agree.
    fund(&t, &winner, id, INVOICE_AMOUNT / 2);
    let inv = invoice(&t, id);
    assert_eq!(inv.status, InvoiceStatus::PartiallyFunded);
    assert_eq!(inv.amount_funded, INVOICE_AMOUNT / 2);
    assert_eq!(funders_sum(&t, id), INVOICE_AMOUNT / 2); // INV-PF1
}

#[test]
fn queue_resolution_blocked_once_fully_funded() {
    let t = setup();
    let id = submit(&t);
    t.contract.join_fund_queue(&t.lp_a, &id);
    fund(&t, &t.lp_b, id, INVOICE_AMOUNT); // funding is allowed without resolution

    advance_ledgers(&t, QUEUE_DELAY_LEDGERS);
    let res = t.contract.try_resolve_fund_queue(&id);
    assert_eq!(res, Err(Ok(ContractError::AlreadyFunded)));
    assert_eq!(invoice(&t, id).amount_funded, INVOICE_AMOUNT);
}

// ================================================================
// INV-PF7 — a dispute round-trip preserves the partial funding state
// ================================================================

#[test]
fn dispute_round_trip_preserves_partial_state_and_can_complete() {
    let t = setup();
    let id = submit(&t);
    fund(&t, &t.lp_a, id, INVOICE_AMOUNT / 3);

    let funded_before = invoice(&t, id).amount_funded;
    let ledger_before = funders(&t, id);

    // Payer disputes, admin resolves in the freelancer's favour (resolution 2).
    t.contract.dispute_invoice(&id, &BytesN::from_array(&t.env, &[9u8; 32]));
    assert_eq!(status(&t, id), InvoiceStatus::Disputed);
    t.contract
        .resolve_dispute(&id, &BytesN::from_array(&t.env, &[8u8; 32]), &2);

    let restored = invoice(&t, id);
    assert_eq!(restored.status, InvoiceStatus::PartiallyFunded); // INV-PF2/PF7
    assert_eq!(restored.amount_funded, funded_before);
    assert_eq!(funders(&t, id), ledger_before);
    assert_eq!(funders_sum(&t, id), funded_before); // INV-PF1

    // The remaining balance can still be funded to completion.
    fund(&t, &t.lp_b, id, INVOICE_AMOUNT - funded_before);
    let done = invoice(&t, id);
    assert_eq!(done.status, InvoiceStatus::Funded);
    assert_eq!(done.amount_funded, INVOICE_AMOUNT);
    assert_eq!(funders_sum(&t, id), INVOICE_AMOUNT);
}

#[test]
fn claim_default_on_partially_funded_is_rejected_and_leaves_state() {
    let t = setup();
    let id = submit(&t);
    fund(&t, &t.lp_a, id, INVOICE_AMOUNT / 2);

    let res = t.contract.try_claim_default(&t.lp_a, &id);
    assert_eq!(res, Err(Ok(ContractError::NotFunded)));

    let inv = invoice(&t, id);
    assert_eq!(inv.status, InvoiceStatus::PartiallyFunded);
    assert_eq!(inv.amount_funded, INVOICE_AMOUNT / 2);
    assert_eq!(funders_sum(&t, id), INVOICE_AMOUNT / 2);
}
