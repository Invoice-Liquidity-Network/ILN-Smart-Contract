#![cfg(test)]

mod test_context;
use invoice_liquidity::{ContractError, InvoiceStatus, ReferralCode};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::Client as TokenClient,
    Address,
};

use test_context::TestContext;

const _DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30; // 30 days
const DISCOUNT_RATE: u32 = 300; // 3.00%
const INVOICE_AMOUNT: i128 = 1_000_000_000;

fn setup() -> TestContext {
    TestContext::new()
}

fn due_date(ctx: &TestContext) -> u64 {
    ctx.default_due_date()
}

fn expected_discount(amount: i128) -> i128 {
    amount * DISCOUNT_RATE as i128 / 10_000
}

fn assert_lifecycle_for_token(
    token_name: &str,
    token: &TokenClient<'static>,
    ctx: &TestContext,
    amount: i128,
) {
    // 1. Submit
    let invoice_id = ctx.contract.submit_invoice(
        &ctx.submitter,
        &ctx.payer,
        &amount,
        &due_date(ctx),
        &DISCOUNT_RATE,
        &token.address,
        &ReferralCode::None,
    );

    let invoice = ctx.contract.get_invoice(&invoice_id);
    assert_eq!(
        invoice.token, token.address,
        "{token_name} invoice should persist its token address"
    );
    assert_eq!(invoice.status, InvoiceStatus::Pending);

    let freelancer_before = token.balance(&ctx.submitter);
    let lp_before = token.balance(&ctx.lp);
    let payer_before = token.balance(&ctx.payer);

    // 2. Fund
    ctx.contract
        .fund_invoice(&ctx.lp, &invoice_id, &amount, &false);

    let discount = expected_discount(amount);
    let expected_payout = amount - discount;

    assert_eq!(
        token.balance(&ctx.submitter) - freelancer_before,
        expected_payout,
        "{token_name} freelancer should receive amount minus discount"
    );

    assert_eq!(
        lp_before - token.balance(&ctx.lp),
        expected_payout,
        "{token_name} LP should pay the payout amount"
    );

    let invoice_funded = ctx.contract.get_invoice(&invoice_id);
    assert_eq!(invoice_funded.status, InvoiceStatus::Funded);

    // 3. Paid
    ctx.contract.mark_paid(&invoice_id, &amount);

    assert_eq!(
        token.balance(&ctx.lp) - lp_before,
        discount,
        "{token_name} LP should earn yield"
    );

    assert_eq!(
        payer_before - token.balance(&ctx.payer),
        amount,
        "{token_name} payer should pay full amount"
    );

    let invoice_paid = ctx.contract.get_invoice(&invoice_id);
    assert_eq!(invoice_paid.status, InvoiceStatus::Paid);
}

#[test]
fn test_integration_lifecycle_usdc() {
    let ctx = setup();
    assert_lifecycle_for_token("USDC", &ctx.usdc, &ctx, INVOICE_AMOUNT);
}

#[test]
fn test_integration_lifecycle_eurc() {
    let ctx = setup();
    assert_lifecycle_for_token("EURC", &ctx.eurc, &ctx, INVOICE_AMOUNT);
}

#[test]
fn test_integration_lifecycle_xlm() {
    let ctx = setup();
    assert_lifecycle_for_token("XLM", &ctx.xlm, &ctx, INVOICE_AMOUNT);
}

#[test]
fn test_integration_submit_unapproved_token_fails() {
    let ctx = setup();
    let unapproved_admin = Address::generate(&ctx.env);
    let unapproved_id = ctx.env.register_stellar_asset_contract_v2(unapproved_admin);
    let token_address = unapproved_id.address();

    let result = ctx.contract.try_submit_invoice(
        &ctx.submitter,
        &ctx.payer,
        &INVOICE_AMOUNT,
        &due_date(&ctx),
        &100,
        &token_address,
        &ReferralCode::None,
    );

    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}

#[test]
fn test_integration_fund_removed_token_fails() {
    let ctx = setup();

    // Submit invoice with EURC (currently approved)
    let invoice_id = ctx.contract.submit_invoice(
        &ctx.submitter,
        &ctx.payer,
        &INVOICE_AMOUNT,
        &due_date(&ctx),
        &100,
        &ctx.eurc.address,
        &ReferralCode::None,
    );

    // Admin removes EURC from approved list. Advance the ledger past
    // remove_token's rate-limit cooldown first: the last-call ledger for a
    // rate-limited function defaults to 0 when never called, and
    // TestContext::new() starts the ledger at sequence 100 (below the
    // 120-ledger cooldown), so calling remove_token() immediately after
    // setup() incorrectly trips the cooldown on its very first-ever call.
    // See tests_oracle_registry.rs's `advance_past_rate_limit_cooldown` for
    // the same workaround applied elsewhere in the ILN contract's own test
    // suite.
    let mut ledger_info = ctx.env.ledger().get();
    ledger_info.sequence_number += invoice_liquidity::constants::DEFAULT_RATE_LIMIT_LEDGERS as u32;
    ctx.env.ledger().set(ledger_info);
    ctx.contract.remove_token(&ctx.eurc.address);

    // LP tries to fund it - should fail with Unauthorized
    let result = ctx
        .contract
        .try_fund_invoice(&ctx.lp, &invoice_id, &INVOICE_AMOUNT, &false);
    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}
