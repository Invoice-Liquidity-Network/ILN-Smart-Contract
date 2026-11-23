#![cfg(test)]

//! Issue #1198 — distribution pool funding and settlement notifications.
//!
//! Verifies that `iln_distribution` keeps its reward ledger (the eventual
//! governance-token *pool* balance it mints from) consistent with the
//! cross-contract *notifications* it publishes, on both the success and the
//! failure/no-op paths:
//!
//! * every accepted `accrue_lp` / `accrue_settlement` / `claim_tokens` /
//!   `set_*_reward_rate` call emits exactly one notification, and the
//!   notification payload agrees with the state change it announces;
//! * a rejected (`accrue_lp` input out of range) or short-circuited
//!   (`claim_tokens` with nothing claimable) call emits none, so an indexer
//!   driven off events cannot diverge from on-chain state;
//! * the cumulative governance tokens minted across all claimers equals the
//!   sum of the individual claims and each claimer's token balance.
//!
//! Design notes (see `docs/distribution-funding-settlement.md`):
//! * Entry points are invoked directly on the distribution client.
//!   `mock_all_auths` satisfies the ILN/claimer `require_auth` checks, so
//!   each call is its own top-level invocation and `env.events().all()`
//!   reflects only that call (see `tests_storage.rs::last_paid_on_time`).
//! * The reward token is a SAC administered by the distribution contract
//!   itself (Issue #861), registered here with `dist_id` as its admin so
//!   `initialize`'s mint-authority invariant holds.

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _},
    token::Client as TokenClient,
    xdr, Address, Env, Symbol, TryFromVal, Val,
};

/// Reward-accounting constants mirrored from `lib.rs` (private there, hence
/// the explicit parent-module import below).
#[cfg(test)]
use super::{
    DEFAULT_FREELANCER_REWARD_RATE, DEFAULT_LP_REWARD_RATE, DEFAULT_PAYER_REWARD_RATE,
    HUNDRED_USDC_STROOPS, MAX_LP_ACCRUAL_PER_CALL,
};

struct NotifyEnv {
    env: Env,
    dist: IlnDistributionClient<'static>,
    dist_id: Address,
    token: TokenClient<'static>,
}

fn setup() -> NotifyEnv {
    let env = Env::default();
    env.mock_all_auths();

    // Stand-in ILN core address; `mock_all_auths` satisfies its require_auth.
    let iln_id = Address::generate(&env);
    let dist_id = env.register_contract(None, IlnDistribution);
    let dist = IlnDistributionClient::new(&env, &dist_id);

    // SAC administered by the distribution contract (Issue #861).
    let gov_token_id = env.register_stellar_asset_contract_v2(dist_id.clone());
    let gov_token = gov_token_id.address();
    let token = TokenClient::new(&env, &gov_token);

    dist.initialize(&iln_id, &gov_token);

    NotifyEnv {
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

/// Decode the data payload of the last event emitted by the distribution
/// contract during the most recently completed top-level invocation.
fn last_dist_event_data(env: &Env, dist: &Address) -> Val {
    let raw = env.events().all().filter_by_contract(dist).events();
    let last = raw
        .last()
        .expect("expected at least one event from the distribution contract");
    let body = match &last.body {
        xdr::ContractEventBody::V0(body) => body,
    };
    Val::try_from_val(env, &body.data).expect("distribution event data must decode to a Val")
}

fn last_lp_accrual(env: &Env, dist: &Address) -> LpVolumeAccrued {
    LpVolumeAccrued::try_from_val(env, &last_dist_event_data(env, dist))
        .expect("last distribution event must be `LpVolumeAccrued`")
}

fn last_settlement(env: &Env, dist: &Address) -> SettlementAccrued {
    SettlementAccrued::try_from_val(env, &last_dist_event_data(env, dist))
        .expect("last distribution event must be `SettlementAccrued`")
}

fn last_claim(env: &Env, dist: &Address) -> TokensClaimed {
    TokensClaimed::try_from_val(env, &last_dist_event_data(env, dist))
        .expect("last distribution event must be `TokensClaimed`")
}

fn last_rate_update(env: &Env, dist: &Address) -> RewardRateUpdated {
    RewardRateUpdated::try_from_val(env, &last_dist_event_data(env, dist))
        .expect("last distribution event must be `RewardRateUpdated`")
}

// ── Funding accrual: success path ────────────────────────────────────────────

#[test]
fn funding_accrual_updates_balance_and_emits_matching_notification() {
    let t = setup();
    let lp = Address::generate(&t.env);

    t.dist.accrue_lp(&lp, &HUNDRED_USDC_STROOPS);

    assert_eq!(dist_event_count(&t.env, &t.dist_id), 1);
    let event = last_lp_accrual(&t.env, &t.dist_id);
    assert_eq!(event.lp, lp);
    assert_eq!(event.amount_usdc_equivalent, HUNDRED_USDC_STROOPS);

    // 100 USDC at the default LP rate earns exactly one rate unit.
    assert_eq!(t.dist.get_accrual(&lp), DEFAULT_LP_REWARD_RATE);
}

#[test]
fn funding_accrual_accumulates_balance_across_successive_notifications() {
    let t = setup();
    let lp = Address::generate(&t.env);

    t.dist.accrue_lp(&lp, &HUNDRED_USDC_STROOPS);
    t.dist.accrue_lp(&lp, &HUNDRED_USDC_STROOPS);

    assert_eq!(t.dist.get_accrual(&lp), DEFAULT_LP_REWARD_RATE * 2);
    // Each accepted call publishes exactly one notification; the ledger only
    // reflects the call under test (see `tests_storage.rs`).
    assert_eq!(dist_event_count(&t.env, &t.dist_id), 1);
}

#[test]
fn exact_ceiling_funding_amount_is_accepted_and_notified() {
    let t = setup();
    let lp = Address::generate(&t.env);

    t.dist.accrue_lp(&lp, &MAX_LP_ACCRUAL_PER_CALL);

    assert_eq!(dist_event_count(&t.env, &t.dist_id), 1);
    let event = last_lp_accrual(&t.env, &t.dist_id);
    assert_eq!(event.amount_usdc_equivalent, MAX_LP_ACCRUAL_PER_CALL);
    assert_eq!(
        t.dist.get_accrual(&lp),
        (MAX_LP_ACCRUAL_PER_CALL / HUNDRED_USDC_STROOPS) * DEFAULT_LP_REWARD_RATE
    );
}

// ── Funding accrual: rejected paths emit no notification ─────────────────────

#[test]
fn zero_funding_amount_is_a_silent_no_op_without_notification() {
    let t = setup();
    let lp = Address::generate(&t.env);

    t.dist.accrue_lp(&lp, &0);

    assert_eq!(dist_event_count(&t.env, &t.dist_id), 0);
    assert_eq!(t.dist.get_accrual(&lp), 0);
}

#[test]
fn negative_funding_amount_is_a_silent_no_op_without_notification() {
    let t = setup();
    let lp = Address::generate(&t.env);

    t.dist.accrue_lp(&lp, &-1);
    t.dist.accrue_lp(&lp, &i128::MIN);

    assert_eq!(dist_event_count(&t.env, &t.dist_id), 0);
    assert_eq!(t.dist.get_accrual(&lp), 0);
}

#[test]
fn over_ceiling_funding_amount_is_a_silent_no_op_without_notification() {
    let t = setup();
    let lp = Address::generate(&t.env);

    t.dist.accrue_lp(&lp, &(MAX_LP_ACCRUAL_PER_CALL + 1));
    t.dist.accrue_lp(&lp, &i128::MAX);

    assert_eq!(dist_event_count(&t.env, &t.dist_id), 0);
    assert_eq!(t.dist.get_accrual(&lp), 0);
}

#[test]
fn rejected_funding_after_a_successful_one_still_notifies_nothing() {
    let t = setup();
    let lp = Address::generate(&t.env);

    t.dist.accrue_lp(&lp, &HUNDRED_USDC_STROOPS);
    let earned = t.dist.get_accrual(&lp);

    t.dist.accrue_lp(&lp, &(MAX_LP_ACCRUAL_PER_CALL + 1));

    assert_eq!(dist_event_count(&t.env, &t.dist_id), 0);
    assert_eq!(t.dist.get_accrual(&lp), earned);
}

#[test]
fn sub_hundred_usdc_volume_notifies_but_truncates_to_zero_reward() {
    let t = setup();
    let lp = Address::generate(&t.env);

    // One stroop short of 100 USDC.
    t.dist.accrue_lp(&lp, &(HUNDRED_USDC_STROOPS - 1));

    // The notification fires because volume *was* recorded ...
    assert_eq!(dist_event_count(&t.env, &t.dist_id), 1);
    // ... but integer division floors the reward to zero: the announced
    // volume is not the same as announced reward-bearing volume.
    assert_eq!(t.dist.get_accrual(&lp), 0);
    assert_eq!(t.dist.claim_tokens(&lp), 0);
}

// ── Settlement accrual ───────────────────────────────────────────────────────

#[test]
fn on_time_settlement_notifies_and_rewards_freelancer_and_payer() {
    let t = setup();
    let freelancer = Address::generate(&t.env);
    let payer = Address::generate(&t.env);

    t.dist.accrue_settlement(&freelancer, &payer, &true);

    assert_eq!(dist_event_count(&t.env, &t.dist_id), 1);
    let event = last_settlement(&t.env, &t.dist_id);
    assert_eq!(event.freelancer, freelancer);
    assert_eq!(event.payer, payer);
    assert!(event.settled_on_time);

    assert_eq!(
        t.dist.claim_tokens(&freelancer),
        DEFAULT_FREELANCER_REWARD_RATE
    );
    assert_eq!(t.dist.claim_tokens(&payer), DEFAULT_PAYER_REWARD_RATE);
}

#[test]
fn late_settlement_notifies_and_rewards_freelancer_only() {
    let t = setup();
    let freelancer = Address::generate(&t.env);
    let payer = Address::generate(&t.env);

    t.dist.accrue_settlement(&freelancer, &payer, &false);

    assert_eq!(dist_event_count(&t.env, &t.dist_id), 1);
    let event = last_settlement(&t.env, &t.dist_id);
    assert_eq!(event.freelancer, freelancer);
    assert_eq!(event.payer, payer);
    assert!(!event.settled_on_time);

    assert_eq!(
        t.dist.claim_tokens(&freelancer),
        DEFAULT_FREELANCER_REWARD_RATE
    );
    assert_eq!(t.dist.claim_tokens(&payer), 0);
}

#[test]
fn repeated_settlements_are_not_deduplicated_and_each_notifies() {
    let t = setup();
    let freelancer = Address::generate(&t.env);
    let payer = Address::generate(&t.env);

    for _ in 0..3 {
        t.dist.accrue_settlement(&freelancer, &payer, &true);
        // Every accepted call emits exactly one settlement notification.
        assert_eq!(dist_event_count(&t.env, &t.dist_id), 1);
    }

    assert_eq!(
        t.dist.get_accrual(&freelancer),
        DEFAULT_FREELANCER_REWARD_RATE * 3
    );
    assert_eq!(t.dist.get_accrual(&payer), DEFAULT_PAYER_REWARD_RATE * 3);
}

#[test]
fn self_settlement_credits_the_same_address_twice() {
    let t = setup();
    let participant = Address::generate(&t.env);

    t.dist.accrue_settlement(&participant, &participant, &true);

    assert_eq!(dist_event_count(&t.env, &t.dist_id), 1);
    let event = last_settlement(&t.env, &t.dist_id);
    assert_eq!(event.freelancer, participant);
    assert_eq!(event.payer, participant);

    // Freelancer + on-time payer rewards both accrue to the same address.
    assert_eq!(
        t.dist.get_accrual(&participant),
        DEFAULT_FREELANCER_REWARD_RATE + DEFAULT_PAYER_REWARD_RATE
    );
}

// ── Claims: mint notification matches the pool balance ───────────────────────

#[test]
fn claim_mints_notifies_and_balance_matches_minted_amount() {
    let t = setup();
    let lp = Address::generate(&t.env);
    t.dist.accrue_lp(&lp, &HUNDRED_USDC_STROOPS);

    let claimed = t.dist.claim_tokens(&lp);

    assert_eq!(claimed, DEFAULT_LP_REWARD_RATE);
    assert_eq!(dist_event_count(&t.env, &t.dist_id), 1);
    let event = last_claim(&t.env, &t.dist_id);
    assert_eq!(event.claimer, lp);
    assert_eq!(event.amount, claimed);
    assert_eq!(t.token.balance(&lp), claimed);
}

#[test]
fn second_claim_with_nothing_claimable_returns_zero_without_notification() {
    let t = setup();
    let lp = Address::generate(&t.env);
    t.dist.accrue_lp(&lp, &HUNDRED_USDC_STROOPS);

    let first = t.dist.claim_tokens(&lp);
    assert_eq!(first, DEFAULT_LP_REWARD_RATE);

    let second = t.dist.claim_tokens(&lp);

    assert_eq!(second, 0);
    assert_eq!(dist_event_count(&t.env, &t.dist_id), 0);
    assert_eq!(t.token.balance(&lp), first);
}

#[test]
fn claim_without_any_accrual_mints_nothing_and_notifies_nothing() {
    let t = setup();
    let stranger = Address::generate(&t.env);

    assert_eq!(t.dist.claim_tokens(&stranger), 0);

    assert_eq!(dist_event_count(&t.env, &t.dist_id), 0);
    assert_eq!(t.token.balance(&stranger), 0);
}

#[test]
fn pool_minted_supply_equals_sum_of_all_claimed_rewards() {
    let t = setup();
    let lp = Address::generate(&t.env);
    let freelancer = Address::generate(&t.env);
    let payer = Address::generate(&t.env);

    t.dist.accrue_lp(&lp, &HUNDRED_USDC_STROOPS);
    t.dist.accrue_settlement(&freelancer, &payer, &true);

    let lp_claimed = t.dist.claim_tokens(&lp);
    let fr_claimed = t.dist.claim_tokens(&freelancer);
    let pay_claimed = t.dist.claim_tokens(&payer);

    let expected = DEFAULT_LP_REWARD_RATE
        + DEFAULT_FREELANCER_REWARD_RATE
        + DEFAULT_PAYER_REWARD_RATE;
    assert_eq!(lp_claimed + fr_claimed + pay_claimed, expected);

    // The pool's minted supply is exactly the sum of participant balances.
    assert_eq!(t.token.balance(&lp), lp_claimed);
    assert_eq!(t.token.balance(&freelancer), fr_claimed);
    assert_eq!(t.token.balance(&payer), pay_claimed);
    assert_eq!(
        t.token.balance(&lp) + t.token.balance(&freelancer) + t.token.balance(&payer),
        expected
    );
}

// ── Reward-rate governance notifications ─────────────────────────────────────

#[test]
fn reward_rate_updates_notify_with_old_and_new_rate() {
    let t = setup();
    let env = &t.env;

    t.dist.set_lp_reward_rate(&(DEFAULT_LP_REWARD_RATE * 3));
    assert_eq!(dist_event_count(env, &t.dist_id), 1);
    let ev = last_rate_update(env, &t.dist_id);
    assert_eq!(ev.rate_type, Symbol::new(env, "lp_reward"));
    assert_eq!(ev.old_rate, DEFAULT_LP_REWARD_RATE);
    assert_eq!(ev.new_rate, DEFAULT_LP_REWARD_RATE * 3);

    t.dist
        .set_freelancer_reward_rate(&(DEFAULT_FREELANCER_REWARD_RATE + 1));
    let ev = last_rate_update(env, &t.dist_id);
    assert_eq!(ev.rate_type, Symbol::new(env, "freelancer_reward"));
    assert_eq!(ev.old_rate, DEFAULT_FREELANCER_REWARD_RATE);
    assert_eq!(ev.new_rate, DEFAULT_FREELANCER_REWARD_RATE + 1);

    t.dist.set_payer_reward_rate(&(DEFAULT_PAYER_REWARD_RATE + 1));
    let ev = last_rate_update(env, &t.dist_id);
    assert_eq!(ev.rate_type, Symbol::new(env, "payer_reward"));
    assert_eq!(ev.old_rate, DEFAULT_PAYER_REWARD_RATE);
    assert_eq!(ev.new_rate, DEFAULT_PAYER_REWARD_RATE + 1);
}

#[test]
fn rate_increase_re_prices_unclaimed_volume_and_notifies() {
    let t = setup();
    let lp = Address::generate(&t.env);
    t.dist.accrue_lp(&lp, &HUNDRED_USDC_STROOPS); // earns one default rate unit

    assert_eq!(t.dist.claim_tokens(&lp), DEFAULT_LP_REWARD_RATE);

    t.dist.set_lp_reward_rate(&(DEFAULT_LP_REWARD_RATE * 2));
    assert_eq!(dist_event_count(&t.env, &t.dist_id), 1);

    // Same historical volume, re-priced at the new rate ⇒ one extra rate unit.
    assert_eq!(t.dist.claim_tokens(&lp), DEFAULT_LP_REWARD_RATE);
    assert_eq!(t.token.balance(&lp), DEFAULT_LP_REWARD_RATE * 2);
}

#[test]
fn rate_cut_after_claim_does_not_claw_back_and_blocks_further_claim() {
    let t = setup();
    let lp = Address::generate(&t.env);
    t.dist.set_lp_reward_rate(&(DEFAULT_LP_REWARD_RATE * 2));
    t.dist.accrue_lp(&lp, &HUNDRED_USDC_STROOPS);

    let claimed = t.dist.claim_tokens(&lp);
    assert_eq!(claimed, DEFAULT_LP_REWARD_RATE * 2);
    assert_eq!(t.token.balance(&lp), claimed);

    t.dist.set_lp_reward_rate(&0);

    // Live `total_earned` now sits below the already-claimed high-water mark.
    assert_eq!(t.dist.get_accrual(&lp), 0);
    assert_eq!(t.dist.claim_tokens(&lp), 0);
    assert_eq!(t.token.balance(&lp), claimed); // nothing clawed back
}
