#![cfg(test)]

use super::*;
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, IntoVal,
};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30;

#[contracttype]
enum DistDataKey {
    Lp(Address),
}

#[contract]
struct MockDistribution;

#[contractimpl]
impl MockDistribution {
    pub fn accrue_lp(env: Env, lp: Address, amount_usdc_equivalent: i128) {
        let key = DistDataKey::Lp(lp);
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&key, &(current + amount_usdc_equivalent));
    }

    pub fn lp_volume(env: Env, lp: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DistDataKey::Lp(lp))
            .unwrap_or(0)
    }
}

struct DistTestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: TokenClient<'static>,
    freelancer: Address,
    payer: Address,
    funder: Address,
}

fn setup() -> DistTestEnv {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);

    let usdc_admin = Address::generate(&env);
    let usdc_contract_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_address = usdc_contract_id.address();
    let token = TokenClient::new(&env, &usdc_address);
    let token_admin = StellarAssetClient::new(&env, &usdc_address);

    let eurc_admin = Address::generate(&env);
    let eurc_contract_id = env.register_stellar_asset_contract_v2(eurc_admin);
    let eurc_address = eurc_contract_id.address();

    let xlm_admin = Address::generate(&env);
    let xlm_contract_id = env.register_stellar_asset_contract_v2(xlm_admin);
    let xlm_address = xlm_contract_id.address();

    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let funder = Address::generate(&env);

    token_admin.mint(&funder, &(INVOICE_AMOUNT * 10));
    token_admin.mint(&payer, &(INVOICE_AMOUNT * 10));

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);
    token_admin.mint(&contract.address, &(INVOICE_AMOUNT * 100));

    contract.initialize(&admin, &usdc_address, &eurc_address, &xlm_address);

    let mut ledger_info = env.ledger().get();
    ledger_info.timestamp = 1_700_000_000;
    env.ledger().set(ledger_info);

    DistTestEnv {
        env,
        contract,
        token,
        freelancer,
        payer,
        funder,
    }
}

#[test]
fn test_set_distribution_contract_succeeds_as_admin() {
    let t = setup();
    let dist_id = t.env.register_contract(None, MockDistribution);

    let result = t.contract.try_set_distribution_contract(&dist_id);
    assert!(result.is_ok());
}

#[test]
fn test_set_distribution_contract_rejects_non_admin() {
    let t = setup();
    let dist_id = t.env.register_contract(None, MockDistribution);
    let imposter = Address::generate(&t.env);

    t.env.mock_auths(&[MockAuth {
        address: &imposter,
        invoke: &MockAuthInvoke {
            contract: &t.contract.address,
            fn_name: "set_distribution_contract",
            args: (dist_id.clone(),).into_val(&t.env),
            sub_invokes: &[],
        },
    }]);

    let result = t.contract.try_set_distribution_contract(&dist_id);
    assert!(result.is_err());
}

#[test]
fn test_notify_distribution_funding_called_during_funding() {
    let t = setup();
    let dist_id = t.env.register_contract(None, MockDistribution);
    let dist = MockDistributionClient::new(&t.env, &dist_id);

    t.contract.set_distribution_contract(&dist_id);

    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &false);

    assert_eq!(dist.lp_volume(&t.funder), INVOICE_AMOUNT);
}

#[test]
fn test_funding_succeeds_without_distribution_contract_set() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    );

    let result = t
        .contract
        .try_fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &false);
    assert!(result.is_ok());
}
