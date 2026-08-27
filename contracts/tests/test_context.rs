#![cfg(test)]

use invoice_liquidity::{InvoiceLiquidityContract, InvoiceLiquidityContractClient, ReferralCode};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

const DEFAULT_INVOICE_AMOUNT: i128 = 1_000_000_000;
const _DEFAULT_DISCOUNT_RATE: u32 = 300;
const DEFAULT_DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30;
const DEFAULT_LEDGER_TIMESTAMP: u64 = 1_700_000_000;

#[allow(dead_code)]
pub struct TestContext {
    pub env: Env,
    pub contract: InvoiceLiquidityContractClient<'static>,
    pub usdc: TokenClient<'static>,
    pub eurc: TokenClient<'static>,
    pub xlm: TokenClient<'static>,
    pub submitter: Address,
    pub lp: Address,
    pub payer: Address,
}

#[allow(dead_code)]
impl TestContext {
    pub fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);

        let usdc_admin = Address::generate(&env);
        let usdc_contract_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
        let usdc_address = usdc_contract_id.address();
        let usdc = TokenClient::new(&env, &usdc_address);
        let usdc_admin_client = StellarAssetClient::new(&env, &usdc_address);

        let eurc_admin = Address::generate(&env);
        let eurc_contract_id = env.register_stellar_asset_contract_v2(eurc_admin.clone());
        let eurc_address = eurc_contract_id.address();
        let eurc = TokenClient::new(&env, &eurc_address);
        let eurc_admin_client = StellarAssetClient::new(&env, &eurc_address);

        let xlm_admin = Address::generate(&env);
        let xlm_contract_id = env.register_stellar_asset_contract_v2(xlm_admin.clone());
        let xlm_address = xlm_contract_id.address();
        let xlm = TokenClient::new(&env, &xlm_address);
        let xlm_admin_client = StellarAssetClient::new(&env, &xlm_address);

        let submitter = Address::generate(&env);
        let payer = Address::generate(&env);
        let lp = Address::generate(&env);

        usdc_admin_client.mint(&payer, &(DEFAULT_INVOICE_AMOUNT * 10));
        usdc_admin_client.mint(&lp, &(DEFAULT_INVOICE_AMOUNT * 10));
        eurc_admin_client.mint(&payer, &(DEFAULT_INVOICE_AMOUNT * 10));
        eurc_admin_client.mint(&lp, &(DEFAULT_INVOICE_AMOUNT * 10));
        xlm_admin_client.mint(&payer, &(DEFAULT_INVOICE_AMOUNT * 10));
        xlm_admin_client.mint(&lp, &(DEFAULT_INVOICE_AMOUNT * 10));

        let contract_id = env.register_contract(None, InvoiceLiquidityContract);
        let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);

        usdc_admin_client.mint(&contract.address, &(DEFAULT_INVOICE_AMOUNT * 100));
        eurc_admin_client.mint(&contract.address, &(DEFAULT_INVOICE_AMOUNT * 100));
        xlm_admin_client.mint(&contract.address, &(DEFAULT_INVOICE_AMOUNT * 100));

        contract.initialize(&admin, &usdc_address, &eurc_address, &xlm_address);

        let mut ledger_info = env.ledger().get();
        ledger_info.timestamp = DEFAULT_LEDGER_TIMESTAMP;
        ledger_info.sequence_number = 100;
        env.ledger().set(ledger_info);

        TestContext {
            env,
            contract,
            usdc,
            eurc,
            xlm,
            submitter,
            lp,
            payer,
        }
    }

    pub fn submit_invoice(&self, amount: i128, rate: u32, due_days: u64) -> u64 {
        let due_date = self.env.ledger().timestamp() + due_days;
        self.contract.submit_invoice(
            &self.submitter,
            &self.payer,
            &amount,
            &due_date,
            &rate,
            &self.usdc.address,
            &ReferralCode::None,
        )
    }

    pub fn fund_invoice(&self, invoice_id: u64) {
        self.contract
            .fund_invoice(&self.lp, &invoice_id, &DEFAULT_INVOICE_AMOUNT, &false);
    }

    pub fn mark_paid(&self, invoice_id: u64) {
        self.contract
            .mark_paid(&invoice_id, &DEFAULT_INVOICE_AMOUNT);
    }

    pub fn default_due_date(&self) -> u64 {
        self.env.ledger().timestamp() + DEFAULT_DUE_DATE_OFFSET
    }
}
