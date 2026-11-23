#![cfg(test)]

//! Issue #1199 — distribution replay and duplicate-event tests.
//!
//! Verifies how `iln_distribution` behaves when the *same* funding /
//! settlement notification is delivered more than once, and whether replayed
//! claims or duplicated events can inflate the distribution totals.
//!
//! Observed behavior (see `docs/distribution-replay.md`):
//!
//! * `accrue_lp` / `accrue_settlement` carry **no** replay key, nonce or
//!   dedup: each delivered notification is applied verbatim, so a duplicate
//!   notification *does* add to the ledger again (VF-1/VF-2). The protocol's
//!   real replay protection lives upstream, in the ILN core invoice state
//!   machine that decides whether a notification is emitted at all.
//! * `claim_tokens` **is** replay-safe: the persisted `Claimed(claimer)`
//!   high-water mark makes a repeated claim a `0`-returning no-op that mints
//!   nothing and emits nothing (VF-3). This is the invariant that guarantees
//!   replayed claim events/attempts cannot double-count the *minted* pool.
//! * Every accepted accrual publishes exactly one event, so events and totals
//!   stay in lock-step even under replay (VF-4).
//!
//! No Cargo.toml change is required: `proptest` is already a dev-dependency.

use super::*;
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _},
    token::Client as TokenClient,
    Address, Env,
};

#[cfg(test)]
use super::{
    DEFAULT_FREELANCER_REWARD_RATE, DEFAULT_LP_REWARD_RATE, DEFAULT_PAYER_REWARD_RATE,
    HUNDRED_USDC_STROOPS,
};

struct ReplayEnv {
    env: Env,
    dist: IlnDistributionClient<'static>,
    dist_id: Address,
    token: TokenClient<'static>,
}

fn setup() -> ReplayEnv {
    let env = Env::default();
    env.mock_all_auths();

    // Stand-in ILN core address; `mock_all_auths` satisfies its require_auth.
    let iln_id = Address::generate(&env);
    let dist_id = env.register_contract(None, IlnDistribution);
    let dist = IlnDistributionClient::new(&env, &dist_id);

    // SAC administered by the distribution contract (Issue #861).
    let gov_token_id = env.register_stellar_asset_contract_v2(dist_id.clone());
    let token = TokenClient::new(&env, &gov_token_id.address());

    dist.initialize(&iln_id, &gov_token_id.address());

    ReplayEnv {
        env,
        dist,
        dist_id,
        token,
    }
}

/// Number of events the distribution contract emitted during the most
/// recently completed top-level invocation.
fn dist_event_count(env: &Env, dist: &Address) -> usize {
    env.events().all().filter_by_contract(dist).events().len()
}

// ── Accrual replay: additive, not idempotent (verified finding) ──────────────

#[test]
fn replayed_funding_notification_is_additive_not_idempotent() {
    let t = setup();
    let lp = Address::generate(&t.env);

    // The *same* funding notification delivered twice.
    t.dist.accrue_lp(&lp, &HUNDRED_USDC_STROOPS);
    t.dist.accrue_lp(&lp, &HUNDRED_USDC_STROOPS);

    // No replay key ⇒ the ledger counts it twice.
    assert_eq!(t.dist.get_accrual(&lp), DEFAULT_LP_REWARD_RATE * 2);
}

#[test]
fn replayed_settlement_notification_is_additive_not_idempotent() {
    let t = setup();
    let freelancer = Address::generate(&t.env);
    let payer = Address::generate(&t.env);

    t.dist.accrue_settlement(&freelancer, &payer, &true);
    t.dist.accrue_settlement(&freelancer, &payer, &true);

    assert_eq!(
        t.dist.get_accrual(&freelancer),
        DEFAULT_FREELANCER_REWARD_RATE * 2
    );
    assert_eq!(t.dist.get_accrual(&payer), DEFAULT_PAYER_REWARD_RATE * 2);
}

#[test]
fn each_replayed_notification_emits_exactly_one_event_so_totals_track_events() {
    let t = setup();
    let lp = Address::generate(&t.env);
    let freelancer = Address::generate(&t.env);
    let payer = Address::generate(&t.env);

    let funding_replays = 5u32;
    for _ in 0..funding_replays {
        t.dist.accrue_lp(&lp, &HUNDRED_USDC_STROOPS);
        // One notification per delivered message — no coalescing.
        assert_eq!(dist_event_count(&t.env, &t.dist_id), 1);
    }

    let settlement_replays = 5u32;
    for _ in 0..settlement_replays {
        t.dist.accrue_settlement(&freelancer, &payer, &true);
        assert_eq!(dist_event_count(&t.env, &t.dist_id), 1);
    }

    // Totals equal notification-count × per-notification rate, and events
    // never diverge from the ledger.
    assert_eq!(
        t.dist.get_accrual(&lp),
        DEFAULT_LP_REWARD_RATE * i128::from(funding_replays)
    );
    assert_eq!(
        t.dist.get_accrual(&freelancer),
        DEFAULT_FREELANCER_REWARD_RATE * i128::from(settlement_replays)
    );
    assert_eq!(
        t.dist.get_accrual(&payer),
        DEFAULT_PAYER_REWARD_RATE * i128::from(settlement_replays)
    );
}

// ── Claim replay: idempotent (the real double-count guard) ───────────────────

#[test]
fn repeated_claim_is_idempotent_and_never_double_mints() {
    let t = setup();
    let lp = Address::generate(&t.env);
    t.dist.accrue_lp(&lp, &HUNDRED_USDC_STROOPS);

    let first = t.dist.claim_tokens(&lp);
    let second = t.dist.claim_tokens(&lp);
    let third = t.dist.claim_tokens(&lp);

    assert_eq!(first, DEFAULT_LP_REWARD_RATE);
    assert_eq!(second, 0);
    assert_eq!(third, 0);
    // Minted total equals a single accrual regardless of claim-attempt count.
    assert_eq!(t.token.balance(&lp), DEFAULT_LP_REWARD_RATE);
}

#[test]
fn noop_claim_emits_no_duplicate_notification() {
    let t = setup();
    let lp = Address::generate(&t.env);
    t.dist.accrue_lp(&lp, &HUNDRED_USDC_STROOPS);

    t.dist.claim_tokens(&lp); // mints, emits one `claimed`
    assert_eq!(dist_event_count(&t.env, &t.dist_id), 1);

    // Replayed claim: no state change ⇒ no event, so an indexer replaying
    // `claimed` events cannot inflate the UI.
    let replay = t.dist.claim_tokens(&lp);
    assert_eq!(replay, 0);
    assert_eq!(dist_event_count(&t.env, &t.dist_id), 0);
}

#[test]
fn many_claim_attempts_mint_total_earned_exactly_once() {
    let t = setup();
    let lp = Address::generate(&t.env);
    t.dist.accrue_lp(&lp, &HUNDRED_USDC_STROOPS);
    let earned = t.dist.get_accrual(&lp);

    let mut total_minted = 0i128;
    for _ in 0..10 {
        total_minted += t.dist.claim_tokens(&lp);
    }

    assert_eq!(total_minted, earned);
    assert_eq!(t.token.balance(&lp), earned);
}

#[test]
fn replayed_claim_after_rate_increase_mints_only_the_delta_once() {
    let t = setup();
    let lp = Address::generate(&t.env);
    t.dist.accrue_lp(&lp, &HUNDRED_USDC_STROOPS);

    let first = t.dist.claim_tokens(&lp);
    assert_eq!(first, DEFAULT_LP_REWARD_RATE);

    // Double the rate; live earned rises above the claimed high-water mark.
    t.dist.set_lp_reward_rate(&(DEFAULT_LP_REWARD_RATE * 2));

    // The delta is minted exactly once, even if the claim is replayed.
    let delta = t.dist.claim_tokens(&lp);
    let replay = t.dist.claim_tokens(&lp);

    assert_eq!(delta, DEFAULT_LP_REWARD_RATE);
    assert_eq!(replay, 0);
    assert_eq!(t.token.balance(&lp), DEFAULT_LP_REWARD_RATE * 2);
}

// ── Pool conservation under replay (multi-participant) ───────────────────────

#[test]
fn pool_totals_equal_sum_of_unique_claims_under_replay() {
    let t = setup();
    let lp = Address::generate(&t.env);
    let freelancer = Address::generate(&t.env);
    let payer = Address::generate(&t.env);

    // Duplicate notifications inflate each participant's *earned* total ...
    t.dist.accrue_lp(&lp, &HUNDRED_USDC_STROOPS);
    t.dist.accrue_lp(&lp, &HUNDRED_USDC_STROOPS);
    t.dist.accrue_settlement(&freelancer, &payer, &true);
    t.dist.accrue_settlement(&freelancer, &payer, &true);

    // ... but repeated claims still mint each participant's earned total once.
    let expected_lp = DEFAULT_LP_REWARD_RATE * 2;
    let expected_fr = DEFAULT_FREELANCER_REWARD_RATE * 2;
    let expected_pay = DEFAULT_PAYER_REWARD_RATE * 2;

    for _ in 0..3 {
        t.dist.claim_tokens(&lp);
        t.dist.claim_tokens(&freelancer);
        t.dist.claim_tokens(&payer);
    }

    assert_eq!(t.token.balance(&lp), expected_lp);
    assert_eq!(t.token.balance(&freelancer), expected_fr);
    assert_eq!(t.token.balance(&payer), expected_pay);
    assert_eq!(
        t.token.balance(&lp) + t.token.balance(&freelancer) + t.token.balance(&payer),
        expected_lp + expected_fr + expected_pay
    );
}

// ── Property: replayed accruals + replayed claims never over-mint ────────────

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    /// For any number of replayed funding notifications and any number of
    /// claim attempts, the cumulative minted amount equals the (replay-
    /// inflated) earned total exactly once — claims are idempotent, so
    /// replaying a claim can never push the minted pool above `total_earned`.
    #[test]
    fn prop_replayed_claims_never_exceed_earned(
        replays in 1u32..8,
        claim_attempts in 1u32..12,
    ) {
        let t = setup();
        let lp = Address::generate(&t.env);

        for _ in 0..replays {
            t.dist.accrue_lp(&lp, &HUNDRED_USDC_STROOPS);
        }
        let earned = t.dist.get_accrual(&lp);
        prop_assert_eq!(earned, DEFAULT_LP_REWARD_RATE * i128::from(replays));

        let mut total_minted = 0i128;
        let mut prev_balance = 0i128;
        for _ in 0..claim_attempts {
            total_minted += t.dist.claim_tokens(&lp);

            let balance = t.token.balance(&lp);
            prop_assert!(balance >= prev_balance, "minted balance must be monotonic");
            prev_balance = balance;
        }

        prop_assert_eq!(total_minted, earned);
        prop_assert_eq!(t.token.balance(&lp), earned);
    }
}
