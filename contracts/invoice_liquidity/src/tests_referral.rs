#![cfg(test)]

use super::*;
use crate::test::setup;
use soroban_sdk::BytesN;

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30;

#[test]
fn test_submit_invoice_without_referral_does_not_increment_stats() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    // create a code to query
    let code = BytesN::from_array(&t.env, &[1u8; 32]);

    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    // stats for arbitrary code should be zero
    let stats = t.contract.get_referral_stats(&code);
    assert_eq!(stats, 0);
}

#[test]
fn test_submit_invoice_with_referral_increments_stats() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let code = BytesN::from_array(&t.env, &[2u8; 32]);

    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &Some(code.clone()),
    );

    let stats = t.contract.get_referral_stats(&code);
    assert_eq!(stats, 1);
}
