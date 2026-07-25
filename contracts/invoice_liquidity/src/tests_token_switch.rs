#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30; // 30 days

struct TestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: TokenClient<'static>,
    eurc_token: TokenClient<'static>,
    non_allowlisted_token: TokenClient<'static>,
    admin: Address,
    freelancer: Address,
    payer: Address,
}

fn setup() -> TestEnv {
    let env = Env::default();
    env.mock_all_auths();

    let usdc_admin = Address::generate(&env);
    let usdc_address = env.register_stellar_asset_contract_v2(usdc_admin).address();
    let token = TokenClient::new(&env, &usdc_address);

    let eurc_admin = Address::generate(&env);
    let eurc_address = env.register_stellar_asset_contract_v2(eurc_admin).address();
    let eurc_token = TokenClient::new(&env, &eurc_address);

    let junk_admin = Address::generate(&env);
    let junk_address = env.register_stellar_asset_contract_v2(junk_admin).address();
    let non_allowlisted_token = TokenClient::new(&env, &junk_address);

    let admin = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);

    let xlm_admin = Address::generate(&env);
    let xlm_address = env.register_stellar_asset_contract_v2(xlm_admin).address();

    contract.initialize(&admin, &usdc_address, &eurc_address, &xlm_address);

    let mut ledger_info = env.ledger().get();
    ledger_info.timestamp = 1_700_000_000;
    env.ledger().set(ledger_info);

    TestEnv {
        env,
        contract,
        token,
        eurc_token,
        non_allowlisted_token,
        admin,
        freelancer,
        payer,
    }
}

#[test]
fn test_convert_invoice_token_success() {
    let t = setup();

    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.contract.submit_invoice(&ReferralCode::None);

    // Switch from USDC to EURC
    t.contract
        .convert_invoice_token(&t.freelancer, &invoice_id, &t.eurc_token.address);

    let invoice = t.contract.get_invoice(&invoice_id).unwrap();
    assert_eq!(invoice.token, t.eurc_token.address);
}

#[test]
fn test_convert_invoice_token_non_submitter_fails() {
    let t = setup();

    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.contract.submit_invoice(&ReferralCode::None);

    let someone_else = Address::generate(&t.env);
    let result =
        t.contract
            .try_convert_invoice_token(&someone_else, &invoice_id, &t.eurc_token.address);

    assert!(result.is_err());
    // Authorized error or Unauthorized depending on how require_submitter works
}

#[test]
fn test_convert_invoice_token_non_allowlisted_fails() {
    let t = setup();

    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.contract.submit_invoice(&ReferralCode::None);

    let result = t.contract.try_convert_invoice_token(
        &t.freelancer,
        &invoice_id,
        &t.non_allowlisted_token.address,
    );

    assert!(result.is_err());
    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}

#[test]
fn test_convert_invoice_token_after_funding_fails() {
    let t = setup();

    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.contract.submit_invoice(&ReferralCode::None);

    // Fund it
    let funder = Address::generate(&t.env);
    let stellar_asset = StellarAssetClient::new(&t.env, &t.token.address);
    stellar_asset.mint(&funder, &INVOICE_AMOUNT);

    t.contract
        .fund_invoice(&funder, &invoice_id, &INVOICE_AMOUNT);

    // Try to switch token after funding
    let result =
        t.contract
            .try_convert_invoice_token(&t.freelancer, &invoice_id, &t.eurc_token.address);

    assert!(result.is_err());
    assert_eq!(result, Err(Ok(ContractError::AlreadyFunded)));
}

#[test]
fn test_convert_invoice_token_after_expiry_fails() {
    let t = setup();

    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let invoice_id = t.contract.submit_invoice(&ReferralCode::None);

    // Advance time past due date
    let mut ledger = t.env.ledger().get();
    ledger.timestamp = due_date + 1;
    t.env.ledger().set(ledger);

    let result =
        t.contract
            .try_convert_invoice_token(&t.freelancer, &invoice_id, &t.eurc_token.address);

    assert!(result.is_err());
    assert_eq!(result, Err(Ok(ContractError::InvoiceExpired)));
}
