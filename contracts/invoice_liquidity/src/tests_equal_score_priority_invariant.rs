//! Issue #1039 — equal-score candidate-group priority invariant.
//!
//! The invariant enforced by `resolve_fund_queue` via
//! `queue_invariants::top_score_and_equal_candidates`:
//!   * every LP whose CURRENT score equals the maximum is a candidate;
//!   * nothing else is;
//!   * membership never depends on join order (persisted position is
//!     irrelevant to candidacy).
//!
//! Scenarios covered:
//!  - Scattered-tie adversarial case: snapshot scores monotone (so the #1036
//!    verification passes), current scores tie the maximum at the
//!    non-adjacent indices {1, 3, 7} — all three must be candidates and
//!    nothing outside the group may be
//!  - Single-candidate case (unique current maximum)
//!  - All-tied worst case at the cap (len = MAX_FUND_QUEUE_LEN = 50):
//!    candidate group is the entire queue
//!  - Boundary len 1
//!  - Authorization case: callers cannot force a non-candidate winner — the
//!    drawn winner is always in the group, resolution is caller-independent,
//!    and a non-candidate LP cannot fund afterwards
//!  - Post-condition consistency: the fused single-pass engine agrees with
//!    the two standalone diagnostic helpers on every scenario

#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Vec,
};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30;

struct GroupTestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    #[allow(dead_code)]
    token: TokenClient<'static>,
    freelancer: Address,
    payer: Address,
}

fn setup_group() -> GroupTestEnv {
    let env = Env::default();
    env.mock_all_auths();

    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_addr = usdc_id.address();

    let token = TokenClient::new(&env, &usdc_addr);
    let token_admin = StellarAssetClient::new(&env, &usdc_addr);

    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    token_admin.mint(&payer, &(INVOICE_AMOUNT * 100));

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);
    token_admin.mint(&contract.address, &(INVOICE_AMOUNT * 1000));

    let xlm_admin = Address::generate(&env);
    let xlm_id = env.register_stellar_asset_contract_v2(xlm_admin);
    let xlm_addr = xlm_id.address();

    let eurc_addr = Address::generate(&env);
    contract.initialize(&usdc_admin, &usdc_addr, &eurc_addr, &xlm_addr);

    let mut ledger = env.ledger().get();
    ledger.timestamp = 1_700_000_000;
    ledger.sequence_number = 100;
    env.ledger().set(ledger);

    GroupTestEnv {
        env,
        contract,
        token,
        freelancer,
        payer,
    }
}

fn submit_invoice_group(t: &GroupTestEnv) -> u64 {
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    )
}

fn advance_ledgers(env: &Env, delta: u32) {
    let mut info = env.ledger().get();
    info.sequence_number += delta;
    info.timestamp += u64::from(delta) * 5;
    env.ledger().set(info);
}

fn set_score(t: &GroupTestEnv, lp: &Address, score: u32) {
    let env = &t.env;
    let lp = lp.clone();
    t.env.as_contract(&t.contract.address, || {
        crate::invoice::set_lp_score(env, &lp, score);
    });
}

/// Persist a hand-built queue with MONOTONE snapshot scores (so the Issue
/// #1036 structural verification accepts it) after one legitimate join has
/// set `FundQueueOpenedAt`. Current scores are then driven independently via
/// `set_score`, which is what decouples the ranking key from the sort key
/// (Issue #1019) and lets the tied set scatter.
fn seed_monotone_queue(t: &GroupTestEnv, id: u64, lps: &[Address], snapshot: &[u32]) {
    assert_eq!(lps.len(), snapshot.len());
    let first = lps[0].clone();
    t.contract.join_fund_queue(&first, &id);
    let env = &t.env;
    let mut queue: Vec<LpFundRequest> = Vec::new(env);
    for i in 0..lps.len() {
        queue.push_back(LpFundRequest {
            lp: lps[i].clone(),
            score: snapshot[i],
        });
    }
    t.env.as_contract(&t.contract.address, || {
        crate::invoice::save_fund_queue(env, id, &queue);
    });
}

/// Run the standalone diagnostics and the fused engine over `id`'s persisted
/// queue, asserting they agree — the engine is defined by the diagnostics.
fn assert_group_agrees_with_diagnostics(
    t: &GroupTestEnv,
    id: u64,
    want_best: u32,
    want_group: &[u32],
) {
    let env = &t.env;
    t.env.as_contract(&t.contract.address, || {
        let queue = crate::invoice::get_fund_queue(env, id);
        let best = crate::queue_invariants::current_score_max(env, &queue);
        assert_eq!(best, want_best, "current_score_max");
        let group = crate::queue_invariants::equal_score_candidate_group(env, &queue, best);
        assert_eq!(group.len(), want_group.len() as u32, "group size");
        for (k, want) in want_group.iter().enumerate() {
            assert_eq!(
                group.get(k as u32).unwrap(),
                *want,
                "candidate index at position {k}: the group must be \
                 {{ current score == max }} in ascending index order, \
                 independent of join order"
            );
        }
        let (fused_best, fused_group) =
            crate::queue_invariants::top_score_and_equal_candidates(env, &queue);
        assert_eq!(fused_best, best, "fused engine max must match diagnostic");
        assert_eq!(
            fused_group.len(),
            group.len(),
            "fused engine group must match diagnostic"
        );
        for k in 0..group.len() {
            assert_eq!(
                fused_group.get(k).unwrap(),
                group.get(k).unwrap(),
                "fused engine group entries must match diagnostic"
            );
        }
    });
}

// ── Scattered-tie adversarial case: group = {1, 3, 7} ───────────────────────

#[test]
fn test_scattered_tie_group_membership_is_position_independent() {
    let t = setup_group();
    let id = submit_invoice_group(&t);

    // Eight LPs at persisted (snapshot) positions 0..7, scores strictly
    // descending — monotone, so the #1036 guard accepts it.
    let mut lps: std::vec::Vec<Address> = std::vec::Vec::new();
    for _ in 0..8 {
        lps.push(Address::generate(&t.env));
    }
    let snapshot: [u32; 8] = [100, 90, 80, 70, 60, 50, 40, 30];
    let current: [u32; 8] = [70, 75, 65, 75, 40, 35, 30, 75];
    for i in 0..8 {
        set_score(&t, &lps[i], current[i]);
    }
    seed_monotone_queue(&t, id, &lps, &snapshot);

    // Current maximum is 75, held by persisted positions 1, 3 and 7 —
    // non-adjacent, NOT a prefix. Position 0's snapshot (100) is stale.
    assert_group_agrees_with_diagnostics(&t, id, 75, &[1, 3, 7]);

    advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS);
    let winner = t.contract.resolve_fund_queue(&id);
    assert!(
        winner == lps[1] || winner == lps[3] || winner == lps[7],
        "winner must be a member of the scattered candidate group {{1,3,7}}"
    );
    assert_ne!(
        winner, lps[0],
        "the stale highest-SNAPSHOT entry (position 0) must NOT win"
    );
}

// ── Single candidate: unique current maximum ─────────────────────────────────

#[test]
fn test_single_candidate_wins_deterministically() {
    let t = setup_group();
    let id = submit_invoice_group(&t);

    let lp_a = Address::generate(&t.env);
    let lp_b = Address::generate(&t.env);
    let lp_c = Address::generate(&t.env);
    // Persisted (snapshot) order is descending a > b > c, but the CURRENT
    // unique maximum sits at position 1 (lp_b) — not the prefix head.
    set_score(&t, &lp_b, 90);
    set_score(&t, &lp_a, 70);
    set_score(&t, &lp_c, 60);
    seed_monotone_queue(
        &t,
        id,
        &[lp_a.clone(), lp_b.clone(), lp_c.clone()],
        &[80, 70, 60],
    );

    assert_group_agrees_with_diagnostics(&t, id, 90, &[1]);

    advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS);
    assert_eq!(t.contract.resolve_fund_queue(&id), lp_b);
}

// ── Boundary: len 1 ──────────────────────────────────────────────────────────

#[test]
fn test_len_one_group_is_sole_member() {
    let t = setup_group();
    let id = submit_invoice_group(&t);

    let lp = Address::generate(&t.env);
    t.contract.join_fund_queue(&lp, &id);

    assert_group_agrees_with_diagnostics(&t, id, 50, &[0]);
    advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS);
    assert_eq!(t.contract.resolve_fund_queue(&id), lp);
}

// ── All-tied worst case at the cap ───────────────────────────────────────────

#[test]
fn test_all_tied_at_cap_group_is_whole_queue() {
    let t = setup_group();
    let id = submit_invoice_group(&t);
    let token_admin = StellarAssetClient::new(&t.env, &t.token.address);

    // 50 LPs, all at the default score (50): snapshot ties are broken by
    // join order, current scores all equal the maximum — the candidate
    // group is every index 0..49, the worst case the envelope declares.
    let mut lps: std::vec::Vec<Address> = std::vec::Vec::new();
    for _ in 0..crate::constants::MAX_FUND_QUEUE_LEN {
        let lp = Address::generate(&t.env);
        token_admin.mint(&lp, &(INVOICE_AMOUNT * 10));
        t.contract.join_fund_queue(&lp, &id);
        lps.push(lp);
    }

    let env = &t.env;
    t.env.as_contract(&t.contract.address, || {
        let queue = crate::invoice::get_fund_queue(env, id);
        assert_eq!(queue.len(), crate::constants::MAX_FUND_QUEUE_LEN);
        let best = crate::queue_invariants::current_score_max(env, &queue);
        let group = crate::queue_invariants::equal_score_candidate_group(env, &queue, best);
        assert_eq!(
            group.len(),
            crate::constants::MAX_FUND_QUEUE_LEN,
            "all-tied worst case: every entry is a candidate"
        );
        for k in 0..group.len() {
            assert_eq!(group.get(k).unwrap(), k, "group must be all indices");
        }
    });

    advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS);
    let winner = t.contract.resolve_fund_queue(&id);
    assert!(
        lps.contains(&winner),
        "all-tied winner must be one of the queued LPs"
    );
}

// ── Authorization: no caller can force a non-candidate winner ────────────────

#[test]
fn test_caller_cannot_force_non_candidate_winner() {
    let t = setup_group();
    let id = submit_invoice_group(&t);

    let lp_top = Address::generate(&t.env);
    let lp_low = Address::generate(&t.env);
    set_score(&t, &lp_top, 100);
    set_score(&t, &lp_low, 50);
    // lp_low joins first; lp_top is still inserted at position 0 (sorted
    // descending snapshot insertion), so candidacy follows CURRENT scores,
    // never join order or position.
    t.contract.join_fund_queue(&lp_low, &id);
    t.contract.join_fund_queue(&lp_top, &id);
    advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS);

    assert_group_agrees_with_diagnostics(&t, id, 100, &[0]);

    let winner = t.contract.resolve_fund_queue(&id);
    assert_eq!(
        winner, lp_top,
        "a single-candidate group has exactly one possible winner; no caller \
         can bend the draw toward the non-candidate"
    );

    // The winner persisted; any later caller gets the same answer.
    assert_eq!(t.contract.resolve_fund_queue(&id), lp_top);

    // And the non-candidate cannot fund.
    let result = t
        .contract
        .try_fund_invoice(&lp_low, &id, &INVOICE_AMOUNT, &false);
    assert_eq!(result, Err(Ok(ContractError::NotApprovedFunder)));
}
