#![cfg(test)]

//! Issue #1160 / #1161 — distribution custody and authority regressions
//! (rows D1–D3 of `docs/custody-and-payout-matrix.md`). Double-claim is
//! already covered by `test::lp_earns_on_funding_and_cannot_double_claim`.

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
}

#[test]
fn only_the_iln_contract_can_accrue_rewards() {
    let d = setup();
    let lp = Address::generate(&d.env);
    let imposter = Address::generate(&d.env);

    d.sign_as(
        &imposter,
        "accrue_lp",
        (lp.clone(), HUNDRED_USDC_STROOPS).into_val(&d.env),
    );
    assert!(d.client.try_accrue_lp(&lp, &HUNDRED_USDC_STROOPS).is_err());
    d.sign_as(
        &imposter,
        "accrue_settlement",
        (lp.clone(), lp.clone(), true).into_val(&d.env),
    );
    assert!(d.client.try_accrue_settlement(&lp, &lp, &true).is_err());
    assert_eq!(d.client.get_accrual(&lp), 0);

    d.sign_as(
        &d.iln,
        "accrue_lp",
        (lp.clone(), HUNDRED_USDC_STROOPS).into_val(&d.env),
    );
    d.client.accrue_lp(&lp, &HUNDRED_USDC_STROOPS);
    assert!(d.client.get_accrual(&lp) > 0);
}

#[test]
fn nobody_can_claim_another_participants_rewards() {
    let d = setup();
    let lp = Address::generate(&d.env);
    d.client.accrue_lp(&lp, &HUNDRED_USDC_STROOPS);

    let thief = Address::generate(&d.env);
    d.sign_as(&thief, "claim_tokens", (lp.clone(),).into_val(&d.env));
    assert!(d.client.try_claim_tokens(&lp).is_err());
    assert_eq!(d.gov_token.balance(&lp), 0);
    assert_eq!(d.gov_token.balance(&thief), 0);
}

#[test]
fn reward_rate_setters_accept_only_the_configured_iln_address() {
    // Finding F-06: the setters authenticate the ILN contract, not the
    // governance contract that `iln_governance` actually calls them from.
    let d = setup();
    let governance = Address::generate(&d.env);
    let before = d.client.get_lp_reward_rate();

    d.sign_as(
        &governance,
        "set_lp_reward_rate",
        (before + 1,).into_val(&d.env),
    );
    assert!(d.client.try_set_lp_reward_rate(&(before + 1)).is_err());
    assert_eq!(d.client.get_lp_reward_rate(), before);

    d.sign_as(&d.iln, "set_lp_reward_rate", (before + 1,).into_val(&d.env));
    d.client.set_lp_reward_rate(&(before + 1));
    assert_eq!(d.client.get_lp_reward_rate(), before + 1);
}
