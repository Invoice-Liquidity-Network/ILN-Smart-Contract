#![cfg(test)]

//! Issue #1171 — default & appeal authorization and the single canonical outcome.
//!
//! The default/appeal flow is the only place a funded invoice can lose value on
//! the LP side without a payer settlement. Three entry points cooperate:
//!
//! * `claim_default(funder, invoice_id)` — LP only. Turns a `Funded` invoice into
//!   `Defaulted`, refunds each funder their discounted principal exactly once,
//!   and applies exactly one reputation penalty to the payer.
//! * `appeal_default(invoice_id, evidence_hash)` — payer only (auth derived from
//!   the invoice, not a caller argument). `Defaulted -> Appealed`, once, within
//!   the appeal window. Moves no tokens.
//! * `resolve_appeal(invoice_id, upheld)` — admin only. `Appealed -> Defaulted`
//!   in **both** branches. Moves no tokens. `upheld=true` additionally restores
//!   the payer's pre-default reputation.
//!
//! "One canonical outcome" means: whatever the combination of {appeal filed or
//! not} × {appeal upheld or rejected}, the invoice converges to exactly one
//! economic state — `Defaulted`, with the LP refunded exactly once and the payer
//! carrying at most one default penalty. These tests pin that property together
//! with the caller-authorization rules that gate each transition.
//!
//! Invariants asserted (see docs/default-appeal-authorization.md):
//!
//! * INV-AUTH1 — `claim_default` may only be driven by an address that is in the
//!   invoice's funder ledger, and that address must authorize the call.
//! * INV-AUTH2 — `appeal_default` requires the invoice payer's authorization;
//!   no other address can satisfy it.
//! * INV-AUTH3 — `resolve_appeal` requires the current admin's authorization.
//! * INV-AUTH4 — `claim_default` requires the `Funded` status and `now >=
//!   due_date`; it fires exactly once per invoice.
//! * INV-AUTH5 — every appeal resolution path (`upheld` and rejected) returns
//!   the invoice to `Defaulted` and never re-runs the refund.
//! * INV-AUTH6 — reputation ends the flow in exactly one of two states: the
//!   penalty is either fully restored (upheld) or fully retained (rejected);
//!   never partially applied and never double-applied.

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::{Client as TokenClient, StellarAssetClient},
    Address, BytesN, Env, IntoVal,
};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30; // 30 days

#[allow(dead_code)]
struct AuthTestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: TokenClient<'static>,
    admin: Address,
    freelancer: Address,
    payer: Address,
    funder: Address,
    /// An address that has neither funded the invoice nor signed anything.
    stranger: Address,
}

fn setup() -> AuthTestEnv {
    let env = Env::default();
    env.mock_all_auths();

    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_addr = usdc_id.address();

    let token = TokenClient::new(&env, &usdc_addr);
    let token_admin = StellarAssetClient::new(&env, &usdc_addr);

    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let funder = Address::generate(&env);
    let stranger = Address::generate(&env);

    token_admin.mint(&funder, &(INVOICE_AMOUNT * 10));
    token_admin.mint(&payer, &(INVOICE_AMOUNT * 10));

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);
    token_admin.mint(&contract.address, &(INVOICE_AMOUNT * 100));

    let xlm_admin = Address::generate(&env);
    let xlm_addr = env
        .register_stellar_asset_contract_v2(xlm_admin)
        .address();

    // usdc_admin acts as the contract admin.
    let eurc_addr = Address::generate(&env);
    contract.initialize(&usdc_admin, &usdc_addr, &eurc_addr, &xlm_addr);

    let mut ledger = env.ledger().get();
    ledger.timestamp = 1_700_000_000;
    env.ledger().set(ledger);

    AuthTestEnv {
        env,
        contract,
        token,
        admin: usdc_admin,
        freelancer,
        payer,
        funder,
        stranger,
    }
}

fn due_date(t: &AuthTestEnv) -> u64 {
    t.env.ledger().timestamp() + DUE_DATE_OFFSET
}

fn submit(t: &AuthTestEnv) -> u64 {
    t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date(t),
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    )
}

fn fund(t: &AuthTestEnv, id: u64, amount: i128) {
    t.contract
        .fund_invoice(&t.funder, &id, &amount, &false);
}

fn advance_past_due(t: &AuthTestEnv) {
    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 1;
    t.env.ledger().set(ledger);
}

/// Submit, fully fund, advance past due date and mark default. The invoice is
/// `Defaulted` on return.
fn make_defaulted(t: &AuthTestEnv) -> u64 {
    let id = submit(t);
    fund(t, id, INVOICE_AMOUNT);
    advance_past_due(t);
    t.contract.claim_default(&t.funder, &id);
    id
}

fn status(t: &AuthTestEnv, id: u64) -> InvoiceStatus {
    t.contract.get_invoice(&id).status
}

/// Refund a funder of `amount` receives on default: principal minus the discount
/// retained by the protocol, matching the arithmetic in `claim_default`.
fn expected_refund(amount: i128) -> i128 {
    amount - amount * DISCOUNT_RATE as i128 / 10_000
}

fn evidence_hash(env: &Env) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[0] = 0xde;
    bytes[1] = 0xad;
    bytes[31] = 0xff;
    BytesN::from_array(env, &bytes)
}

// ── claim_default authorization ───────────────────────────────────────────────

/// A caller who never funded this invoice cannot drive its default, even though
/// its authorization succeeds — the funder-ledger membership check rejects it.
#[test]
fn claim_default_rejects_caller_not_in_funder_ledger() {
    let t = setup();
    let id = submit(&t);
    fund(&t, id, INVOICE_AMOUNT);
    advance_past_due(&t);

    let res = t.contract.try_claim_default(&t.stranger, &id);
    assert_eq!(res, Err(Ok(ContractError::Unauthorized)));
    assert_eq!(status(&t, id), InvoiceStatus::Funded); // INV-AUTH1
}

/// The funder must actually authorize the call; an unsigned caller is rejected.
#[test]
fn claim_default_requires_funder_authorization() {
    let t = setup();
    let id = submit(&t);
    fund(&t, id, INVOICE_AMOUNT);
    advance_past_due(&t);

    // Restrict auths to the stranger only — the real funder never signs.
    t.env.mock_auths(&[MockAuth {
        address: &t.stranger,
        invoke: &MockAuthInvoke {
            contract: &t.contract.address,
            fn_name: "claim_default",
            args: (t.funder.clone(), id).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);

    let res = t.contract.try_claim_default(&t.funder, &id);
    assert!(res.is_err(), "funder must authorize claim_default"); // INV-AUTH1
    assert_eq!(status(&t, id), InvoiceStatus::Funded);
}

// ── claim_default preconditions ───────────────────────────────────────────────

#[test]
fn claim_default_before_due_date_is_not_yet_defaulted() {
    let t = setup();
    let id = submit(&t);
    fund(&t, id, INVOICE_AMOUNT);
    // Do NOT advance time: still before due_date.

    let res = t.contract.try_claim_default(&t.funder, &id);
    assert_eq!(res, Err(Ok(ContractError::NotYetDefaulted)));
    assert_eq!(status(&t, id), InvoiceStatus::Funded);
}

/// `claim_default` only liquidates a *fully* funded invoice. A PartiallyFunded
/// invoice — which does have a funder in the ledger, so the membership check
/// passes — is rejected with `NotFunded`.
#[test]
fn claim_default_on_partially_funded_is_not_funded() {
    let t = setup();
    let id = submit(&t);
    fund(&t, id, INVOICE_AMOUNT / 2);
    assert_eq!(status(&t, id), InvoiceStatus::PartiallyFunded);
    advance_past_due(&t);

    let res = t.contract.try_claim_default(&t.funder, &id);
    assert_eq!(res, Err(Ok(ContractError::NotFunded))); // INV-AUTH4
}

#[test]
fn claim_default_is_once_only() {
    let t = setup();
    let id = make_defaulted(&t);

    let res = t.contract.try_claim_default(&t.funder, &id);
    assert_eq!(res, Err(Ok(ContractError::InvoiceDefaulted))); // INV-AUTH4
    assert_eq!(status(&t, id), InvoiceStatus::Defaulted);
}

// ── appeal_default authorization ──────────────────────────────────────────────

/// `appeal_default` derives its authorization from the invoice's payer. If only
/// a different address signs, the payer's `require_auth()` fails.
#[test]
fn appeal_default_requires_payer_authorization() {
    let t = setup();
    let id = make_defaulted(&t);

    t.env.mock_auths(&[MockAuth {
        address: &t.stranger,
        invoke: &MockAuthInvoke {
            contract: &t.contract.address,
            fn_name: "appeal_default",
            args: (id, evidence_hash(&t.env)).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);

    let res = t.contract.try_appeal_default(&id, &evidence_hash(&t.env));
    assert!(res.is_err(), "only the payer may appeal"); // INV-AUTH2
    assert_eq!(status(&t, id), InvoiceStatus::Defaulted);
}

#[test]
fn appeal_default_only_from_defaulted() {
    let t = setup();
    let id = submit(&t);
    fund(&t, id, INVOICE_AMOUNT);
    advance_past_due(&t);
    // Not defaulted yet — still Funded.
    let res = t
        .contract
        .try_appeal_default(&id, &evidence_hash(&t.env));
    assert_eq!(res, Err(Ok(ContractError::NotDefaulted)));
}

// ── resolve_appeal authorization ──────────────────────────────────────────────

#[test]
fn resolve_appeal_requires_admin_authorization() {
    let t = setup();
    let id = make_defaulted(&t);
    t.contract.appeal_default(&id, &evidence_hash(&t.env));

    t.env.mock_auths(&[MockAuth {
        address: &t.stranger,
        invoke: &MockAuthInvoke {
            contract: &t.contract.address,
            fn_name: "resolve_appeal",
            args: (id, true).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);

    let res = t.contract.try_resolve_appeal(&id, &true);
    assert!(res.is_err(), "only the admin may resolve an appeal"); // INV-AUTH3
    assert_eq!(status(&t, id), InvoiceStatus::Appealed);
}

// ── Canonical outcome: refunded exactly once ──────────────────────────────────

#[test]
fn plain_default_refunds_lp_once_and_penalizes_payer_once() {
    let t = setup();
    let initial_score = t.contract.payer_score(&t.payer);

    let id = submit(&t);
    fund(&t, id, INVOICE_AMOUNT);
    let funded_balance = t.token.balance(&t.funder);
    advance_past_due(&t);
    t.contract.claim_default(&t.funder, &id);

    assert_eq!(status(&t, id), InvoiceStatus::Defaulted);
    assert_eq!(
        t.token.balance(&t.funder) - funded_balance,
        expected_refund(INVOICE_AMOUNT),
        "LP receives principal minus discount exactly once"
    );
    assert_eq!(t.contract.payer_score(&t.payer), initial_score - 5);
    assert_eq!(
        t.contract.get_reputation(&t.payer).invoices_defaulted,
        1
    ); // INV-AUTH4 / INV-AUTH6
}

#[test]
fn upheld_appeal_restores_reputation_without_a_second_refund() {
    let t = setup();
    let initial_score = t.contract.payer_score(&t.payer);

    let id = make_defaulted(&t);
    let balance_after_default = t.token.balance(&t.funder);
    assert_eq!(t.contract.payer_score(&t.payer), initial_score - 5);

    t.contract.appeal_default(&id, &evidence_hash(&t.env));
    t.contract.resolve_appeal(&id, &true);

    assert_eq!(status(&t, id), InvoiceStatus::Defaulted); // INV-AUTH5
    assert_eq!(t.contract.payer_score(&t.payer), initial_score); // INV-AUTH6
    assert_eq!(
        t.contract.get_reputation(&t.payer).invoices_defaulted,
        0
    );
    assert_eq!(
        t.token.balance(&t.funder),
        balance_after_default,
        "resolution must not move tokens"
    ); // INV-AUTH5
}

#[test]
fn rejected_appeal_keeps_penalty_without_a_second_refund() {
    let t = setup();
    let initial_score = t.contract.payer_score(&t.payer);

    let id = make_defaulted(&t);
    let balance_after_default = t.token.balance(&t.funder);

    t.contract.appeal_default(&id, &evidence_hash(&t.env));
    t.contract.resolve_appeal(&id, &false);

    assert_eq!(status(&t, id), InvoiceStatus::Defaulted); // INV-AUTH5
    assert_eq!(t.contract.payer_score(&t.payer), initial_score - 5);
    assert_eq!(
        t.contract.get_reputation(&t.payer).invoices_defaulted,
        1
    );
    assert_eq!(
        t.token.balance(&t.funder),
        balance_after_default,
        "resolution must not move tokens"
    ); // INV-AUTH5
}

/// The appeal record is the one-shot marker: once an appeal has been resolved
/// the invoice is `Defaulted` again, but a second appeal is still rejected.
#[test]
fn appeal_cannot_be_refiled_after_resolution() {
    let t = setup();
    let id = make_defaulted(&t);
    t.contract.appeal_default(&id, &evidence_hash(&t.env));
    t.contract.resolve_appeal(&id, &true);

    assert_eq!(status(&t, id), InvoiceStatus::Defaulted);
    let res = t
        .contract
        .try_appeal_default(&id, &evidence_hash(&t.env));
    assert_eq!(res, Err(Ok(ContractError::AlreadyAppealed))); // INV-AUTH5
}
