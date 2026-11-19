//! Comprehensive tests covering remaining view functions, governance actions,
//! dispute resolution, appeal resolution, and storage migration in invoice_liquidity.

#![cfg(test)]

use super::*;
use crate::invoice::ReferralCode;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, BytesN, Env,
};

const INVOICE_AMOUNT: i128 = 10_000_000; // 10 USDC
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30; // 30 days

#[allow(dead_code)]
struct BoosterTestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: TokenClient<'static>,
    admin: Address,
    freelancer: Address,
    payer: Address,
    funder: Address,
}

fn setup_booster() -> BoosterTestEnv {
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

    token_admin.mint(&funder, &(INVOICE_AMOUNT * 20));
    token_admin.mint(&payer, &(INVOICE_AMOUNT * 20));

    let contract_id = env.register(InvoiceLiquidityContract, ());
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);
    token_admin.mint(&contract.address, &(INVOICE_AMOUNT * 100));

    let xlm_admin = Address::generate(&env);
    let xlm_id = env.register_stellar_asset_contract_v2(xlm_admin);
    let eurc_admin = Address::generate(&env);
    let eurc_id = env.register_stellar_asset_contract_v2(eurc_admin);

    contract.initialize(&admin, &xlm_id.address(), &usdc_addr, &eurc_id.address());

    BoosterTestEnv {
        env,
        contract,
        token,
        admin,
        freelancer,
        payer,
        funder,
    }
}

fn advance_rate_limit(env: &Env) {
    let mut info = env.ledger().get();
    info.sequence_number += 5000;
    env.ledger().set(info);
}

#[test]
fn test_storage_version_and_migration() {
    let t = setup_booster();
    assert_eq!(t.contract.get_storage_version(), 1);

    let v = t.contract.migrate();
    assert_eq!(v, crate::constants::CURRENT_STORAGE_VERSION);
    assert_eq!(
        t.contract.get_storage_version(),
        crate::constants::CURRENT_STORAGE_VERSION
    );

    // Idempotent migration
    let v2 = t.contract.migrate();
    assert_eq!(v2, crate::constants::CURRENT_STORAGE_VERSION);
}

#[test]
fn test_fee_tiers_management() {
    let t = setup_booster();
    advance_rate_limit(&t.env);
    assert_eq!(t.contract.get_fee_tiers().len(), 0);

    let tiers = vec![
        &t.env,
        (1_000_000, 300),
        (10_000_000, 200),
        (50_000_000, 100),
    ];
    t.contract.update_fee_tiers(&tiers);
    let loaded = t.contract.get_fee_tiers();
    assert_eq!(loaded.len(), 3);
    assert_eq!(loaded.get(0).unwrap(), (1_000_000, 300));
}

#[test]
fn test_list_invoices_pagination() {
    let t = setup_booster();
    let now = t.env.ledger().timestamp();
    let due = now + DUE_DATE_OFFSET;

    let id1 = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    let id2 = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    let id3 = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    // List by submitter pagination (0-indexed page)
    let page0 = t.contract.list_invoices_by_submitter(&t.freelancer, &0, &2);
    assert_eq!(page0.len(), 2);
    assert_eq!(page0.get(0).unwrap().id, id1);
    assert_eq!(page0.get(1).unwrap().id, id2);

    let page1 = t.contract.list_invoices_by_submitter(&t.freelancer, &1, &2);
    assert_eq!(page1.len(), 1);
    assert_eq!(page1.get(0).unwrap().id, id3);

    // Empty page
    let page2 = t.contract.list_invoices_by_submitter(&t.freelancer, &2, &2);
    assert_eq!(page2.len(), 0);

    // Fund one invoice
    t.contract
        .fund_invoice(&t.funder, &id1, &INVOICE_AMOUNT, &false);
    let lp_page = t.contract.list_invoices_by_lp(&t.funder, &0, &10);
    assert_eq!(lp_page.len(), 1);
    assert_eq!(lp_page.get(0).unwrap().id, id1);
}

#[test]
fn test_governance_setters_and_views() {
    let t = setup_booster();
    advance_rate_limit(&t.env);

    // update_decay_params
    t.contract.update_decay_params(&100, &2000);
    let cfg = t.contract.get_config();
    assert_eq!(cfg.decay_rate_bps, 100);
    assert_eq!(cfg.decay_period_ledgers, 2000);

    // set_distribution_contract
    let dist_addr = Address::generate(&t.env);
    advance_rate_limit(&t.env);
    t.contract.set_distribution_contract(&dist_addr);

    // insurance pool
    assert_eq!(t.contract.get_insurance_pool(), None);
    let pool_addr = Address::generate(&t.env);
    t.contract.set_insurance_pool(&pool_addr);
    assert_eq!(t.contract.get_insurance_pool(), Some(pool_addr));

    // token decimals
    let new_token_admin = Address::generate(&t.env);
    let new_token_id = t.env.register_stellar_asset_contract_v2(new_token_admin);
    let new_token = new_token_id.address();
    let new_token_client = StellarAssetClient::new(&t.env, &new_token);
    new_token_client.mint(&t.admin, &10_000_000);
    advance_rate_limit(&t.env);
    t.contract.add_token(&new_token, &6);
    assert_eq!(t.contract.get_token_decimals(&new_token), Some(6));
    let unk = Address::generate(&t.env);
    assert_eq!(t.contract.get_token_decimals(&unk), None);

    // oracle age & getters
    assert_eq!(t.contract.get_max_oracle_age(), 17280);
    advance_rate_limit(&t.env);
    t.contract.set_max_oracle_age(&20000);
    assert_eq!(t.contract.get_max_oracle_age(), 20000);

    // min payer reputation
    assert_eq!(t.contract.min_payer_reputation(), 0);
    advance_rate_limit(&t.env);
    t.contract.set_min_payer_reputation(&40);
    assert_eq!(t.contract.min_payer_reputation(), 40);

    // suggested discount rate
    let sugg = t.contract.suggested_discount_rate(&t.payer);
    assert!(sugg > 0);

    // reputation profile
    let rep = t.contract.get_reputation(&t.payer);
    assert_eq!(rep.score, 0);

    // score getters
    assert_eq!(t.contract.payer_score(&t.payer), 50);
    assert_eq!(t.contract.lp_score(&t.funder), 50);

    // NFT queries
    assert_eq!(t.contract.query_nft_metadata(&999), None);
    assert_eq!(t.contract.query_nft_owner(&999), None);
}

#[test]
fn test_dispute_and_resolution_flow() {
    let t = setup_booster();
    let now = t.env.ledger().timestamp();
    let due = now + DUE_DATE_OFFSET;

    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    let reason_hash = BytesN::from_array(&t.env, &[7u8; 32]);
    let resolution_hash = BytesN::from_array(&t.env, &[8u8; 32]);

    // Dispute pending invoice
    t.contract.dispute_invoice(&id, &reason_hash);
    let inv = t.contract.get_invoice(&id);
    assert_eq!(inv.status, InvoiceStatus::Disputed);

    // Resolve dispute with resolution 2 (Rejected -> Freelancer wins -> status back to Pending)
    t.contract.resolve_dispute(&id, &resolution_hash, &2);
    let inv = t.contract.get_invoice(&id);
    assert_eq!(inv.status, InvoiceStatus::Pending);

    // Fund it
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);

    // Submit and fund another invoice to test Upheld resolution on Funded status
    let id2 = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    t.contract
        .fund_invoice(&t.funder, &id2, &INVOICE_AMOUNT, &false);
    t.contract.dispute_invoice(&id2, &reason_hash);
    let inv2 = t.contract.get_invoice(&id2);
    assert_eq!(inv2.status, InvoiceStatus::Disputed);

    // Resolve dispute with resolution 1 (Upheld -> Payer wins -> status Cancelled, LP refunded)
    t.contract.resolve_dispute(&id2, &resolution_hash, &1);
    let inv2 = t.contract.get_invoice(&id2);
    assert_eq!(inv2.status, InvoiceStatus::Cancelled);
}

#[test]
fn test_auto_resolve_dispute_timeout() {
    let t = setup_booster();
    let now = t.env.ledger().timestamp();
    let due = now + DUE_DATE_OFFSET;

    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    let reason_hash = BytesN::from_array(&t.env, &[5u8; 32]);
    t.contract.dispute_invoice(&id, &reason_hash);

    // Timeout not reached
    assert!(t.contract.try_auto_resolve_dispute(&id).is_err());

    // Advance ledger past timeout (10000 ledgers)
    let mut ledger = t.env.ledger().get();
    ledger.sequence_number += 20000;
    t.env.ledger().set(ledger);

    t.contract.auto_resolve_dispute(&id);
    let inv = t.contract.get_invoice(&id);
    assert_eq!(inv.status, InvoiceStatus::Pending);
}

#[test]
fn test_appeal_and_resolution_flow() {
    let t = setup_booster();
    let now = t.env.ledger().timestamp();
    let due = now + DUE_DATE_OFFSET;

    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);

    // Advance time past due date
    let mut ledger = t.env.ledger().get();
    ledger.timestamp = due + 10;
    t.env.ledger().set(ledger);

    // LP claims default
    t.contract.claim_default(&t.funder, &id);
    let inv = t.contract.get_invoice(&id);
    assert_eq!(inv.status, InvoiceStatus::Defaulted);

    // Payer appeals
    let evidence_hash = BytesN::from_array(&t.env, &[9u8; 32]);
    t.contract.appeal_default(&id, &evidence_hash);
    let inv = t.contract.get_invoice(&id);
    assert_eq!(inv.status, InvoiceStatus::Appealed);

    // Admin resolves appeal (upheld)
    t.contract.resolve_appeal(&id, &true);
    let inv = t.contract.get_invoice(&id);
    assert_eq!(inv.status, InvoiceStatus::Defaulted);
}

#[test]
fn test_claim_yield_and_referral_stats() {
    let t = setup_booster();
    let now = t.env.ledger().timestamp();
    let due = now + DUE_DATE_OFFSET;

    let ref_code = BytesN::from_array(&t.env, &[42u8; 32]);
    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::Present(ref_code.clone()),
    );
    assert_eq!(t.contract.get_referral_stats(&ref_code), 1);

    // Unfunded invoice yield is 0 (or NothingToClaim if no funder)
    assert_eq!(
        t.contract.try_claim_yield(&id),
        Err(Ok(ContractError::NothingToClaim))
    );

    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);
    assert_eq!(t.contract.claim_yield(&id), 0);

    t.contract.mark_paid(&id, &INVOICE_AMOUNT);
    let y = t.contract.claim_yield(&id);
    assert_eq!(y, 300_000);
}

// ----------------------------------------------------------------
// Additional resolve_dispute branch coverage
// ----------------------------------------------------------------

#[test]
fn test_resolve_dispute_rejected_on_funded_returns_funded() {
    let t = setup_booster();
    let now = t.env.ledger().timestamp();
    let due = now + DUE_DATE_OFFSET;

    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);

    let reason = BytesN::from_array(&t.env, &[10u8; 32]);
    t.contract.dispute_invoice(&id, &reason);

    let resolution = BytesN::from_array(&t.env, &[11u8; 32]);
    // Resolution 2 = Rejected (Freelancer right) → status restored to Funded
    t.contract.resolve_dispute(&id, &resolution, &2);
    let inv = t.contract.get_invoice(&id);
    assert_eq!(inv.status, InvoiceStatus::Funded);
}

#[test]
fn test_resolve_dispute_rejected_on_partially_funded() {
    let t = setup_booster();
    let now = t.env.ledger().timestamp();
    let due = now + DUE_DATE_OFFSET;

    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    // Partially fund (half)
    t.contract
        .fund_invoice(&t.funder, &id, &(INVOICE_AMOUNT / 2), &false);

    let reason = BytesN::from_array(&t.env, &[12u8; 32]);
    t.contract.dispute_invoice(&id, &reason);

    let resolution = BytesN::from_array(&t.env, &[13u8; 32]);
    t.contract.resolve_dispute(&id, &resolution, &2);
    let inv = t.contract.get_invoice(&id);
    assert_eq!(inv.status, InvoiceStatus::PartiallyFunded);
}

#[test]
fn test_resolve_dispute_upheld_with_partial_payment() {
    let t = setup_booster();
    let now = t.env.ledger().timestamp();
    let due = now + DUE_DATE_OFFSET;

    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);

    // Partial payment by payer
    t.contract.mark_paid(&id, &(INVOICE_AMOUNT / 2));

    let reason = BytesN::from_array(&t.env, &[14u8; 32]);
    t.contract.dispute_invoice(&id, &reason);

    let resolution = BytesN::from_array(&t.env, &[15u8; 32]);
    // Resolution 1 = Upheld (Payer right) → Cancelled, payer refund
    t.contract.resolve_dispute(&id, &resolution, &1);
    let inv = t.contract.get_invoice(&id);
    assert_eq!(inv.status, InvoiceStatus::Cancelled);
}

#[test]
fn test_resolve_dispute_invalid_resolution() {
    let t = setup_booster();
    let now = t.env.ledger().timestamp();
    let due = now + DUE_DATE_OFFSET;

    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);

    let reason = BytesN::from_array(&t.env, &[16u8; 32]);
    t.contract.dispute_invoice(&id, &reason);

    let resolution = BytesN::from_array(&t.env, &[17u8; 32]);
    let result = t.contract.try_resolve_dispute(&id, &resolution, &3);
    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}

// ----------------------------------------------------------------
// auto_resolve_dispute on Funded invoice
// ----------------------------------------------------------------

#[test]
fn test_auto_resolve_dispute_funded_invoice() {
    let t = setup_booster();
    let now = t.env.ledger().timestamp();
    let due = now + DUE_DATE_OFFSET;

    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);

    let reason = BytesN::from_array(&t.env, &[18u8; 32]);
    t.contract.dispute_invoice(&id, &reason);

    // Advance past dispute timeout (10000 ledgers)
    let mut ledger = t.env.ledger().get();
    ledger.sequence_number += 20000;
    t.env.ledger().set(ledger);

    t.contract.auto_resolve_dispute(&id);
    let inv = t.contract.get_invoice(&id);
    assert_eq!(inv.status, InvoiceStatus::Funded);
}

#[test]
fn test_auto_resolve_dispute_partially_funded() {
    let t = setup_booster();
    let now = t.env.ledger().timestamp();
    let due = now + DUE_DATE_OFFSET;

    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    t.contract
        .fund_invoice(&t.funder, &id, &(INVOICE_AMOUNT / 2), &false);

    let reason = BytesN::from_array(&t.env, &[19u8; 32]);
    t.contract.dispute_invoice(&id, &reason);

    let mut ledger = t.env.ledger().get();
    ledger.sequence_number += 20000;
    t.env.ledger().set(ledger);

    t.contract.auto_resolve_dispute(&id);
    let inv = t.contract.get_invoice(&id);
    assert_eq!(inv.status, InvoiceStatus::PartiallyFunded);
}

// ----------------------------------------------------------------
// claim_default with partially funded invoice
// ----------------------------------------------------------------

#[test]
fn test_claim_default_partial_funding() {
    let t = setup_booster();
    let now = t.env.ledger().timestamp();
    let due = now + DUE_DATE_OFFSET;

    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    // Partially fund
    t.contract
        .fund_invoice(&t.funder, &id, &(INVOICE_AMOUNT / 2), &false);

    // Advance past due date
    let mut ledger = t.env.ledger().get();
    ledger.timestamp = due + 10;
    t.env.ledger().set(ledger);

    // claim_default only applies to fully Funded invoices; a partially
    // funded invoice must be rejected with NotFunded, leaving the invoice
    // untouched in PartiallyFunded state (cancel_invoice is the exit path).
    let result = t.contract.try_claim_default(&t.funder, &id);
    assert_eq!(result, Err(Ok(ContractError::NotFunded)));

    let inv = t.contract.get_invoice(&id);
    assert_eq!(inv.status, InvoiceStatus::PartiallyFunded);
}

// ----------------------------------------------------------------
// Cancel partially funded invoice (refund path)
// ----------------------------------------------------------------

#[test]
fn test_cancel_partially_funded_refunds_funders() {
    let t = setup_booster();
    let now = t.env.ledger().timestamp();
    let due = now + DUE_DATE_OFFSET;

    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    // Partially fund
    t.contract
        .fund_invoice(&t.funder, &id, &(INVOICE_AMOUNT / 2), &false);

    let funder_before = t.token.balance(&t.funder);
    t.contract.cancel_invoice(&id);
    let funder_after = t.token.balance(&t.funder);

    // Funder should get back their funded amount minus discount
    let fund_amount = INVOICE_AMOUNT / 2;
    let discount = fund_amount * DISCOUNT_RATE as i128 / 10_000;
    let expected_refund = fund_amount - discount;
    assert_eq!(funder_after - funder_before, expected_refund);

    let inv = t.contract.get_invoice(&id);
    assert_eq!(inv.status, InvoiceStatus::Cancelled);
}

// ----------------------------------------------------------------
// Appeal resolution — reject appeal (not upheld)
// ----------------------------------------------------------------

#[test]
fn test_resolve_appeal_not_upheld() {
    let t = setup_booster();
    let now = t.env.ledger().timestamp();
    let due = now + DUE_DATE_OFFSET;

    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);

    let mut ledger = t.env.ledger().get();
    ledger.timestamp = due + 10;
    t.env.ledger().set(ledger);

    t.contract.claim_default(&t.funder, &id);
    let evidence = BytesN::from_array(&t.env, &[20u8; 32]);
    t.contract.appeal_default(&id, &evidence);
    let inv = t.contract.get_invoice(&id);
    assert_eq!(inv.status, InvoiceStatus::Appealed);

    // Admin rejects the appeal
    t.contract.resolve_appeal(&id, &false);
    let inv = t.contract.get_invoice(&id);
    assert_eq!(inv.status, InvoiceStatus::Defaulted);
}

// ----------------------------------------------------------------
// update_config — full happy path + error branches
// ----------------------------------------------------------------

#[test]
fn test_update_config_happy_path() {
    let t = setup_booster();
    advance_rate_limit(&t.env);

    let new_xlm = Address::generate(&t.env);
    let new_usdc = Address::generate(&t.env);
    let new_eurc = Address::generate(&t.env);

    t.contract.update_config(
        &t.admin, &70, &200, &100, &50, &2000, &5000, &new_xlm, &new_usdc, &new_eurc,
    );

    let cfg = t.contract.get_config();
    assert_eq!(cfg.high_rep_threshold, 70);
    assert_eq!(cfg.bonus_bps, 200);
    assert_eq!(cfg.min_discount_rate_bps, 100);
    assert_eq!(cfg.decay_rate_bps, 50);
    assert_eq!(cfg.decay_period_ledgers, 2000);
    assert_eq!(cfg.dispute_timeout_ledgers, 5000);
    // price_oracle and max_oracle_age_ledgers should be preserved
    assert_eq!(cfg.price_oracle, None);
    assert_eq!(cfg.max_oracle_age_ledgers, 17280);
}

#[test]
fn test_update_config_rejects_invalid_bonus_bps() {
    let t = setup_booster();
    advance_rate_limit(&t.env);

    let dummy = Address::generate(&t.env);
    let result = t.contract.try_update_config(
        &t.admin, &70, &501, // MAX_BONUS_BPS is 500, so 501 is too high
        &100, &50, &2000, &5000, &dummy, &dummy, &dummy,
    );
    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}

#[test]
fn test_update_config_rejects_zero_min_discount() {
    let t = setup_booster();
    advance_rate_limit(&t.env);

    let dummy = Address::generate(&t.env);
    let result = t.contract.try_update_config(
        &t.admin, &70, &100, &0, // zero min_discount_rate
        &50, &2000, &5000, &dummy, &dummy, &dummy,
    );
    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}

// ----------------------------------------------------------------
// get_config error path (no config stored)
// ----------------------------------------------------------------

#[test]
fn test_get_config_not_initialized() {
    let env = Env::default();
    let contract_id = env.register(InvoiceLiquidityContract, ());
    let client = InvoiceLiquidityContractClient::new(&env, &contract_id);
    let result = client.try_get_config();
    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}

// ----------------------------------------------------------------
// update_fee_rate happy path
// ----------------------------------------------------------------

#[test]
fn test_update_fee_rate() {
    let t = setup_booster();
    advance_rate_limit(&t.env);

    t.contract.update_fee_rate(&500);
    // Fee tiers are empty, so effective rate comes from the flat FeeRate
    // (which is set to 500 by update_fee_rate).
    assert_eq!(t.contract.get_fee_tiers().len(), 0);
}

// ----------------------------------------------------------------
// update_max_discount happy path
// ----------------------------------------------------------------

#[test]
fn test_update_max_discount() {
    let t = setup_booster();
    advance_rate_limit(&t.env);

    t.contract.update_max_discount(&3000);
    // Verify by trying to submit with rate just under the new cap
    let due = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let res = t.contract.try_submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due,
        &2999,
        &t.token.address,
        &ReferralCode::None,
    );
    assert!(res.is_ok());
}
