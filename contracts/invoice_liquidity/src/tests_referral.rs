#![cfg(test)]

use super::*;
use crate::test::setup;
use soroban_sdk::BytesN;

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30;

#[test]
fn test_referral_count_increments_on_submission() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let code = BytesN::from_array(&t.env, &[2u8; 32]);

    t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::Present(code.clone()),
    );

    let stats = t.contract.get_referral_stats(&code);
    assert_eq!(stats, 1);
}

#[test]
fn test_referral_count_returns_zero_for_unknown_code() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let known_code = BytesN::from_array(&t.env, &[1u8; 32]);
    let unknown_code = BytesN::from_array(&t.env, &[9u8; 32]);

    t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::Present(known_code),
    );

    let stats = t.contract.get_referral_stats(&unknown_code);
    assert_eq!(stats, 0);
}

#[test]
fn test_referral_count_zero_when_no_submissions() {
    let t = setup();
    let code = BytesN::from_array(&t.env, &[5u8; 32]);

    let stats = t.contract.get_referral_stats(&code);
    assert_eq!(stats, 0);
}

#[test]
fn test_submit_invoice_without_referral_does_not_increment_stats() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let code = BytesN::from_array(&t.env, &[1u8; 32]);

    t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    let stats = t.contract.get_referral_stats(&code);
    assert_eq!(stats, 0);
}

#[test]
fn test_batch_submission_counts_referrals_correctly() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let code = BytesN::from_array(&t.env, &[7u8; 32]);

    let mut batch = soroban_sdk::Vec::new(&t.env);
    for _ in 0..3 {
        batch.push_back(InvoiceParams {
            freelancer: t.freelancer.clone(),
            payer: t.payer.clone(),
            amount: INVOICE_AMOUNT,
            due_date,
            discount_rate: DISCOUNT_RATE,
            token: t.token.address.clone(),
            referral_code: ReferralCode::Present(code.clone()),
        });
    }
    batch.push_back(InvoiceParams {
        freelancer: t.freelancer.clone(),
        payer: t.payer.clone(),
        amount: INVOICE_AMOUNT,
        due_date,
        discount_rate: DISCOUNT_RATE,
        token: t.token.address.clone(),
        referral_code: ReferralCode::None,
    });

    let result = t.contract.try_submit_invoices_batch(&batch);
    assert!(result.is_ok());

    let stats = t.contract.get_referral_stats(&code);
    assert_eq!(stats, 3);
}
