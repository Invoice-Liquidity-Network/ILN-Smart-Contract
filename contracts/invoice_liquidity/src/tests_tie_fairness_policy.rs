//! Issue #1035 — Focused tests for the configurable tie fairness policy
//!
//! Scenarios covered:
//!  - Default parity: with no policy configured, tie resolution keeps the
//!    pre-#1035 PRNG behaviour (winner is a tied LP, tie event still fires)
//!  - `get_queue_tie_policy` fails closed to `UniformRandom` when absent
//!  - Authorization boundary: a non-admin caller cannot flip the policy
//!    even with every auth mocked, and the admin cannot do it twice inside
//!    the parameter cooldown (rate limit), but can flip it back afterwards
//!    (recovery path)
//!  - `DeterministicFirst` reproducibility: identical queues resolve to the
//!    same (lowest-index) tied LP every time
//!  - `tied.len() == 1` boundary under `DeterministicFirst` (no tie event)
//!  - Full-queue boundary (`MAX_FUND_QUEUE_LEN` entries, all tied) and the
//!    rejection of entry #51
//!  - Adversarial case: equally-scored LPs where join order would favour
//!    the queue head — the default policy must not hand the head every win
//!    (the Issue #708 property survives #1035), while the opt-in
//!    `DeterministicFirst` is asserted to behave as documented.

#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30;

struct PolicyTestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: TokenClient<'static>,
    token_admin: StellarAssetClient<'static>,
    admin: Address,
    freelancer: Address,
    payer: Address,
    lp_a: Address,
    lp_b: Address,
    lp_c: Address,
}

/// Read the stored tie policy from inside the contract's instance-storage
/// context (direct `env.storage().instance()` access outside `as_contract`
/// would panic — same wrapper idiom as tests_max_depth_extension.rs).
fn stored_policy(t: &PolicyTestEnv) -> TiePolicy {
    let contract_id = t.contract.address.clone();
    let env = t.env.clone();
    t.env
        .as_contract(&contract_id, || get_queue_tie_policy(&env))
}

fn setup_policy() -> PolicyTestEnv {
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
    // initialize's first argument is the contract admin (see sibling
    // tests_tie_breaking::setup_tie): usdc_admin is the admin here.
    contract.initialize(&usdc_admin, &usdc_addr, &eurc_addr, &xlm_addr);

    let mut ledger = env.ledger().get();
    ledger.timestamp = 1_700_000_000;
    ledger.sequence_number = 100;
    env.ledger().set(ledger);

    PolicyTestEnv {
        env,
        contract,
        token,
        token_admin,
        admin: usdc_admin,
        freelancer,
        payer,
        lp_a,
        lp_b,
        lp_c,
    }
}

fn submit_invoice_policy(t: &PolicyTestEnv) -> u64 {
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

/// Resolve the queue after the maturity delay has elapsed.
fn resolve_mature(t: &PolicyTestEnv, id: &u64) -> Address {
    advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS);
    t.contract.resolve_fund_queue(id)
}

// ── Default policy: fail-closed + behaviour parity ───────────────────────────

#[test]
fn test_absent_policy_fails_closed_to_uniform_random() {
    let t = setup_policy();
    // Nothing was ever written: the reader must return the pre-#1035
    // behaviour's identity, UniformRandom, and never anything else.
    assert_eq!(stored_policy(&t), TiePolicy::UniformRandom);
}

#[test]
fn test_default_policy_matches_pre_issue_tie_behaviour() {
    let t = setup_policy();
    let id = submit_invoice_policy(&t);

    // Both LPs default to score 50 — genuine tie, no policy configured.
    t.contract.join_fund_queue(&t.lp_a, &id);
    t.contract.join_fund_queue(&t.lp_b, &id);
    advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS);

    let before = t.env.events().all().events().len();
    let winner = t.contract.resolve_fund_queue(&id);
    let after = t.env.events().all().events().len();

    assert!(
        winner == t.lp_a || winner == t.lp_b,
        "default (UniformRandom) resolution must pick a tied LP, got {winner:?}"
    );
    // Same three events as pre-#1035: attempt + FundQueueTieBroken +
    // FundQueueResolved.
    assert_eq!(
        after - before,
        3,
        "default policy must emit exactly (attempt + tie_broken + resolved), got {after}"
    );
}

// ── Authorization boundary ───────────────────────────────────────────────────

#[test]
fn test_non_admin_cannot_set_tie_fairness_policy() {
    let t = setup_policy();
    // Even with every authorization mocked, a caller that is not the stored
    // admin is rejected fail-closed — no bypass through auth mocking.
    let result = t
        .contract
        .try_set_tie_fairness_policy(&t.lp_a, &TiePolicy::DeterministicFirst);
    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    // The storage record must be untouched.
    assert_eq!(stored_policy(&t), TiePolicy::UniformRandom);
}

#[test]
fn test_admin_set_is_rate_limited_and_recoverable() {
    let t = setup_policy();

    t.contract
        .set_tie_fairness_policy(&t.admin, &TiePolicy::DeterministicFirst);
    assert_eq!(stored_policy(&t), TiePolicy::DeterministicFirst);

    // Second flip inside the admin-parameter cooldown is rejected.
    let result = t
        .contract
        .try_set_tie_fairness_policy(&t.admin, &TiePolicy::UniformRandom);
    assert_eq!(result, Err(Ok(ContractError::RateLimited)));
    assert_eq!(
        stored_policy(&t),
        TiePolicy::DeterministicFirst,
        "a rate-limited call must not change the stored policy"
    );

    // Recovery path (AC: mistaken flip is undone by the same entry point):
    // after the cooldown elapses, the admin flips it back.
    advance_ledgers(&t.env, DEFAULT_RATE_LIMIT_LEDGERS as u32);
    t.contract
        .set_tie_fairness_policy(&t.admin, &TiePolicy::UniformRandom);
    assert_eq!(stored_policy(&t), TiePolicy::UniformRandom);
}

#[test]
fn test_policy_set_emits_event() {
    let t = setup_policy();
    t.contract
        .set_tie_fairness_policy(&t.admin, &TiePolicy::DeterministicFirst);
    // events().all() reflects the most recent top-level call; it must
    // contain the tie_fairness_policy_updated publication (the call has
    // no other side event).
    let events = t.env.events().all();
    assert!(
        !events.events().is_empty(),
        "set_tie_fairness_policy must publish an event (Issue #1035 audit trail)"
    );
}

// ── DeterministicFirst: reproducibility ──────────────────────────────────────

#[test]
fn test_deterministic_first_winner_is_reproducible() {
    let t = setup_policy();
    t.contract
        .set_tie_fairness_policy(&t.admin, &TiePolicy::DeterministicFirst);

    // Two independent queues with the same scores and the same join order.
    let id1 = submit_invoice_policy(&t);
    t.contract.join_fund_queue(&t.lp_a, &id1);
    t.contract.join_fund_queue(&t.lp_b, &id1);
    t.contract.join_fund_queue(&t.lp_c, &id1);
    let w1 = resolve_mature(&t, &id1);

    let id2 = submit_invoice_policy(&t);
    t.contract.join_fund_queue(&t.lp_a, &id2);
    t.contract.join_fund_queue(&t.lp_b, &id2);
    t.contract.join_fund_queue(&t.lp_c, &id2);
    let w2 = resolve_mature(&t, &id2);

    // lp_a joined first among equal-score LPs → lowest tied index → wins
    // every time, with no PRNG involved.
    assert_eq!(w1, t.lp_a);
    assert_eq!(w2, t.lp_a);
    assert_eq!(w1, w2, "DeterministicFirst resolutions must be replayable");
}

// ── Boundary: single-entry "tie" set (tied.len() == 1) ───────────────────────

#[test]
fn test_single_lp_boundary_under_deterministic_first_no_tie_event() {
    let t = setup_policy();
    t.contract
        .set_tie_fairness_policy(&t.admin, &TiePolicy::DeterministicFirst);

    let id = submit_invoice_policy(&t);
    t.contract.join_fund_queue(&t.lp_a, &id);
    advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS);

    let before = t.env.events().all().events().len();
    let winner = t.contract.resolve_fund_queue(&id);
    let after = t.env.events().all().events().len();

    assert_eq!(winner, t.lp_a);
    // attempt + resolved only — the tie branch (and its event) never fires
    // when there is nothing to break, whatever the policy says.
    assert_eq!(
        after - before,
        2,
        "single-LP resolution must not emit FundQueueTieBroken under DeterministicFirst"
    );
}

// ── Boundary: full queue (MAX_FUND_QUEUE_LEN, everything tied) ───────────────

#[test]
fn test_full_queue_boundary_under_deterministic_first() {
    let t = setup_policy();
    t.contract
        .set_tie_fairness_policy(&t.admin, &TiePolicy::DeterministicFirst);

    let id = submit_invoice_policy(&t);
    let mut lps: Vec<Address> = Vec::new(&t.env);
    for _ in 0..crate::constants::MAX_FUND_QUEUE_LEN {
        let lp = Address::generate(&t.env);
        t.token_admin.mint(&lp, &(INVOICE_AMOUNT * 10));
        lps.push_back(lp);
    }
    for i in 0..lps.len() {
        let lp = lps.get(i).unwrap();
        t.contract.join_fund_queue(&lp, &id);
    }

    // Entry #51 must be rejected — the queue stays bounded under the new
    // control too (no unbounded state growth, Issue #1035 AC).
    let outsider = Address::generate(&t.env);
    let result = t.contract.try_join_fund_queue(&outsider, &id);
    assert_eq!(result, Err(Ok(ContractError::QueueFull)));

    let winner = resolve_mature(&t, &id);
    assert_eq!(
        winner,
        lps.get(0).unwrap(),
        "DeterministicFirst over a full 50-way tie must pick the queue head"
    );
}

// ── Adversarial: join-order gaming ───────────────────────────────────────────

#[test]
fn test_default_policy_does_not_always_favour_queue_head_adversarially() {
    let t = setup_policy();

    let mut head_wins = 0u32;
    let mut second_wins = 0u32;
    const TRIALS: u32 = 30;

    for _ in 0..TRIALS {
        let id = submit_invoice_policy(&t);
        // lp_a always joins first (the "queue head" an attacker would race
        // to be), lp_b second — genuine score tie both times.
        t.contract.join_fund_queue(&t.lp_a, &id);
        t.contract.join_fund_queue(&t.lp_b, &id);
        advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS);
        let winner = t.contract.resolve_fund_queue(&id);
        if winner == t.lp_a {
            head_wins += 1;
        } else if winner == t.lp_b {
            second_wins += 1;
        } else {
            panic!("winner must be one of the tied LPs");
        }
    }

    // The Issue #708 guarantee must survive the #1035 refactor of this
    // expression: under the default policy, racing to the queue head buys
    // you nothing with certainty (P(head wins all 30) ≈ 2^-30 under a
    // working uniform draw).
    assert_eq!(head_wins + second_wins, TRIALS);
    assert!(
        head_wins < TRIALS && second_wins > 0,
        "default UniformRandom must not hand the queue head every win \
         (head={head_wins} second={second_wins})"
    );
}

#[test]
fn test_deterministic_first_flips_adversarial_property_as_documented() {
    let t = setup_policy();
    t.contract
        .set_tie_fairness_policy(&t.admin, &TiePolicy::DeterministicFirst);

    // Opting in is exactly opting into join-order determinism — asserted so
    // the trade-off is pinned by a test, not just prose (the admin must be
    // able to see, from the event audit trail, which regime is live).
    for _ in 0..5 {
        let id = submit_invoice_policy(&t);
        t.contract.join_fund_queue(&t.lp_a, &id);
        t.contract.join_fund_queue(&t.lp_b, &id);
        let winner = resolve_mature(&t, &id);
        assert_eq!(
            winner, t.lp_a,
            "queue head must win under DeterministicFirst"
        );
    }
}
