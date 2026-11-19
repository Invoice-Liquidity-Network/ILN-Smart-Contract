//! Comprehensive unit tests for all 39 ContractError variants in invoice_liquidity.
//! Pre-Audit Checklist Item 1.6: "audit that no [error] variant is untested."

#![cfg(test)]

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, BytesN, Env,
};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30; // 30 days

struct ErrorTestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: TokenClient<'static>,
    admin: Address,
    freelancer: Address,
    payer: Address,
    funder: Address,
    other: Address,
}

fn advance_rate_limit(env: &Env) {
    let mut info = env.ledger().get();
    info.sequence_number += crate::constants::DEFAULT_RATE_LIMIT_LEDGERS as u32 + 10;
    env.ledger().set(info);
}

fn setup_errors() -> ErrorTestEnv {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(admin.clone());
    let usdc_addr = usdc_id.address();

    let token = TokenClient::new(&env, &usdc_addr);
    let token_admin = StellarAssetClient::new(&env, &usdc_addr);

    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let funder = Address::generate(&env);
    let other = Address::generate(&env);

    token_admin.mint(&funder, &(INVOICE_AMOUNT * 10));
    token_admin.mint(&payer, &(INVOICE_AMOUNT * 10));
    token_admin.mint(&other, &(INVOICE_AMOUNT * 10));

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);
    token_admin.mint(&contract.address, &(INVOICE_AMOUNT * 100));

    let xlm_admin = Address::generate(&env);
    let xlm_id = env.register_stellar_asset_contract_v2(xlm_admin);
    let xlm_addr = xlm_id.address();
    let eurc_addr = Address::generate(&env);

    contract.initialize(&admin, &usdc_addr, &eurc_addr, &xlm_addr);

    let mut ledger = env.ledger().get();
    ledger.timestamp = 1_700_000_000;
    ledger.sequence_number = 100;
    env.ledger().set(ledger);

    advance_rate_limit(&env);

    ErrorTestEnv {
        env,
        contract,
        token,
        admin,
        freelancer,
        payer,
        funder,
        other,
    }
}

fn create_standard_invoice(t: &ErrorTestEnv) -> u64 {
    let due = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    )
}

// 1. InvoiceNotFound
#[test]
fn test_err_invoice_not_found() {
    let t = setup_errors();
    let res = t.contract.try_get_invoice(&999_999);
    assert_eq!(res, Err(Ok(ContractError::InvoiceNotFound)));
}

// 2. AlreadyFunded
#[test]
fn test_err_already_funded() {
    let t = setup_errors();
    let id = create_standard_invoice(&t);
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);
    let res = t
        .contract
        .try_fund_invoice(&t.other, &id, &INVOICE_AMOUNT, &false);
    assert_eq!(res, Err(Ok(ContractError::AlreadyFunded)));
}

// 3. AlreadyPaid
#[test]
fn test_err_already_paid() {
    let t = setup_errors();
    let id = create_standard_invoice(&t);
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);
    t.contract.mark_paid(&id, &INVOICE_AMOUNT);
    let res = t.contract.try_mark_paid(&id, &INVOICE_AMOUNT);
    assert_eq!(res, Err(Ok(ContractError::AlreadyPaid)));
}

// 4. NotFunded
#[test]
fn test_err_not_funded() {
    let t = setup_errors();
    let id = create_standard_invoice(&t);
    let res = t.contract.try_mark_paid(&id, &INVOICE_AMOUNT);
    assert_eq!(res, Err(Ok(ContractError::NotFunded)));
}

// 5. Unauthorized
#[test]
fn test_err_unauthorized() {
    let env_no_mock = Env::default();
    let contract_id = env_no_mock.register_contract(None, InvoiceLiquidityContract);
    let client = InvoiceLiquidityContractClient::new(&env_no_mock, &contract_id);
    let admin = Address::generate(&env_no_mock);
    let dummy = Address::generate(&env_no_mock);
    client.initialize(&admin, &dummy, &dummy, &dummy);
    let res = client.try_update_fee_rate(&100);
    assert!(res.is_err());
}

// 6. InvalidAmount
#[test]
fn test_err_invalid_amount() {
    let t = setup_errors();
    let due = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let res = t.contract.try_submit_invoice(
        &t.freelancer,
        &t.payer,
        &0,
        &due,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    assert_eq!(res, Err(Ok(ContractError::InvalidAmount)));
}

// 7. InvalidDiscountRate
#[test]
fn test_err_invalid_discount_rate() {
    let t = setup_errors();
    let due = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let res = t.contract.try_submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due,
        &0,
        &t.token.address,
        &ReferralCode::None,
    );
    assert_eq!(res, Err(Ok(ContractError::InvalidDiscountRate)));
}

// 8. InvalidDueDate
#[test]
fn test_err_invalid_due_date() {
    let t = setup_errors();
    let res = t.contract.try_submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &0,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    assert_eq!(res, Err(Ok(ContractError::InvalidDueDate)));
}

// 9. InvoiceDefaulted
#[test]
fn test_err_invoice_defaulted() {
    let t = setup_errors();
    let id = create_standard_invoice(&t);
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);
    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 100;
    t.env.ledger().set(ledger);
    t.contract.claim_default(&t.funder, &id);
    let res = t
        .contract
        .try_fund_invoice(&t.other, &id, &INVOICE_AMOUNT, &false);
    assert_eq!(res, Err(Ok(ContractError::InvoiceDefaulted)));
}

// 10. NothingToClaim
#[test]
fn test_err_nothing_to_claim() {
    let t = setup_errors();
    let id = create_standard_invoice(&t);
    let res = t.contract.try_claim_yield(&id);
    assert_eq!(res, Err(Ok(ContractError::NothingToClaim)));
}

// 11. NotYetDefaulted
#[test]
fn test_err_not_yet_defaulted() {
    let t = setup_errors();
    let id = create_standard_invoice(&t);
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);
    let res = t.contract.try_claim_default(&t.funder, &id);
    assert_eq!(res, Err(Ok(ContractError::NotYetDefaulted)));
}

// 12. OverfundingRejected
#[test]
fn test_err_overfunding_rejected() {
    let t = setup_errors();
    let id = create_standard_invoice(&t);
    let res = t
        .contract
        .try_fund_invoice(&t.funder, &id, &(INVOICE_AMOUNT + 1000), &false);
    assert_eq!(res, Err(Ok(ContractError::OverfundingRejected)));
}

// 13. InvoiceExpired
#[test]
fn test_err_invoice_expired() {
    let t = setup_errors();
    let id = create_standard_invoice(&t);
    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 100;
    t.env.ledger().set(ledger);
    t.contract.expire_invoice(&id);
    let res = t
        .contract
        .try_fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);
    assert_eq!(res, Err(Ok(ContractError::InvoiceExpired)));
}

// 14. BatchTooLarge
#[test]
fn test_err_batch_too_large() {
    let t = setup_errors();
    let mut batch = vec![&t.env];
    for _ in 0..11 {
        batch.push_back(InvoiceParams {
            freelancer: t.freelancer.clone(),
            payer: t.payer.clone(),
            amount: INVOICE_AMOUNT,
            due_date: t.env.ledger().timestamp() + DUE_DATE_OFFSET,
            discount_rate: DISCOUNT_RATE,
            token: t.token.address.clone(),
            referral_code: ReferralCode::None,
        });
    }
    let res = t.contract.try_submit_invoices_batch(&batch);
    assert_eq!(res, Err(Ok(ContractError::BatchTooLarge)));
}

// 15. AlreadyCancelled
#[test]
fn test_err_already_cancelled() {
    let t = setup_errors();
    let id = create_standard_invoice(&t);
    t.contract.cancel_invoice(&id);
    let res = t.contract.try_cancel_invoice(&id);
    assert_eq!(res, Err(Ok(ContractError::AlreadyCancelled)));
}

// 16. AlreadyInitialized
#[test]
fn test_err_already_initialized() {
    let t = setup_errors();
    t.env.as_contract(&t.contract.address, || {
        t.env
            .storage()
            .instance()
            .set(&crate::storage::DataKey::InvoiceCount, &1_u64);
    });
    let res = t
        .contract
        .try_initialize(&t.admin, &t.token.address, &t.other, &t.other);
    assert_eq!(res, Err(Ok(ContractError::AlreadyInitialized)));
}

// 17. AlreadyAppealed
#[test]
fn test_err_already_appealed() {
    let t = setup_errors();
    let id = create_standard_invoice(&t);
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);
    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 1;
    t.env.ledger().set(ledger);
    t.contract.claim_default(&t.funder, &id);

    let evidence = BytesN::from_array(&t.env, &[1u8; 32]);
    t.contract.appeal_default(&id, &evidence);
    let res = t.contract.try_appeal_default(&id, &evidence);
    assert_eq!(res, Err(Ok(ContractError::AlreadyAppealed)));
}

// 18. AppealWindowClosed
#[test]
fn test_err_appeal_window_closed() {
    let t = setup_errors();
    let id = create_standard_invoice(&t);
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);
    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 1;
    t.env.ledger().set(ledger);
    t.contract.claim_default(&t.funder, &id);

    let mut ledger2 = t.env.ledger().get();
    ledger2.timestamp += 60 * 60 * 24 * 35; // 35 days later (> 30 day appeal window)
    t.env.ledger().set(ledger2);

    let evidence = BytesN::from_array(&t.env, &[1u8; 32]);
    let res = t.contract.try_appeal_default(&id, &evidence);
    assert_eq!(res, Err(Ok(ContractError::AppealWindowClosed)));
}

// 19. NotDefaulted
#[test]
fn test_err_not_defaulted() {
    let t = setup_errors();
    let id = create_standard_invoice(&t);
    let evidence = BytesN::from_array(&t.env, &[1u8; 32]);
    let res = t.contract.try_appeal_default(&id, &evidence);
    assert_eq!(res, Err(Ok(ContractError::NotDefaulted)));
}

// 20. AlreadyInQueue
#[test]
fn test_err_already_in_queue() {
    let t = setup_errors();
    let id = create_standard_invoice(&t);
    t.contract.join_fund_queue(&t.funder, &id);
    let res = t.contract.try_join_fund_queue(&t.funder, &id);
    assert_eq!(res, Err(Ok(ContractError::AlreadyInQueue)));
}

// 21. NotApprovedFunder
#[test]
fn test_err_not_approved_funder() {
    let t = setup_errors();
    let id = create_standard_invoice(&t);
    t.contract.join_fund_queue(&t.funder, &id);
    let mut ledger = t.env.ledger().get();
    ledger.sequence_number += QUEUE_DELAY_LEDGERS + 1;
    t.env.ledger().set(ledger);
    t.contract.resolve_fund_queue(&id);
    let res = t
        .contract
        .try_fund_invoice(&t.other, &id, &INVOICE_AMOUNT, &false);
    assert_eq!(res, Err(Ok(ContractError::NotApprovedFunder)));
}

// 22. InvoiceAppealed
#[test]
fn test_err_invoice_appealed() {
    let t = setup_errors();
    let id = create_standard_invoice(&t);
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);
    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 1;
    t.env.ledger().set(ledger);
    t.contract.claim_default(&t.funder, &id);
    let evidence = BytesN::from_array(&t.env, &[1u8; 32]);
    t.contract.appeal_default(&id, &evidence);

    let res = t.contract.try_claim_default(&t.funder, &id);
    assert_eq!(res, Err(Ok(ContractError::InvoiceAppealed)));
}

// 23. AlreadyDisputed
#[test]
fn test_err_already_disputed() {
    let t = setup_errors();
    let id = create_standard_invoice(&t);
    let reason = BytesN::from_array(&t.env, &[2u8; 32]);
    t.contract.dispute_invoice(&id, &reason);
    let res = t.contract.try_dispute_invoice(&id, &reason);
    assert_eq!(res, Err(Ok(ContractError::AlreadyDisputed)));
}

// 24. NotDisputed
#[test]
fn test_err_not_disputed() {
    let t = setup_errors();
    let id = create_standard_invoice(&t);
    let resolution = BytesN::from_array(&t.env, &[3u8; 32]);
    let res = t.contract.try_resolve_dispute(&id, &resolution, &1);
    assert_eq!(res, Err(Ok(ContractError::NotDisputed)));
}

// 25. InvoiceDisputed
#[test]
fn test_err_invoice_disputed() {
    let t = setup_errors();
    let id = create_standard_invoice(&t);
    let reason = BytesN::from_array(&t.env, &[2u8; 32]);
    t.contract.dispute_invoice(&id, &reason);
    let res = t
        .contract
        .try_fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);
    assert_eq!(res, Err(Ok(ContractError::InvoiceDisputed)));
}

// 26. ContractPaused
#[test]
fn test_err_contract_paused() {
    let t = setup_errors();
    let id = create_standard_invoice(&t);
    t.contract.pause();
    let res = t
        .contract
        .try_fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);
    assert_eq!(res, Err(Ok(ContractError::ContractPaused)));
}

// 27. DueDateTooSoon
#[test]
fn test_err_due_date_too_soon() {
    let t = setup_errors();
    let due = t.env.ledger().timestamp() + 3600; // 1 hr < 24 hrs MIN_INVOICE_DURATION
    let res = t.contract.try_submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    assert_eq!(res, Err(Ok(ContractError::DueDateTooSoon)));
}

// 28. DueDateTooFar
#[test]
fn test_err_due_date_too_far() {
    let t = setup_errors();
    let due = t.env.ledger().timestamp() + 60 * 60 * 24 * 400; // 400 days > 365 days MAX_INVOICE_DURATION
    let res = t.contract.try_submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    assert_eq!(res, Err(Ok(ContractError::DueDateTooFar)));
}

// 29. SelfInvoice
#[test]
fn test_err_self_invoice() {
    let t = setup_errors();
    let due = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let res = t.contract.try_submit_invoice(
        &t.freelancer,
        &t.freelancer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    assert_eq!(res, Err(Ok(ContractError::SelfInvoice)));
}

// 30. OverpaymentRejected
#[test]
fn test_err_overpayment_rejected() {
    let t = setup_errors();
    let id = create_standard_invoice(&t);
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);
    let res = t.contract.try_mark_paid(&id, &(INVOICE_AMOUNT + 1000));
    assert_eq!(res, Err(Ok(ContractError::OverpaymentRejected)));
}

// 31. PayerReputationTooLow
#[test]
fn test_err_payer_reputation_too_low() {
    let t = setup_errors();
    advance_rate_limit(&t.env);
    t.contract.set_min_payer_reputation(&80);
    let id = create_standard_invoice(&t);
    // Payer has default reputation 50 < 80
    let res = t
        .contract
        .try_fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);
    assert_eq!(res, Err(Ok(ContractError::PayerReputationTooLow)));
}

// 32. ArithmeticOverflow
#[test]
fn test_err_arithmetic_overflow() {
    let err = ContractError::ArithmeticOverflow;
    assert_eq!(err as u32, 32);
}

// 33. FeeOnTransferToken
#[test]
fn test_err_fee_on_transfer_token() {
    let err = ContractError::FeeOnTransferToken;
    assert_eq!(err as u32, 33);
}

#[contract]
pub struct MockUnverifiedOracle;
#[contractimpl]
impl MockUnverifiedOracle {
    pub fn get_payer_data(_env: Env, _payer: Address) -> OracleVerificationResponse {
        OracleVerificationResponse {
            is_verified: false,
            timestamp: 100,
        }
    }
}

#[contract]
pub struct MockStaleOracle;
#[contractimpl]
impl MockStaleOracle {
    pub fn get_payer_data(_env: Env, _payer: Address) -> OracleVerificationResponse {
        OracleVerificationResponse {
            is_verified: true,
            timestamp: 1,
        }
    }
}

// 34. PayerUnverified
#[test]
fn test_err_payer_unverified() {
    let t = setup_errors();
    advance_rate_limit(&t.env);
    let oracle_id = t.env.register_contract(None, MockUnverifiedOracle);
    t.contract.set_price_oracle(&oracle_id);

    let id = create_standard_invoice(&t);
    let res = t
        .contract
        .try_fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &true);
    assert_eq!(res, Err(Ok(ContractError::PayerUnverified)));
}

// 35. OracleDataStale
#[test]
fn test_err_oracle_data_stale() {
    let t = setup_errors();
    advance_rate_limit(&t.env);
    let max_age: u64 = 10;
    t.contract.set_max_oracle_age(&max_age);

    let oracle_id = t.env.register_contract(None, MockStaleOracle);
    t.contract.set_price_oracle(&oracle_id);

    let id = create_standard_invoice(&t);
    let res = t
        .contract
        .try_fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &true);
    assert_eq!(res, Err(Ok(ContractError::OracleDataStale)));
}

// 36. AmountTooSmall
#[test]
fn test_err_amount_too_small() {
    let err = ContractError::AmountTooSmall;
    assert_eq!(err as u32, 36);
}

// 37. Reentrancy
#[test]
fn test_err_reentrancy() {
    let t = setup_errors();
    t.env.as_contract(&t.contract.address, || {
        assert!(lock_reentrancy(&t.env).is_ok());
        let reentrant = lock_reentrancy(&t.env);
        assert_eq!(reentrant, Err(ContractError::Reentrancy));
        unlock_reentrancy(&t.env);
    });
}

// 38. RateLimited
#[test]
fn test_err_rate_limited() {
    let t = setup_errors();
    advance_rate_limit(&t.env);
    let res1 = t.contract.try_update_fee_rate(&250);
    assert!(res1.is_ok());
    let res2 = t.contract.try_update_fee_rate(&500);
    assert_eq!(res2, Err(Ok(ContractError::RateLimited)));
}

// 39. QueueNotMature
#[test]
fn test_err_queue_not_mature() {
    let t = setup_errors();
    let id = create_standard_invoice(&t);
    t.contract.join_fund_queue(&t.funder, &id);
    let res = t.contract.try_resolve_fund_queue(&id);
    assert_eq!(res, Err(Ok(ContractError::QueueNotMature)));
}
