//! Issue #1036 — fail-closed structural verification of the persisted fund
//! queue inside `resolve_fund_queue`.
//!
//! Scenarios covered:
//!  - Success: a legitimately built, sorted queue resolves normally
//!  - Adversarial: a hand-corrupted persisted queue that is out of order is
//!    rejected (`save_fund_queue` written directly, bypassing join policy)
//!  - Adversarial: a duplicated LP in the persisted queue is rejected
//!  - Adversarial: a persisted queue longer than `MAX_FUND_QUEUE_LEN` is
//!    rejected
//!  - Boundary: len 1 and len `MAX_FUND_QUEUE_LEN` (50) both verify and resolve
//!  - Guard ordering (authorization case): the structural check does NOT run
//!    before the maturity gate — an immature + corrupt queue still fails with
//!    `QueueNotMature` first, and only after maturing does the integrity
//!    verdict surface
//!  - Fail-closed, no state growth: a rejected resolution persists no winner,
//!    mutates no queue state, and repeats deterministically

#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Vec,
};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30;

struct OrderTestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    #[allow(dead_code)]
    token: TokenClient<'static>,
    freelancer: Address,
    payer: Address,
    lp_a: Address,
    lp_b: Address,
    lp_c: Address,
}

fn setup_order() -> OrderTestEnv {
    let env = Env::default();
    env.mock_all_auths();

    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_addr = usdc_id.address();

    let token = TokenClient::new(&env, &usdc_addr);
    let token_admin = StellarAssetClient::new(&env, &usdc_addr);

    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let lp_a = Address::generate(&env);
    let lp_b = Address::generate(&env);
    let lp_c = Address::generate(&env);

    for lp in [&lp_a, &lp_b, &lp_c] {
        token_admin.mint(lp, &(INVOICE_AMOUNT * 100));
    }
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

    OrderTestEnv {
        env,
        contract,
        token,
        freelancer,
        payer,
        lp_a,
        lp_b,
        lp_c,
    }
}

fn submit_invoice_order(t: &OrderTestEnv) -> u64 {
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

/// One legitimate join so `FundQueueOpenedAt` is set (the fail-closed #1013
/// gate would otherwise fire before the structural check is reachable), then
/// overwrite the persisted queue with a caller-supplied vector via
/// `save_fund_queue` directly — the exact "corrupted/restored state" the
/// Issue #1036 guard exists to catch, which no public entry point can produce.
fn corrupt_persisted_queue(t: &OrderTestEnv, id: u64, queue: &Vec<LpFundRequest>) {
    t.contract.join_fund_queue(&t.lp_a, &id);
    t.env.as_contract(&t.contract.address, || {
        crate::invoice::save_fund_queue(&t.env, id, queue);
    });
}

fn request(lp: Address, score: u32) -> LpFundRequest {
    LpFundRequest { lp, score }
}

// ── Success: a sorted, deduped, capped queue resolves ────────────────────────

#[test]
fn test_sorted_queue_passes_verification_and_resolves() {
    let t = setup_order();
    let id = submit_invoice_order(&t);

    t.contract.join_fund_queue(&t.lp_a, &id);
    t.contract.join_fund_queue(&t.lp_b, &id);
    advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS);

    let winner = t.contract.resolve_fund_queue(&id);
    assert!(
        winner == t.lp_a || winner == t.lp_b,
        "a legitimately built queue must resolve, got {winner:?}"
    );
}

// ── Adversarial: out-of-order persisted queue ────────────────────────────────

#[test]
fn test_out_of_order_queue_is_rejected_fail_closed() {
    let t = setup_order();
    let id = submit_invoice_order(&t);

    // Ascending snapshot scores — the opposite of the maintained invariant.
    let bad: Vec<LpFundRequest> = Vec::new(&t.env);
    let mut bad = bad;
    bad.push_back(request(t.lp_b.clone(), 40));
    bad.push_back(request(t.lp_a.clone(), 60));
    corrupt_persisted_queue(&t, id, &bad);

    advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS);

    let events_before = t.env.events().all().events().len();
    let result = t.contract.try_resolve_fund_queue(&id);
    let new_events = t.env.events().all().events().len() - events_before;

    assert_eq!(
        result,
        Err(Ok(ContractError::IncompatibleInterfaceVersion)),
        "out-of-order persisted queue must be rejected, never silently re-sorted"
    );
    // `fund_queue_ordering_rejected` + `queue_resolve_attempt`(success=false).
    assert!(
        new_events >= 2,
        "rejection must emit an event (ordering_rejected + failed attempt), got {new_events}"
    );
}

// ── Adversarial: duplicated LP in the persisted queue ────────────────────────

#[test]
fn test_duplicate_lp_queue_is_rejected() {
    let t = setup_order();
    let id = submit_invoice_order(&t);

    // Sorted by score, but lp_b appears twice: join-time dedupe (2374-2378)
    // is bypassed by direct persistence, and without this guard lp_b would
    // hold two draws in the tie scan — a fairness bypass.
    let bad: Vec<LpFundRequest> = Vec::new(&t.env);
    let mut bad = bad;
    bad.push_back(request(t.lp_b.clone(), 50));
    bad.push_back(request(t.lp_b.clone(), 50));
    corrupt_persisted_queue(&t, id, &bad);

    advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS);

    let result = t.contract.try_resolve_fund_queue(&id);
    assert_eq!(
        result,
        Err(Ok(ContractError::IncompatibleInterfaceVersion)),
        "duplicated LP in the persisted queue must fail closed"
    );
}

// ── Adversarial: persisted queue longer than the cap ─────────────────────────

#[test]
fn test_overlong_queue_is_rejected() {
    let t = setup_order();
    let id = submit_invoice_order(&t);

    // MAX_FUND_QUEUE_LEN + 1 entries, sorted descending so ONLY the length
    // check can reject it — proves the length guard is independently enforced.
    let mut bad: Vec<LpFundRequest> = Vec::new(&t.env);
    for i in 0..=crate::constants::MAX_FUND_QUEUE_LEN {
        bad.push_back(request(Address::generate(&t.env), 100 - i));
    }
    corrupt_persisted_queue(&t, id, &bad);

    advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS);

    let result = t.contract.try_resolve_fund_queue(&id);
    assert_eq!(
        result,
        Err(Ok(ContractError::IncompatibleInterfaceVersion)),
        "a persisted queue above MAX_FUND_QUEUE_LEN must be rejected: the PRNG \
         narrowing and the tie-fanout envelope are only safe under the cap"
    );
}

// ── Boundary: len 1 and len MAX_FUND_QUEUE_LEN ───────────────────────────────

#[test]
fn test_len_one_queue_verifies_and_resolves() {
    let t = setup_order();
    let id = submit_invoice_order(&t);

    t.contract.join_fund_queue(&t.lp_a, &id);
    advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS);

    assert_eq!(t.contract.resolve_fund_queue(&id), t.lp_a);
}

#[test]
fn test_len_at_cap_queue_verifies_and_resolves() {
    let t = setup_order();
    let id = submit_invoice_order(&t);
    let token_admin = StellarAssetClient::new(&t.env, &t.token.address);

    // Fill exactly MAX_FUND_QUEUE_LEN entries with strictly descending
    // snapshot scores (50..=99) — the maximum-length happy path of the
    // verification scan.
    for i in 0..crate::constants::MAX_FUND_QUEUE_LEN {
        let lp = Address::generate(&t.env);
        token_admin.mint(&lp, &(INVOICE_AMOUNT * 10));
        let env = &t.env;
        t.env.as_contract(&t.contract.address, || {
            crate::invoice::set_lp_score(env, &lp, 50 + i);
        });
        t.contract.join_fund_queue(&lp, &id);
    }

    advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS);
    let winner = t.contract.resolve_fund_queue(&id);
    // The highest score was joined last (50 + 49 = 99) and join_fund_queue
    // inserts descending, so it sits at index 0; current scores are
    // unchanged, so verification passes and the scan picks that LP.
    let top_lp = t.env.as_contract(&t.contract.address, || {
        crate::invoice::get_fund_queue(&t.env, id)
            .get(0)
            .unwrap()
            .lp
    });
    assert_eq!(
        winner, top_lp,
        "at-cap sorted queue must resolve to the top-score entry"
    );
}

// ── Guard ordering: maturity gate wins over the structural check ─────────────

#[test]
fn test_ordering_check_runs_after_maturity_gate() {
    let t = setup_order();
    let id = submit_invoice_order(&t);

    let bad: Vec<LpFundRequest> = Vec::new(&t.env);
    let mut bad = bad;
    bad.push_back(request(t.lp_b.clone(), 40));
    bad.push_back(request(t.lp_a.clone(), 60));
    corrupt_persisted_queue(&t, id, &bad);

    // Immature AND corrupt: the caller-facing refusal (QueueNotMature) must
    // win — the structural check must not run before the maturity gate.
    let result = t.contract.try_resolve_fund_queue(&id);
    assert_eq!(
        result,
        Err(Ok(ContractError::QueueNotMature)),
        "maturity gate must be evaluated before the #1036 structural verification"
    );

    // Once mature, the integrity verdict surfaces.
    advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS);
    let result = t.contract.try_resolve_fund_queue(&id);
    assert_eq!(result, Err(Ok(ContractError::IncompatibleInterfaceVersion)));
}

// ── Fail-closed, no state growth, deterministic rejection ────────────────────

#[test]
fn test_rejected_resolution_persists_nothing_and_repeats() {
    let t = setup_order();
    let id = submit_invoice_order(&t);

    let bad: Vec<LpFundRequest> = Vec::new(&t.env);
    let mut bad = bad;
    bad.push_back(request(t.lp_b.clone(), 40));
    bad.push_back(request(t.lp_a.clone(), 60));
    corrupt_persisted_queue(&t, id, &bad);
    advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS);

    for attempt in 0..3 {
        assert_eq!(
            t.contract.try_resolve_fund_queue(&id),
            Err(Ok(ContractError::IncompatibleInterfaceVersion)),
            "rejection must be deterministic on attempt {attempt}"
        );
    }

    // No winner persisted, queue not mutated (no silent repair, no state
    // growth): exactly the corrupted 2-entry vector remains.
    t.env.as_contract(&t.contract.address, || {
        assert!(
            crate::invoice::get_queue_resolution(&t.env, id).is_none(),
            "a rejected resolution must not persist an approved funder"
        );
        let queue = crate::invoice::get_fund_queue(&t.env, id);
        assert_eq!(queue.len(), 2, "rejection must not mutate the queue");
        assert_eq!(queue.get(0).unwrap().lp, t.lp_b);
        assert_eq!(queue.get(1).unwrap().lp, t.lp_a);
    });
}
