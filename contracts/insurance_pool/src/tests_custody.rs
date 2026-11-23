#![cfg(test)]

//! Issue #1160 — insurance pool custody regressions (rows I1–I4 of
//! `docs/custody-and-payout-matrix.md`). Complements `test.rs`, which already
//! covers per-invoice claim idempotency and reserve-bounded payouts.

use super::*;
use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, IntoVal, Val,
};

const COVERAGE: i128 = 1_000_000_000;

struct Pool {
    env: Env,
    client: InsurancePoolClient<'static>,
    token: TokenClient<'static>,
    sac: StellarAssetClient<'static>,
    lp: Address,
}

fn setup() -> Pool {
    let env = Env::default();
    env.mock_all_auths();
    let client = InsurancePoolClient::new(&env, &env.register_contract(None, InsurancePool));
    let token_addr = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    client.initialize(&Address::generate(&env), &COVERAGE, &token_addr);
    Pool {
        lp: Address::generate(&env),
        token: TokenClient::new(&env, &token_addr),
        sac: StellarAssetClient::new(&env, &token_addr),
        client,
        env,
    }
}

impl Pool {
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

    /// Booked reserves (liquid + backstop) must equal the tokens actually held.
    fn assert_books_match_tokens(&self) {
        let booked = self.client.get_pool_balance() + self.client.get_backstop_balance();
        assert_eq!(booked, self.token.balance(&self.client.address));
    }
}

#[test]
fn failed_premium_transfer_books_nothing() {
    let p = setup();
    // `lp` holds no tokens, so the transfer inside deposit_premium fails.
    assert!(p.client.try_deposit_premium(&p.lp, &500).is_err());
    assert_eq!(p.client.get_premiums_paid(&p.lp), 0);
    assert_eq!(p.client.get_pool_balance(), 0);
    assert!(!p.client.is_enrolled(&p.lp));
    p.assert_books_match_tokens();
}

#[test]
fn only_the_admin_can_trigger_a_claim_payout() {
    let p = setup();
    p.sac.mint(&p.lp, &COVERAGE);
    p.client.deposit_premium(&p.lp, &COVERAGE);

    let imposter = Address::generate(&p.env);
    p.sign_as(
        &imposter,
        "claim",
        (1_u64, imposter.clone()).into_val(&p.env),
    );
    assert!(p.client.try_claim(&1, &imposter).is_err());
    assert!(!p.client.is_claimed(&1));
    assert_eq!(p.token.balance(&imposter), 0);
    p.assert_books_match_tokens();
}

#[test]
fn only_the_admin_can_order_a_backstop_top_up() {
    let p = setup();
    p.sac.mint(&p.lp, &1_000);
    p.sign_as(
        &p.lp,
        "top_up_backstop",
        (p.lp.clone(), 1_000_i128).into_val(&p.env),
    );
    assert!(p.client.try_top_up_backstop(&p.lp, &1_000).is_err());
    assert_eq!(p.client.get_backstop_balance(), 0);
    assert_eq!(p.token.balance(&p.lp), 1_000);
}

#[test]
fn claims_draw_liquid_then_backstop_and_never_exceed_reserves() {
    let p = setup();
    p.sac.mint(&p.lp, &(COVERAGE * 4));
    p.client.deposit_premium(&p.lp, &(COVERAGE / 4));
    p.client.top_up_backstop(&p.lp, &(COVERAGE / 2));
    p.assert_books_match_tokens();

    // Tier-3 coverage (premiums >= 25% of cap) pays the full cap, which is
    // more than the liquid balance, so the rest comes from the backstop.
    let payout = p.client.claim(&1, &p.lp);
    assert_eq!(payout, COVERAGE / 2 + COVERAGE / 4);
    assert_eq!(p.client.get_pool_balance(), 0);
    assert_eq!(p.client.get_backstop_balance(), 0);
    p.assert_books_match_tokens();

    // Nothing left: a second invoice's claim cannot overdraw.
    assert!(p.client.try_claim(&2, &p.lp).is_err());
    p.assert_books_match_tokens();
}
