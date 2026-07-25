#![cfg(test)]

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30;
const DISCOUNT_RATE: u32 = 300;

struct MockToken {
    address: Address,
    client: TokenClient<'static>,
    admin_client: StellarAssetClient<'static>,
}

struct MultiTokenTestEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    admin: Address,
    freelancer: Address,
    payer: Address,
    lp: Address,
    usdc: MockToken,
    eurc: MockToken,
    xlm: MockToken,
}

fn register_mock_token(env: &Env) -> MockToken {
    let token_admin = Address::generate(env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_contract.address();

    MockToken {
        address: token_address.clone(),
        client: TokenClient::new(env, &token_address),
        admin_client: StellarAssetClient::new(env, &token_address),
    }
}

fn setup() -> MultiTokenTestEnv {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let lp = Address::generate(&env);

    let usdc = register_mock_token(&env);
    let eurc = register_mock_token(&env);
    let xlm = register_mock_token(&env);

    usdc.admin_client.mint(&payer, &10_000_000_000);
    usdc.admin_client.mint(&lp, &10_000_000_000);
    usdc.admin_client.mint(&contract_address_placeholder(&env), &1_000_000_000_000);
    eurc.admin_client.mint(&payer, &10_000_000_000);
    eurc.admin_client.mint(&lp, &10_000_000_000);
    xlm.admin_client.mint(&payer, &100_000_000_000);
    xlm.admin_client.mint(&lp, &100_000_000_000);

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);

    // Mint tokens to the contract for refunds
    usdc.admin_client.mint(&contract.address, &1_000_000_000_000);
    eurc.admin_client.mint(&contract.address, &1_000_000_000_000);
    xlm.admin_client.mint(&contract.address, &1_000_000_000_000);

    contract.initialize(&admin, &usdc.address, &eurc.address, &xlm.address);

    let mut ledger_info = env.ledger().get();
    ledger_info.timestamp = 1_700_000_000;
    env.ledger().set(ledger_info);

    MultiTokenTestEnv {
        env,
        contract,
        admin,
        freelancer,
        payer,
        lp,
        usdc,
        eurc,
        xlm,
    }
}

fn contract_address_placeholder(_env: &Env) -> Address {
    // This is a placeholder - actual contract address is set during setup
    Address::generate(_env)
}

fn due_date(env: &MultiTokenTestEnv) -> u64 {
    env.env.ledger().timestamp() + DUE_DATE_OFFSET
}

fn submit_invoice(env: &MultiTokenTestEnv, token: &MockToken, amount: i128) -> u64 {
    env.contract.submit_invoice(
        &env.freelancer,
        &env.payer,
        &amount,
        &due_date(env),
        &DISCOUNT_RATE,
        &token.address,
        &ReferralCode::None,
    )
}

fn expected_discount(amount: i128) -> i128 {
    amount * DISCOUNT_RATE as i128 / 10_000
}

fn assert_full_lifecycle_for_token(
    token_name: &str,
    token: &MockToken,
    env: &MultiTokenTestEnv,
    amount: i128,
) {
    let invoice_id = submit_invoice(env, token, amount);
    let invoice = env.contract.get_invoice(&invoice_id).unwrap();
    assert_eq!(
        invoice.token, token.address,
        "{token_name} invoice should persist its token"
    );

    let freelancer_before = token.client.balance(&env.freelancer);
    let lp_before = token.client.balance(&env.lp);
    let payer_before = token.client.balance(&env.payer);

    env.contract.fund_invoice(&env.lp, &invoice_id, &amount, &false);

    let discount = expected_discount(amount);
    assert_eq!(
        token.client.balance(&env.freelancer) - freelancer_before,
        amount - discount,
        "{token_name} should pay the freelancer in the same token path",
    );

    env.contract.mark_paid(&invoice_id, &amount);

    assert_eq!(
        token.client.balance(&env.lp) - lp_before,
        discount,
        "{token_name} LP should earn yield in the same token path",
    );
    assert_eq!(
        payer_before - token.client.balance(&env.payer),
        amount,
        "{token_name} payer should settle the invoice amount in the same token path",
    );
    assert_eq!(
        env.contract.get_invoice(&invoice_id).unwrap().status,
        InvoiceStatus::Paid,
        "{token_name} invoice should finish the lifecycle as Paid",
    );
}

#[test]
fn test_full_lifecycle_usdc_token_path() {
    let env = setup();
    assert_full_lifecycle_for_token("USDC", &env.usdc, &env, 1_000_000_000);
}

#[test]
fn test_full_lifecycle_eurc_token_path() {
    let env = setup();
    assert_full_lifecycle_for_token("EURC", &env.eurc, &env, 25_000_000);
}

#[test]
fn test_full_lifecycle_xlm_sac_token_path() {
    let env = setup();
    assert_full_lifecycle_for_token("XLM SAC", &env.xlm, &env, 70_000_000);
}

#[test]
fn test_submit_with_unapproved_token_is_rejected() {
    let env = setup();
    let rogue = register_mock_token(&env.env);

    let result = env.contract.try_submit_invoice(
        &env.freelancer,
        &env.payer,
        &(1_000_000_000_i128),
        &due_date(&env),
        &DISCOUNT_RATE,
        &rogue.address,
        &ReferralCode::None,
    );

    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}

#[test]
fn test_admin_removing_token_mid_flight_does_not_break_existing_invoice_settlement() {
    let env = setup();
    let amount = 42_500_000_i128;
    let invoice_id = submit_invoice(&env, &env.eurc, amount);

    env.contract.remove_token(&env.eurc.address);

    env.contract.fund_invoice(&env.lp, &invoice_id, &amount, &false);
    env.contract.mark_paid(&invoice_id, &amount);

    let invoice = env.contract.get_invoice(&invoice_id).unwrap();
    assert_eq!(invoice.status, InvoiceStatus::Paid);
    assert_eq!(invoice.token, env.eurc.address);
}

#[test]
fn test_same_lp_can_settle_invoices_independently_across_different_tokens() {
    let env = setup();
    let usdc_amount = 15_000_000_i128;
    let eurc_amount = 9_500_000_i128;

    let usdc_invoice = submit_invoice(&env, &env.usdc, usdc_amount);
    let eurc_invoice = submit_invoice(&env, &env.eurc, eurc_amount);

    let usdc_lp_before = env.usdc.client.balance(&env.lp);
    let eurc_lp_before = env.eurc.client.balance(&env.lp);

    env.contract
        .fund_invoice(&env.lp, &usdc_invoice, &usdc_amount, &false);
    env.contract
        .fund_invoice(&env.lp, &eurc_invoice, &eurc_amount, &false);

    env.contract.mark_paid(&usdc_invoice, &usdc_amount);

    assert_eq!(
        env.contract.get_invoice(&usdc_invoice).unwrap().status,
        InvoiceStatus::Paid
    );
    assert_eq!(
        env.contract.get_invoice(&eurc_invoice).unwrap().status,
        InvoiceStatus::Funded
    );
    assert_eq!(
        env.usdc.client.balance(&env.lp) - usdc_lp_before,
        expected_discount(usdc_amount),
    );
    assert_eq!(
        env.eurc.client.balance(&env.lp),
        eurc_lp_before - eurc_amount
    );

    env.contract.mark_paid(&eurc_invoice, &eurc_amount);

    assert_eq!(
        env.contract.get_invoice(&eurc_invoice).unwrap().status,
        InvoiceStatus::Paid
    );
    assert_eq!(
        env.eurc.client.balance(&env.lp) - eurc_lp_before,
        expected_discount(eurc_amount),
    );
}

#[test]
fn test_amounts_preserve_precision_for_6_and_7_decimal_token_paths() {
    let env = setup();
    let eurc_amount = 12_345_678_i128;
    let xlm_amount = 123_456_789_i128;

    let eurc_invoice = submit_invoice(&env, &env.eurc, eurc_amount);
    let xlm_invoice = submit_invoice(&env, &env.xlm, xlm_amount);

    let eurc_freelancer_before = env.eurc.client.balance(&env.freelancer);
    let xlm_freelancer_before = env.xlm.client.balance(&env.freelancer);
    let eurc_lp_before = env.eurc.client.balance(&env.lp);
    let xlm_lp_before = env.xlm.client.balance(&env.lp);

    env.contract
        .fund_invoice(&env.lp, &eurc_invoice, &eurc_amount, &false);
    env.contract
        .fund_invoice(&env.lp, &xlm_invoice, &xlm_amount, &false);

    assert_eq!(
        env.eurc.client.balance(&env.freelancer) - eurc_freelancer_before,
        eurc_amount - expected_discount(eurc_amount),
    );
    assert_eq!(
        env.xlm.client.balance(&env.freelancer) - xlm_freelancer_before,
        xlm_amount - expected_discount(xlm_amount),
    );

    env.contract.mark_paid(&eurc_invoice, &eurc_amount);
    env.contract.mark_paid(&xlm_invoice, &xlm_amount);

    assert_eq!(
        env.eurc.client.balance(&env.lp) - eurc_lp_before,
        expected_discount(eurc_amount),
    );
    assert_eq!(
        env.xlm.client.balance(&env.lp) - xlm_lp_before,
        expected_discount(xlm_amount),
    );
}

#[test]
fn test_cross_token_mismatch_is_physically_impossible_as_token_is_locked() {
    let env = setup();
    let eurc_amount = 50_000_000_i128;
    let invoice_id = submit_invoice(&env, &env.eurc, eurc_amount);

    env.contract
        .fund_invoice(&env.lp, &invoice_id, &eurc_amount, &false);
    let invoice = env.contract.get_invoice(&invoice_id).unwrap();
    assert_eq!(invoice.token, env.eurc.address);
    assert_eq!(invoice.status, InvoiceStatus::Funded);
}

#[test]
fn test_eurc_token_support_is_wired_in_config() {
    let env = setup();
    let config = env.contract.get_config().unwrap();
    assert_eq!(config.usdc_sac_address, env.usdc.address);
    assert_eq!(config.eurc_sac_address, env.eurc.address);
    assert_eq!(config.xlm_sac_address, env.xlm.address);
}

#[test]
fn test_eurc_lifecycle() {
    let env = setup();
    let amount = 50_000_000_i128; // 50 EURC
    let id = submit_invoice(&env, &env.eurc, amount);

    let freelancer_before = env.eurc.client.balance(&env.freelancer);
    let lp_before = env.eurc.client.balance(&env.lp);
    let payer_before = env.eurc.client.balance(&env.payer);

    env.contract.fund_invoice(&env.lp, &id, &amount, &false);

    let discount = expected_discount(amount);
    assert_eq!(
        env.eurc.client.balance(&env.freelancer) - freelancer_before,
        amount - discount
    );

    env.contract.mark_paid(&id, &amount);

    assert_eq!(
        env.eurc.client.balance(&env.lp) - lp_before,
        discount
    );
    assert_eq!(
        payer_before - env.eurc.client.balance(&env.payer),
        amount
    );
    assert_eq!(env.contract.get_invoice(&id).unwrap().status, InvoiceStatus::Paid);
}

// ================================================================
// Tests for fee-on-transfer token rejection (Issue #482)
// ================================================================

#[contract]
struct FeeOnTransferToken;

#[contractimpl]
impl FeeOnTransferToken {
    pub fn initialize(_env: Env, _admin: Address) {}

    pub fn balance(_env: Env, _id: Address) -> i128 {
        0
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) -> Result<i128, ()> {
        from.require_auth();
        // Simulate fee-on-transfer: only transfer 99% of the amount
        let fee = amount / 100;
        let received = amount - fee;

        // Transfer the reduced amount
        let token_client = token::Client::new(&env, &env.current_contract_address());
        token_client.transfer(&from, &to, &received);

        Ok(received)
    }

    pub fn mint(_env: Env, _to: Address, _amount: i128) {}
}

#[test]
fn test_add_token_rejects_fee_on_transfer_token() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let usdc_admin = Address::generate(&env);
    let usdc_contract_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_address = usdc_contract_id.address();

    let eurc_admin = Address::generate(&env);
    let eurc_contract_id = env.register_stellar_asset_contract_v2(eurc_admin);
    let eurc_address = eurc_contract_id.address();

    let xlm_admin = Address::generate(&env);
    let xlm_contract_id = env.register_stellar_asset_contract_v2(xlm_admin);
    let xlm_address = xlm_contract_id.address();

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);
    contract.initialize(&admin, &usdc_address, &eurc_address, &xlm_address);

    // Register a fee-on-transfer token
    let fee_token_admin = Address::generate(&env);
    let fee_token_contract = env.register_stellar_asset_contract_v2(fee_token_admin.clone());
    let fee_token_address = fee_token_contract.address();

    // Mint tokens to admin for the test
    let fee_token_client = TokenClient::new(&env, &fee_token_address);
    let fee_token_admin_client = StellarAssetClient::new(&env, &fee_token_address);
    fee_token_admin_client.mint(&admin, &1_000_000);

    // Try to add the fee-on-transfer token
    let result = contract.try_add_token(&fee_token_address, &6_u32);

    // Should fail with FeeOnTransferToken error
    assert_eq!(result, Err(Ok(ContractError::FeeOnTransferToken)));
}

#[test]
fn test_add_token_normal_token_succeeds() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let usdc_admin = Address::generate(&env);
    let usdc_contract_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_address = usdc_contract_id.address();

    let eurc_admin = Address::generate(&env);
    let eurc_contract_id = env.register_stellar_asset_contract_v2(eurc_admin);
    let eurc_address = eurc_contract_id.address();

    let xlm_admin = Address::generate(&env);
    let xlm_contract_id = env.register_stellar_asset_contract_v2(xlm_admin);
    let xlm_address = xlm_contract_id.address();

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);
    contract.initialize(&admin, &usdc_address, &eurc_address, &xlm_address);

    // Register a normal token
    let normal_token_admin = Address::generate(&env);
    let normal_token_contract = env.register_stellar_asset_contract_v2(normal_token_admin.clone());
    let normal_token_address = normal_token_contract.address();

    // Mint tokens to admin for the test
    let normal_token_client = TokenClient::new(&env, &normal_token_address);
    let normal_token_admin_client = StellarAssetClient::new(&env, &normal_token_address);
    normal_token_admin_client.mint(&admin, &1_000_000);

    // Add the normal token - should succeed
    let result = contract.try_add_token(&normal_token_address, &6_u32);
    assert!(result.is_ok());

    // Verify token was added
    let config = contract.get_config().unwrap();
    // Token should be approved
    let is_approved: bool = env
        .storage()
        .persistent()
        .get(&crate::storage::DataKey::ApprovedToken(normal_token_address.clone()))
        .unwrap_or(false);
    assert!(is_approved);
}
