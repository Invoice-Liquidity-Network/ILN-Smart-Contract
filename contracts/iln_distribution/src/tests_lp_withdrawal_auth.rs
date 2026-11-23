#![cfg(test)]

//! Audit: distribution LP withdrawal authorization.
//!
//! In `iln_distribution` the only "withdrawal" is `claim_tokens`; the
//! "pending payout" is `total_earned - Claimed` and the "treasury" is the
//! governance-token SAC whose admin is the distribution contract (it mints on
//! claim; it holds no pre-funded balance). Rules verified against `lib.rs`
//! and pinned here (see `docs/distribution-lp-withdrawal-audit.md`):
//!
//! * W1 — `claim_tokens(claimer)` requires `claimer`'s own authorization and
//!   mints only to `claimer`, only against `claimer`'s own accrual keys. No
//!   other address can withdraw, trigger or reduce another LP's payout.
//! * W2 — `Claimed(claimer)` only ever increases (high-water mark). A rate
//!   change can lower `get_accrual` below `Claimed`, in which case a claim
//!   pays 0 (no claw-back, no revert); it can never cause a payout larger
//!   than `earned - claimed`.
//! * W3 — a non-positive earned amount (e.g. a negative governance rate)
//!   yields a 0 claim; it cannot mint or burn tokens.
//! * W4 — pending payouts are per-address; one LP claiming leaves every
//!   other LP's pending amount and balance untouched.
//! * W5 — the LP volume reward is `floor(volume / 100 USDC) * rate`, so
//!   splitting volume across calls cannot round up.
//! * W6 — a rejected re-`initialize` does not rebind the ILN authority or the
//!   governance token.
//!
//! Residual risk (documented, not changed): reward rates are unbounded `i128`
//! and apply retroactively to all accrued volume.

use super::*;
use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    token::Client as TokenClient,
    Address, Env, IntoVal, Val,
};

struct Dist {
    env: Env,
    client: IlnDistributionClient<'static>,
    iln: Address,
    gov_token: TokenClient<'static>,
}

fn setup() -> Dist {
    let env = Env::default();
    env.mock_all_auths();
    let dist_id = env.register_contract(None, IlnDistribution);
    let client = IlnDistributionClient::new(&env, &dist_id);
    let gov_token = env
        .register_stellar_asset_contract_v2(dist_id.clone())
        .address();
    let iln = Address::generate(&env);
    client.initialize(&iln, &gov_token);
    Dist {
        gov_token: TokenClient::new(&env, &gov_token),
        env,
        client,
        iln,
    }
}

impl Dist {
    fn sign_as(&self, who: &Address, fn_name: &'static str, args: soroban_sdk::Vec<Val>) {
        self.env.mock_auths(&[MockAuth {
            address: who,
            invoke: &MockAuthInvoke {
                contract: &self.client.address,
                fn_name,
                args,
                sub_invokes: &[],
            },
        }]);
    }

    fn lp_with_volume(&self, volume: i128) -> Address {
        let lp = Address::generate(&self.env);
        self.client.accrue_lp(&lp, &volume);
        lp
    }
}

/// W1: another address signing for itself cannot claim on an LP's behalf; the
/// LP's pending payout survives and is still claimable by the LP.
#[test]
fn another_signer_cannot_withdraw_an_lps_pending_payout() {
    let d = setup();
    let lp = d.lp_with_volume(HUNDRED_USDC_STROOPS);
    let attacker = Address::generate(&d.env);

    d.sign_as(&attacker, "claim_tokens", (lp.clone(),).into_val(&d.env));
    assert!(d.client.try_claim_tokens(&lp).is_err());
    assert_eq!(d.gov_token.balance(&lp), 0);
    assert_eq!(d.gov_token.balance(&attacker), 0);
    assert_eq!(d.client.get_accrual(&lp), 10_000_000);

    // The attacker's own claim only ever reads the attacker's own keys.
    d.env.mock_all_auths();
    assert_eq!(d.client.claim_tokens(&attacker), 0);
    assert_eq!(d.gov_token.balance(&attacker), 0);
    assert_eq!(d.client.get_accrual(&lp), 10_000_000);

    assert_eq!(d.client.claim_tokens(&lp), 10_000_000);
    assert_eq!(d.gov_token.balance(&lp), 10_000_000);
}

/// W4: one LP's claim never changes another LP's pending payout or balance.
#[test]
fn pending_payouts_are_isolated_per_lp() {
    let d = setup();
    let lp_a = d.lp_with_volume(HUNDRED_USDC_STROOPS);
    let lp_b = d.lp_with_volume(3 * HUNDRED_USDC_STROOPS);

    assert_eq!(d.client.claim_tokens(&lp_a), 10_000_000);
    assert_eq!(d.client.claim_tokens(&lp_a), 0, "repeat claim pays nothing");

    assert_eq!(d.client.get_accrual(&lp_b), 30_000_000);
    assert_eq!(d.gov_token.balance(&lp_b), 0);

    assert_eq!(d.client.claim_tokens(&lp_b), 30_000_000);
    assert_eq!(d.gov_token.balance(&lp_a), 10_000_000);
    assert_eq!(d.gov_token.balance(&lp_b), 30_000_000);
}

/// W2: lowering the rate after a claim never claws back or reverts, and a
/// later raise pays only the difference against the high-water mark.
#[test]
fn lowered_rate_never_claws_back_and_raise_pays_only_the_delta() {
    let d = setup();
    let lp = d.lp_with_volume(HUNDRED_USDC_STROOPS);
    assert_eq!(d.client.claim_tokens(&lp), 10_000_000);

    d.client.set_lp_reward_rate(&1_000_000);
    assert_eq!(d.client.get_accrual(&lp), 1_000_000, "earned fell below claimed");
    assert_eq!(d.client.claim_tokens(&lp), 0, "no claw-back, no revert");
    assert_eq!(d.gov_token.balance(&lp), 10_000_000);

    d.client.set_lp_reward_rate(&30_000_000);
    assert_eq!(d.client.get_accrual(&lp), 30_000_000);
    assert_eq!(d.client.claim_tokens(&lp), 20_000_000, "only earned - claimed");
    assert_eq!(d.gov_token.balance(&lp), 30_000_000);
}

/// W3: a negative rate yields a non-positive accrual and a 0 claim: nothing is
/// minted, and restoring a sane rate later pays the full amount.
#[test]
fn negative_rate_cannot_mint_or_burn_through_a_claim() {
    let d = setup();
    let lp = d.lp_with_volume(HUNDRED_USDC_STROOPS);

    d.client.set_lp_reward_rate(&-5_000_000);
    assert!(d.client.get_accrual(&lp) <= 0);
    assert_eq!(d.client.claim_tokens(&lp), 0);
    assert_eq!(d.gov_token.balance(&lp), 0);

    d.client.set_lp_reward_rate(&DEFAULT_LP_REWARD_RATE);
    assert_eq!(d.client.claim_tokens(&lp), 10_000_000);
}

/// A participant with nothing accrued gets a no-op claim, not an error or mint.
#[test]
fn claim_without_accrual_is_a_noop() {
    let d = setup();
    let nobody = Address::generate(&d.env);
    assert_eq!(d.client.claim_tokens(&nobody), 0);
    assert_eq!(d.gov_token.balance(&nobody), 0);
}

/// Repeated claims interleaved with new accruals pay only the new delta.
#[test]
fn claim_after_additional_accrual_pays_only_the_new_delta() {
    let d = setup();
    let lp = d.lp_with_volume(HUNDRED_USDC_STROOPS);
    assert_eq!(d.client.claim_tokens(&lp), 10_000_000);

    d.client.accrue_lp(&lp, &HUNDRED_USDC_STROOPS);
    assert_eq!(d.client.get_accrual(&lp), 20_000_000);
    assert_eq!(d.client.claim_tokens(&lp), 10_000_000);
    assert_eq!(d.gov_token.balance(&lp), 20_000_000);
    assert_eq!(d.client.claim_tokens(&lp), 0);
}

/// W5: floor rounding means two sub-threshold accruals cannot round up twice.
#[test]
fn split_volume_cannot_round_up_the_payout() {
    let d = setup();
    let lp = Address::generate(&d.env);
    let ninety_nine = 99 * HUNDRED_USDC_STROOPS / 100;

    d.client.accrue_lp(&lp, &ninety_nine);
    assert_eq!(d.client.get_accrual(&lp), 0, "below one unit earns nothing yet");
    d.client.accrue_lp(&lp, &ninety_nine);

    // 198 USDC of volume = 1 whole unit (floor), not 2.
    assert_eq!(d.client.claim_tokens(&lp), 10_000_000);
}

/// W6: a rejected re-initialization leaves the ILN authority and governance
/// token bound to their original values.
#[test]
fn failed_reinitialize_does_not_rebind_authority() {
    let d = setup();
    let new_iln = Address::generate(&d.env);
    let lp = Address::generate(&d.env);

    assert!(d
        .client
        .try_initialize(&new_iln, &d.gov_token.address)
        .is_err());
    assert!(d.client.verify_mint_authority());

    // The would-be new ILN cannot accrue; the original one still can.
    d.sign_as(
        &new_iln,
        "accrue_lp",
        (lp.clone(), HUNDRED_USDC_STROOPS).into_val(&d.env),
    );
    assert!(d.client.try_accrue_lp(&lp, &HUNDRED_USDC_STROOPS).is_err());
    assert_eq!(d.client.get_accrual(&lp), 0);

    d.sign_as(
        &d.iln,
        "accrue_lp",
        (lp.clone(), HUNDRED_USDC_STROOPS).into_val(&d.env),
    );
    d.client.accrue_lp(&lp, &HUNDRED_USDC_STROOPS);
    assert_eq!(d.client.get_accrual(&lp), 10_000_000);
}

/// Rejected (non-positive / oversized) accruals leave the pending payout
/// untouched, so they cannot be used to reset or inflate a withdrawal.
#[test]
fn rejected_accruals_do_not_change_pending_payout() {
    let d = setup();
    let lp = d.lp_with_volume(HUNDRED_USDC_STROOPS);

    d.client.accrue_lp(&lp, &0);
    d.client.accrue_lp(&lp, &-HUNDRED_USDC_STROOPS);
    d.client.accrue_lp(&lp, &(MAX_LP_ACCRUAL_PER_CALL + 1));

    assert_eq!(d.client.get_accrual(&lp), 10_000_000);
    assert_eq!(d.client.claim_tokens(&lp), 10_000_000);
}
