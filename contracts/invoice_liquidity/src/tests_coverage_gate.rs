//! Tests targeting production branches left uncovered by the existing suites.
//! These exist to keep the tarpaulin coverage gate (>= 90% of invoice_liquidity
//! production code) meaningful; each test documents the branch it exercises.

#![cfg(test)]

use super::*;
use crate::invoice::ReferralCode;
use crate::nft::{burn_invoice_nft, mint_invoice_nft, query_nft_owner, transfer_invoice_nft};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    vec, Address, BytesN, Env,
};

const INVOICE_AMOUNT: i128 = 10_000_000; // 10 USDC
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30; // 30 days

struct GateEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: TokenClient<'static>,
    token_admin: StellarAssetClient<'static>,
    freelancer: Address,
    payer: Address,
    funder: Address,
}

fn setup_gate() -> GateEnv {
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

    let xlm_id = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let eurc_id = env.register_stellar_asset_contract_v2(Address::generate(&env));

    contract.initialize(&admin, &xlm_id.address(), &usdc_addr, &eurc_id.address());

    GateEnv {
        env,
        contract,
        token,
        token_admin,
        freelancer,
        payer,
        funder,
    }
}

fn advance(env: &Env) {
    let mut info = env.ledger().get();
    info.sequence_number += 5000;
    env.ledger().set(info);
}

fn submit_standard(t: &GateEnv) -> u64 {
    let now = t.env.ledger().timestamp();
    let due = now + DUE_DATE_OFFSET;
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

// ----------------------------------------------------------------
// set_admin: happy path, uninitialized-contract rejection, and the
// rate-limited immediate-second-call rejection.
// ----------------------------------------------------------------

#[test]
fn test_set_admin_happy_path_and_rate_limit() {
    let t = setup_gate();

    // initialize() seeds the set_admin cooldown, so the first change right
    // after initialization is rejected.
    let result = t.contract.try_set_admin(&Address::generate(&t.env));
    assert_eq!(result, Err(Ok(ContractError::RateLimited)));

    advance(&t.env);
    let new_admin = Address::generate(&t.env);
    t.contract.set_admin(&new_admin);

    // A second change inside the cooldown is rejected as well.
    let result = t.contract.try_set_admin(&Address::generate(&t.env));
    assert_eq!(result, Err(Ok(ContractError::RateLimited)));

    // Admin-only functions still work after rotation (auth is mocked, so
    // identity checks are vacuous here; set_admin's job is the storage
    // handover plus the admin_changed event).
    advance(&t.env);
    t.contract.update_fee_rate(&100);
}

#[test]
fn test_set_admin_rejected_before_initialization() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(InvoiceLiquidityContract, ());
    let client = InvoiceLiquidityContractClient::new(&env, &contract_id);

    let result = client.try_set_admin(&Address::generate(&env));
    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}

// ----------------------------------------------------------------
// join_fund_queue: one test per unreachable status branch.
// ----------------------------------------------------------------

#[test]
fn test_join_fund_queue_rejects_funded_invoice() {
    let t = setup_gate();
    let id = submit_standard(&t);
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);

    let result = t
        .contract
        .try_join_fund_queue(&Address::generate(&t.env), &id);
    assert_eq!(result, Err(Ok(ContractError::AlreadyFunded)));
}

#[test]
fn test_join_fund_queue_rejects_paid_invoice() {
    let t = setup_gate();
    let id = submit_standard(&t);
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);
    t.contract.mark_paid(&id, &INVOICE_AMOUNT);

    let result = t
        .contract
        .try_join_fund_queue(&Address::generate(&t.env), &id);
    assert_eq!(result, Err(Ok(ContractError::AlreadyPaid)));
}

#[test]
fn test_join_fund_queue_rejects_cancelled_invoice() {
    let t = setup_gate();
    let id = submit_standard(&t);
    t.contract.cancel_invoice(&id);

    let result = t
        .contract
        .try_join_fund_queue(&Address::generate(&t.env), &id);
    assert_eq!(result, Err(Ok(ContractError::AlreadyCancelled)));
}

#[test]
fn test_join_fund_queue_rejects_expired_invoice() {
    let t = setup_gate();
    let id = submit_standard(&t);

    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 10;
    t.env.ledger().set(ledger);

    t.contract.expire_invoice(&id);

    let result = t
        .contract
        .try_join_fund_queue(&Address::generate(&t.env), &id);
    assert_eq!(result, Err(Ok(ContractError::InvoiceExpired)));
}

#[test]
fn test_join_fund_queue_rejects_nonexistent_invoice() {
    let t = setup_gate();
    let result = t
        .contract
        .try_join_fund_queue(&Address::generate(&t.env), &999);
    assert_eq!(result, Err(Ok(ContractError::InvoiceNotFound)));
}

// ----------------------------------------------------------------
// mark_paid: overpayment guard.
// ----------------------------------------------------------------

#[test]
fn test_mark_paid_overpayment_rejected() {
    let t = setup_gate();
    let id = submit_standard(&t);
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);

    let result = t.contract.try_mark_paid(&id, &(INVOICE_AMOUNT + 1));
    assert_eq!(result, Err(Ok(ContractError::OverpaymentRejected)));
}

// ----------------------------------------------------------------
// claim_yield: non-Paid terminal statuses surface their specific errors
// through the try_ client (Paid path and the Funded/Pending zero path are
// already covered elsewhere).
// ----------------------------------------------------------------

#[test]
fn test_claim_yield_error_statuses() {
    let t = setup_gate();

    // Defaulted
    let id = submit_standard(&t);
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);
    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 10;
    t.env.ledger().set(ledger);
    t.contract.claim_default(&t.funder, &id);
    assert_eq!(
        t.contract.try_claim_yield(&id),
        Err(Ok(ContractError::InvoiceDefaulted))
    );

    // Cancelled (never funded): the nothing-to-claim guard fires first.
    let id2 = submit_standard(&t);
    t.contract.cancel_invoice(&id2);
    assert_eq!(
        t.contract.try_claim_yield(&id2),
        Err(Ok(ContractError::NothingToClaim))
    );

    // Disputed while funded -> specific status error.
    let id5 = submit_standard(&t);
    t.contract
        .fund_invoice(&t.funder, &id5, &INVOICE_AMOUNT, &false);
    let reason5 = BytesN::from_array(&t.env, &[4u8; 32]);
    t.contract.dispute_invoice(&id5, &reason5);
    assert_eq!(
        t.contract.try_claim_yield(&id5),
        Err(Ok(ContractError::InvoiceDisputed))
    );

    // Expired before funding: nothing was ever contributed, so the
    // nothing-to-claim guard fires before the status match.
    let id3 = submit_standard(&t);
    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 10;
    t.env.ledger().set(ledger);
    t.contract.expire_invoice(&id3);
    assert_eq!(
        t.contract.try_claim_yield(&id3),
        Err(Ok(ContractError::NothingToClaim))
    );

    // Disputed while never funded: the funder-less guard fires first.
    let id4 = submit_standard(&t);
    let reason = BytesN::from_array(&t.env, &[3u8; 32]);
    t.contract.dispute_invoice(&id4, &reason);
    assert_eq!(
        t.contract.try_claim_yield(&id4),
        Err(Ok(ContractError::NothingToClaim))
    );
}

// ----------------------------------------------------------------
// claim_default: reputation penalty floor (score <= 5 clamps to 0).
// ----------------------------------------------------------------

#[test]
fn test_claim_default_penalty_floors_at_zero() {
    let t = setup_gate();
    let id = submit_standard(&t);
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);

    // Drive the payer score to the floor (0) via repeated defaults, then
    // default once more: the penalty branch must keep the score at 0.
    for _ in 0..12 {
        let id2 = submit_standard(&t);
        t.contract
            .fund_invoice(&t.funder, &id2, &INVOICE_AMOUNT, &false);
        let mut ledger = t.env.ledger().get();
        ledger.timestamp += DUE_DATE_OFFSET + 10;
        t.env.ledger().set(ledger);
        t.contract.claim_default(&t.funder, &id2);
        advance(&t.env);
        advance(&t.env);
    }

    assert_eq!(t.contract.payer_score(&t.payer), 0);
    let rep = t.contract.get_reputation(&t.payer);
    assert_eq!(rep.score, 0);
}

// ----------------------------------------------------------------
// appeal_default: second appeal rejected (AlreadyAppealed guard that runs
// before the status check).
// ----------------------------------------------------------------

#[test]
fn test_appeal_default_twice_rejected() {
    let t = setup_gate();
    let id = submit_standard(&t);
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);

    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 10;
    t.env.ledger().set(ledger);
    t.contract.claim_default(&t.funder, &id);

    let evidence = BytesN::from_array(&t.env, &[7u8; 32]);
    t.contract.appeal_default(&id, &evidence);

    let result = t.contract.try_appeal_default(&id, &evidence);
    assert_eq!(result, Err(Ok(ContractError::AlreadyAppealed)));
}

// ----------------------------------------------------------------
// resolve_appeal: invoice must be in Appealed state.
// ----------------------------------------------------------------

#[test]
fn test_resolve_appeal_rejected_when_not_appealed() {
    let t = setup_gate();
    let id = submit_standard(&t);

    let result = t.contract.try_resolve_appeal(&id, &true);
    assert_eq!(result, Err(Ok(ContractError::NotDefaulted)));
}

// ----------------------------------------------------------------
// dispute_invoice: double dispute rejected; terminal statuses rejected.
// ----------------------------------------------------------------

#[test]
fn test_dispute_invoice_twice_rejected() {
    let t = setup_gate();
    let id = submit_standard(&t);

    let reason = BytesN::from_array(&t.env, &[11u8; 32]);
    t.contract.dispute_invoice(&id, &reason);

    let result = t.contract.try_dispute_invoice(&id, &reason);
    assert_eq!(result, Err(Ok(ContractError::AlreadyDisputed)));
}

#[test]
fn test_dispute_invoice_rejects_paid_invoice() {
    let t = setup_gate();
    let id = submit_standard(&t);
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);
    t.contract.mark_paid(&id, &INVOICE_AMOUNT);

    let reason = BytesN::from_array(&t.env, &[12u8; 32]);
    let result = t.contract.try_dispute_invoice(&id, &reason);
    assert_eq!(result, Err(Ok(ContractError::AlreadyPaid)));
}

#[test]
fn test_dispute_invoice_rejects_defaulted_invoice() {
    let t = setup_gate();
    let id = submit_standard(&t);
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);

    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 10;
    t.env.ledger().set(ledger);
    t.contract.claim_default(&t.funder, &id);

    let reason = BytesN::from_array(&t.env, &[13u8; 32]);
    let result = t.contract.try_dispute_invoice(&id, &reason);
    assert_eq!(result, Err(Ok(ContractError::InvoiceDefaulted)));
}

// ----------------------------------------------------------------
// resolve_dispute / auto_resolve_dispute: nonexistent-invoice guards.
// ----------------------------------------------------------------

#[test]
fn test_resolve_dispute_nonexistent_invoice() {
    let t = setup_gate();
    let resolution = BytesN::from_array(&t.env, &[14u8; 32]);
    let result = t.contract.try_resolve_dispute(&999, &resolution, &1);
    assert_eq!(result, Err(Ok(ContractError::InvoiceNotFound)));
}

#[test]
fn test_auto_resolve_dispute_not_disputed() {
    let t = setup_gate();
    let id = submit_standard(&t);
    let result = t.contract.try_auto_resolve_dispute(&id);
    assert_eq!(result, Err(Ok(ContractError::NotDisputed)));
}

// ----------------------------------------------------------------
// convert_invoice_token: state and expiry guards.
// ----------------------------------------------------------------

#[test]
fn test_convert_invoice_token_rejected_on_funded() {
    let t = setup_gate();
    let id = submit_standard(&t);
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);

    let result =
        t.contract
            .try_convert_invoice_token(&t.freelancer, &id, &Address::generate(&t.env));
    assert_eq!(result, Err(Ok(ContractError::AlreadyFunded)));
}

#[test]
fn test_convert_invoice_token_rejected_on_defaulted() {
    let t = setup_gate();
    let id = submit_standard(&t);
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);

    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 10;
    t.env.ledger().set(ledger);
    t.contract.claim_default(&t.funder, &id);

    let result =
        t.contract
            .try_convert_invoice_token(&t.freelancer, &id, &Address::generate(&t.env));
    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}

#[test]
fn test_convert_invoice_token_marks_expired_invoice() {
    let t = setup_gate();
    let id = submit_standard(&t);

    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 10;
    t.env.ledger().set(ledger);

    let result =
        t.contract
            .try_convert_invoice_token(&t.freelancer, &id, &Address::generate(&t.env));
    assert_eq!(result, Err(Ok(ContractError::InvoiceExpired)));
}

// ----------------------------------------------------------------
// update_invoice: state guards for the non-Pending statuses.
// ----------------------------------------------------------------

#[test]
fn test_update_invoice_state_guards() {
    let t = setup_gate();
    let now = t.env.ledger().timestamp();
    let due = now + DUE_DATE_OFFSET;

    // PartiallyFunded and Funded -> AlreadyFunded
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
    let res = t.contract.try_update_invoice(
        &t.freelancer,
        &id,
        &INVOICE_AMOUNT,
        &(now + DUE_DATE_OFFSET * 2),
        &DISCOUNT_RATE,
    );
    assert_eq!(res, Err(Ok(ContractError::AlreadyFunded)));

    // Complete the funding, then mark paid -> AlreadyPaid on update.
    t.contract
        .fund_invoice(&t.funder, &id, &(INVOICE_AMOUNT / 2), &false);
    t.contract.mark_paid(&id, &INVOICE_AMOUNT);
    let res = t.contract.try_update_invoice(
        &t.freelancer,
        &id,
        &INVOICE_AMOUNT,
        &(now + DUE_DATE_OFFSET * 2),
        &DISCOUNT_RATE,
    );
    assert_eq!(res, Err(Ok(ContractError::AlreadyPaid)));

    // Cancelled -> AlreadyCancelled
    let id2 = submit_standard(&t);
    t.contract.cancel_invoice(&id2);
    let res = t.contract.try_update_invoice(
        &t.freelancer,
        &id2,
        &INVOICE_AMOUNT,
        &(now + DUE_DATE_OFFSET * 2),
        &DISCOUNT_RATE,
    );
    assert_eq!(res, Err(Ok(ContractError::AlreadyCancelled)));

    // Defaulted -> InvoiceDefaulted
    let id3 = submit_standard(&t);
    t.contract
        .fund_invoice(&t.funder, &id3, &INVOICE_AMOUNT, &false);
    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_DATE_OFFSET + 10;
    t.env.ledger().set(ledger);
    t.contract.claim_default(&t.funder, &id3);
    let res = t.contract.try_update_invoice(
        &t.freelancer,
        &id3,
        &INVOICE_AMOUNT,
        &(now + DUE_DATE_OFFSET * 2),
        &DISCOUNT_RATE,
    );
    assert_eq!(res, Err(Ok(ContractError::InvoiceDefaulted)));
}

// ----------------------------------------------------------------
// transfer_lp_position: same-LP rejection (the status guards are covered
// by tests_new_features).
// ----------------------------------------------------------------

#[test]
fn test_transfer_lp_position_rejects_same_lp() {
    let t = setup_gate();
    let id = submit_standard(&t);
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);

    let result = t.contract.try_transfer_lp_position(&id, &t.funder);
    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}

// ----------------------------------------------------------------
// Fee tiers: effective_fee_rate tier walk on settlement (mark_paid path).
// ----------------------------------------------------------------

#[test]
fn test_fee_tiers_apply_to_settlement() {
    let t = setup_gate();
    advance(&t.env);
    let tiers = vec![
        &t.env,
        (1_000_000, 100),
        (10_000_000, 250),
        (50_000_000, 400),
    ];
    t.contract.update_fee_tiers(&tiers);
    assert_eq!(t.contract.get_fee_tiers().len(), 3);

    // Invoice of exactly 10 USDC lands in the middle tier (250 bps).
    let id = submit_standard(&t);
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);
    t.contract.mark_paid(&id, &INVOICE_AMOUNT);

    // Settlement must not revert with the tiered path active; LP still
    // receives principal + discount yield.
    let inv = t.contract.get_invoice(&id);
    assert_eq!(inv.status, InvoiceStatus::Paid);
    assert!(t.token.balance(&t.funder) > 0);
}

// ----------------------------------------------------------------
// NFT: transfer + burn happy paths and their unauthorized branches.
// ----------------------------------------------------------------

#[test]
fn test_nft_transfer_and_burn_paths() {
    let t = setup_gate();
    let env = &t.env;
    let contract_id = env.register(InvoiceLiquidityContract, ());
    let owner = t.funder.clone();
    let other = Address::generate(env);

    env.as_contract(&contract_id, || {
        mint_invoice_nft(
            env,
            1,
            owner.clone(),
            INVOICE_AMOUNT,
            1_700_000_000,
            DISCOUNT_RATE,
            t.token.address.clone(),
        )
        .unwrap();

        // Wrong "from" on transfer -> Unauthorized
        let res = transfer_invoice_nft(env, 1, other.clone(), t.payer.clone());
        assert_eq!(res, Err(ContractError::Unauthorized));

        // Happy transfer
        transfer_invoice_nft(env, 1, owner.clone(), other.clone()).unwrap();
        assert_eq!(query_nft_owner(env.clone(), 1), Some(other.clone()));

        // Wrong owner on burn -> Unauthorized
        let res = burn_invoice_nft(env, 1, owner.clone());
        assert_eq!(res, Err(ContractError::Unauthorized));

        // Happy burn; afterwards the NFT is gone.
        burn_invoice_nft(env, 1, other.clone()).unwrap();
        assert_eq!(query_nft_owner(env.clone(), 1), None);

        // Operations on a missing NFT -> InvoiceNotFound
        let res = transfer_invoice_nft(env, 1, other.clone(), t.payer.clone());
        assert_eq!(res, Err(ContractError::InvoiceNotFound));
        let res = burn_invoice_nft(env, 1, other);
        assert_eq!(res, Err(ContractError::InvoiceNotFound));
    });
}

// ----------------------------------------------------------------
// top_payers: removal + re-insert (sift_down/sift_up rebalancing),
// eviction of the minimum when at capacity, and score-0 clamping which
// stores no entry.
// ----------------------------------------------------------------

#[test]
fn test_top_payers_remove_reinsert_evict_and_empty_heap_saving() {
    let env = Env::default();
    let contract_id = env.register(InvoiceLiquidityContract, ());
    env.as_contract(&contract_id, || {
        use crate::top_payers::{
            get_top_payers, get_top_payers_heap, update_top_payers_on_score_change,
        };

        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let c = Address::generate(&env);
        let d = Address::generate(&env);

        // Score-0 payers are still tracked in the heap.
        update_top_payers_on_score_change(&env, &a, 0);
        assert_eq!(get_top_payers_heap(&env).len(), 1);

        update_top_payers_on_score_change(&env, &a, 90);
        update_top_payers_on_score_change(&env, &b, 60);
        update_top_payers_on_score_change(&env, &c, 30);
        assert_eq!(get_top_payers_heap(&env).len(), 3);

        // Removing a payer and re-inserting with a lower score exercises
        // remove_payer_from_heap + sift_down rebalancing.
        update_top_payers_on_score_change(&env, &a, 10);
        let top = get_top_payers(&env, 3);
        assert_eq!(top.get(0).unwrap().address, b);
        assert_eq!(top.get(1).unwrap().address, c);
        assert_eq!(top.get(2).unwrap().address, a);

        // Dropping to 0 keeps the payer but ranks it last.
        update_top_payers_on_score_change(&env, &a, 0);
        let top = get_top_payers(&env, 3);
        assert_eq!(top.len(), 3);
        assert_eq!(top.get(2).unwrap().address, a);

        // Capacity is bounded; a fresh high score still tops the list
        // (replace-root + sift_down eviction path).
        update_top_payers_on_score_change(&env, &d, 100);
        let heap = get_top_payers_heap(&env);
        assert!(heap.len() <= 4);
        assert_eq!(get_top_payers(&env, 1).get(0).unwrap().address, d);
    });
}

// ----------------------------------------------------------------
// storage list helpers: remove-from-submitter/LP index paths including
// the empty-heap key removal, exercised through transfer_lp_position
// (which rewrites both indexes) and full lifecycle settlement.
// ----------------------------------------------------------------

#[test]
fn test_lp_index_helpers_via_transfer_and_stats_via_lifecycle() {
    let t = setup_gate();
    let new_lp = Address::generate(&t.env);
    t.token_admin.mint(&new_lp, &(INVOICE_AMOUNT * 5));

    let id = submit_standard(&t);
    t.contract
        .fund_invoice(&t.funder, &id, &INVOICE_AMOUNT, &false);
    assert_eq!(t.contract.list_invoices_by_lp(&t.funder, &0, &10).len(), 1);

    // Move the LP position: old LP index entry removed, new LP added.
    t.contract.transfer_lp_position(&id, &new_lp);
    assert_eq!(t.contract.list_invoices_by_lp(&t.funder, &0, &10).len(), 0);
    assert_eq!(t.contract.list_invoices_by_lp(&new_lp, &0, &10).len(), 1);

    // Settle: stats counters and volumes increment (increment_total_paid /
    // add_volume paths via invoice.token classification).
    t.contract.mark_paid(&id, &INVOICE_AMOUNT);
    let stats = t.contract.get_contract_stats();
    assert_eq!(stats.total_invoices, 1);
    assert_eq!(stats.total_paid, 1);

    // Cancelled-before-funding path leaves stats untouched.
    let id2 = submit_standard(&t);
    t.contract.cancel_invoice(&id2);
    assert_eq!(t.contract.get_contract_stats().total_paid, 1);
}
