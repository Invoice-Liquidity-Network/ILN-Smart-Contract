#![no_std]
// Soroban's contractimpl/contractargs macros generate client functions that
// mirror the contract's public interface — these may exceed the 7-argument
// threshold when the source function itself has many arguments.
#![allow(clippy::too_many_arguments)]

#[cfg(test)]
extern crate std;

pub mod access;
pub mod config;
pub mod errors;
pub mod events;
pub mod invoice;
pub mod nft;
pub mod rate_logic;
pub mod storage;
pub mod top_payers;
use access::*;
pub mod constants;
pub mod oracle_interface;
#[cfg(test)]
mod tests_discount_rate;
#[cfg(test)]
mod tests_lifecycle_integration;
#[cfg(test)]
mod tests_nft_query;
mod tests_lp_pagination;
mod tests_new_features;
mod tests_pagination;
mod tests_regression;
#[cfg(test)]
#[cfg(test)]
mod tests_stress;
mod tests_xlm_support;

pub use crate::invoice::{
    AppealRecord, Invoice, InvoiceParams, InvoiceStatus, LpFundRequest, ReferralCode,
    ReputationProfile, ReputationScore, TopPayerEntry,
};
pub use crate::nft::InvoiceNftMetadata;
pub use crate::storage::DataKey;
pub use config::{Config, ConfigError};
pub use errors::ContractError;
use soroban_sdk::{
    contract, contractimpl, token::Client as TokenClient, vec, Address, BytesN, Env, IntoVal,
    Symbol, Vec,
};

use crate::storage::get_admin;
use events::{
    AdminChanged, AppealResolved, ContractPaused, ContractUnpaused, ContractUpgraded,
    DefaultAppealed, DisputeResolved, FundQueueResolved, FundRequested, InvoiceCancelled,
    InvoiceDefaulted, InvoiceDisputed, InvoiceExpired, InvoiceFunded, InvoicePaid,
    InvoicePartiallyPaid, InvoiceSubmitted, InvoiceTokenChanged, InvoiceTransferred,
    InvoiceUpdated, LPPositionTransferred, ParameterUpdated, TokenAdded, TokenRemoved,
};
use invoice::{
    add_invoice_to_lp, add_invoice_to_submitter, add_volume, get_appeal, get_contract_stats,
    get_dispute, get_fund_queue, get_invoice_funders, get_lp_invoices, get_lp_score,
    get_min_payer_reputation, get_payer_score, get_pre_default_payer_score, get_queue_resolution,
    get_reputation, get_submitter_invoices, increment_invoices_defaulted, increment_invoices_paid,
    increment_invoices_submitted, increment_total_funded, increment_total_invoices,
    increment_total_paid, invoice_exists, is_paused, load_invoice, next_invoice_id,
    remove_invoice_from_lp, remove_invoice_from_submitter, save_appeal, save_dispute,
    save_fund_queue, save_invoice, save_invoice_funders, save_pre_default_payer_score,
    save_queue_resolution, set_lp_score, set_min_payer_reputation, set_paused, set_payer_score,
    set_reputation, try_load_invoice, ContractStats, DisputeRecord, StorageKey,
};
// 30-day window in seconds for a payer to file an appeal after a default.
const APPEAL_WINDOW_SECONDS: u64 = 30 * 24 * 60 * 60;

// ----------------------------------------------------------------
// CONSTANTS
// ----------------------------------------------------------------

/// Minimum invoice duration: 24 hours (in seconds)
const MIN_INVOICE_DURATION: u64 = 24 * 60 * 60;

/// Maximum invoice duration: 365 days (in seconds)
const MAX_INVOICE_DURATION: u64 = 365 * 24 * 60 * 60;

/// Default oracle freshness window: ~24 hours at one ledger per 5 seconds.
/// Governance can override this per-contract via set_max_oracle_age().
pub const DEFAULT_MAX_ORACLE_AGE_LEDGERS: u64 = 17_280;

// ----------------------------------------------------------------
// ORACLE TYPES (Issue #93)
// ----------------------------------------------------------------

use soroban_sdk::contracttype;

/// Response returned by the oracle's get_payer_data() entry point.
/// Combines identity verification with a freshness timestamp so the
/// contract can reject stale data without a second round-trip.
#[contracttype]
#[derive(Clone, Debug)]
pub struct OracleVerificationResponse {
    /// Whether the payer has passed oracle identity/creditworthiness checks.
    pub is_verified: bool,
    /// Ledger sequence number at which this data was last updated by the oracle.
    /// fund_invoice() rejects responses where current_ledger - timestamp ≥ max_oracle_age_ledgers.
    pub timestamp: u32,
}

// ----------------------------------------------------------------
// CONTRACT
// ----------------------------------------------------------------

#[contract]
pub struct InvoiceLiquidityContract;

#[allow(clippy::too_many_arguments)]
#[contractimpl]
impl InvoiceLiquidityContract {
    // ------------------------------------------------------------
    // initialize (multi-token aware)
    // ------------------------------------------------------------
    /// Access: Anyone
    pub fn initialize(
        env: Env,
        admin: Address,
        usdc_token: Address,
        eurc_token: Address,
        xlm_token: Address,
    ) -> Result<(), ContractError> {
        if env
            .storage()
            .instance()
            .has(&crate::storage::DataKey::InvoiceCount)
        {
            return Err(ContractError::AlreadyInitialized);
        }

        env.storage()
            .instance()
            .set(&crate::storage::DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&crate::storage::DataKey::FeeRate, &0_u32);
        env.storage()
            .instance()
            .set(&crate::storage::DataKey::MaxDiscountRate, &5000_u32);

        if !env.storage().instance().has(&StorageKey::NextInvoiceId) {
            env.storage()
                .instance()
                .set(&StorageKey::NextInvoiceId, &1_u64);
        }

        // Initialize config with token addresses
        let initial_config = crate::config::Config {
            high_rep_threshold: 70,
            bonus_bps: 100,
            min_discount_rate_bps: 100,
            decay_rate_bps: 50,
            decay_period_ledgers: 10000,
            dispute_timeout_ledgers: 10000,
            xlm_sac_address: xlm_token.clone(),
            usdc_sac_address: usdc_token.clone(),
            eurc_sac_address: eurc_token.clone(),
            price_oracle: None,
            max_oracle_age_ledgers: DEFAULT_MAX_ORACLE_AGE_LEDGERS,
        };
        crate::storage::set_config(&env, &initial_config);

        // approve first token (USDC: 6 decimals)
        // approve initial tokens
        env.storage().persistent().set(
            &crate::storage::DataKey::ApprovedToken(usdc_token.clone()),
            &true,
        );

        env.storage().persistent().set(
            &crate::storage::DataKey::ApprovedToken(eurc_token.clone()),
            &true,
        );
        env.storage().persistent().set(
            &crate::storage::DataKey::TokenDecimals(usdc_token.clone()),
            &6_u32,
        );

        // approve native XLM SAC (7 decimals)
        env.storage().persistent().set(
            &crate::storage::DataKey::ApprovedToken(xlm_token.clone()),
            &true,
        );
        env.storage().persistent().set(
            &crate::storage::DataKey::TokenDecimals(xlm_token.clone()),
            &7_u32,
        );

        let mut list: Vec<Address> = Vec::new(&env);
        list.push_back(usdc_token);
        list.push_back(xlm_token);
        list.push_back(eurc_token);

        env.storage()
            .persistent()
            .set(&crate::storage::DataKey::TokenList, &list);

        Ok(())
    }

    // ------------------------------------------------------------
    // Version view
    // ------------------------------------------------------------
    /// Access: Anyone
    pub fn get_version(env: Env) -> soroban_sdk::String {
        soroban_sdk::String::from_str(&env, crate::constants::CONTRACT_VERSION)
    }

    // ------------------------------------------------------------
    /// Access: Admin only
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), ContractError> {
        require_admin(&env)?;
        let old_admin: Address = env.storage().instance().get(&StorageKey::Admin).unwrap();
        env.storage().instance().set(&StorageKey::Admin, &new_admin);
        env.events().publish(
            (Symbol::new(&env, "admin_changed"),),
            AdminChanged {
                old_admin,
                new_admin,
                timestamp: env.ledger().timestamp(),
            },
        );
        Ok(())
    }

    /// Access: Admin only
    pub fn update_fee_rate(env: Env, rate: u32) -> Result<(), ContractError> {
        require_admin(&env)?;

        let old_rate: u32 = env
            .storage()
            .instance()
            .get(&StorageKey::FeeRate)
            .unwrap_or(0);
        env.storage().instance().set(&StorageKey::FeeRate, &rate);
        let updated_by = get_admin(&env).ok_or(ContractError::Unauthorized)?;
        let pn = Symbol::new(&env, "protocol_fee_rate_bps");
        env.events().publish(
            (
                Symbol::new(&env, "parameter_updated"),
                pn.clone(),
                updated_by.clone(),
            ),
            ParameterUpdated {
                param_name: pn,
                old_value: old_rate as i128,
                new_value: rate as i128,
                updated_by,
            },
        );
        Ok(())
    }

    /// Access: Admin only
    pub fn update_max_discount(env: Env, rate: u32) -> Result<(), ContractError> {
        require_admin(&env)?;

        let old_rate: u32 = env
            .storage()
            .instance()
            .get(&StorageKey::MaxDiscountRate)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&StorageKey::MaxDiscountRate, &rate);
        let updated_by = get_admin(&env).ok_or(ContractError::Unauthorized)?;
        let pn = Symbol::new(&env, "max_discount_rate_bps");
        env.events().publish(
            (
                Symbol::new(&env, "parameter_updated"),
                pn.clone(),
                updated_by.clone(),
            ),
            ParameterUpdated {
                param_name: pn,
                old_value: old_rate as i128,
                new_value: rate as i128,
                updated_by,
            },
        );
        Ok(())
    }

    /// Access: Admin only
    pub fn set_distribution_contract(
        env: Env,
        distribution_contract: Address,
    ) -> Result<(), ContractError> {
        require_admin(&env)?;

        env.storage()
            .instance()
            .set(&StorageKey::DistributionContract, &distribution_contract);
        Ok(())
    }

    /// Access: Admin only
    pub fn set_price_oracle(env: Env, oracle: Address) -> Result<(), ContractError> {
        require_admin(&env)?;
        let admin = get_admin(&env).ok_or(ContractError::Unauthorized)?;
        crate::config::set_price_oracle(&env, &admin, oracle)
            .map_err(|_| ContractError::Unauthorized)?;
        Ok(())
    }

    /// Access: Anyone
    pub fn get_price_oracle(env: Env) -> Option<Address> {
        crate::storage::get_config(&env).and_then(|config| config.price_oracle)
    }

    /// Update the maximum oracle data age in ledgers. Admin / governance only.
    ///
    /// Setting this to 0 disables the freshness check entirely (not recommended
    /// for production — stale data is as dangerous as no oracle).
    /// Access: Admin only
    pub fn set_max_oracle_age(env: Env, max_age_ledgers: u64) -> Result<(), ContractError> {
        require_admin(&env)?;
        let admin = get_admin(&env).ok_or(ContractError::Unauthorized)?;
        crate::config::set_max_oracle_age(&env, &admin, max_age_ledgers)
            .map_err(|_| ContractError::Unauthorized)?;
        Ok(())
    }

    /// Return the configured maximum oracle data age in ledgers.
    /// Access: Anyone
    pub fn get_max_oracle_age(env: Env) -> u64 {
        crate::storage::get_config(&env)
            .map(|c| c.max_oracle_age_ledgers)
            .unwrap_or(DEFAULT_MAX_ORACLE_AGE_LEDGERS)
    }

    /// Access: Admin only
    pub fn add_token(env: Env, token: Address, decimals: u32) -> Result<(), ContractError> {
        require_admin(&env)?;

        let token_client = token_client(&env, &token);
        let contract_address = env.current_contract_address();
        let test_amount: i128 = 1_000_000;
        let admin_address: Address = env
            .storage()
            .instance()
            .get(&crate::storage::DataKey::Admin)
            .unwrap();
        let before_balance = token_client.balance(&contract_address);

        token_client.transfer(&admin_address, &contract_address, &test_amount);

        let after_balance = token_client.balance(&contract_address);
        let received = after_balance.checked_sub(before_balance).unwrap_or(0);
        if received != test_amount {
            if received > 0 {
                token_client.transfer(&contract_address, &admin_address, &received);
            }
            return Err(ContractError::FeeOnTransferToken);
        }

        // Return the exact test amount to the admin account after verification.
        token_client.transfer(&contract_address, &admin_address, &test_amount);

        env.storage().persistent().set(
            &crate::storage::DataKey::ApprovedToken(token.clone()),
            &true,
        );

        // Store the decimal precision for this token so amount comparisons and
        // minimum-amount checks can be scaled correctly (Issue #23).
        env.storage().persistent().set(
            &crate::storage::DataKey::TokenDecimals(token.clone()),
            &decimals,
        );

        let mut list: Vec<Address> = env
            .storage()
            .persistent()
            .get(&crate::storage::DataKey::TokenList)
            .unwrap_or(Vec::new(&env));
        if !list.contains(&token) {
            list.push_back(token.clone());
            env.storage()
                .persistent()
                .set(&crate::storage::DataKey::TokenList, &list);
        }

        env.events().publish(
            (Symbol::new(&env, "token_added"), token.clone()),
            TokenAdded { token, decimals },
        );
        Ok(())
    }

    /// Access: Admin only
    pub fn remove_token(env: Env, token: Address) -> Result<(), ContractError> {
        require_admin(&env)?;

        env.storage()
            .persistent()
            .set(&StorageKey::ApprovedToken(token.clone()), &false);

        // Keep the allowlist Vec in sync with the ApprovedToken flag.
        let list: Vec<Address> = env
            .storage()
            .persistent()
            .get(&crate::storage::DataKey::TokenList)
            .unwrap_or(Vec::new(&env));
        let mut pruned: Vec<Address> = Vec::new(&env);
        for t in list.iter() {
            if t != token {
                pruned.push_back(t);
            }
        }
        env.storage()
            .persistent()
            .set(&crate::storage::DataKey::TokenList, &pruned);

        env.events().publish(
            (Symbol::new(&env, "token_removed"), token.clone()),
            TokenRemoved { token },
        );
        Ok(())
    }

    /// Return the registered decimal precision for a token.
    ///
    /// Returns `None` when the token has never been registered via
    /// `add_token` or `initialize`. For the two bootstrap tokens (USDC at 6
    /// decimals and XLM at 7 decimals) these are set automatically during
    /// `initialize`.
    ///
    /// Access: Anyone
    pub fn get_token_decimals(env: Env, token: Address) -> Option<u32> {
        env.storage()
            .persistent()
            .get(&crate::storage::DataKey::TokenDecimals(token))
    }

    // ------------------------------------------------------------
    // pause / unpause (emergency controls)
    // ------------------------------------------------------------
    /// Access: Admin only
    pub fn pause(env: Env) -> Result<(), ContractError> {
        require_admin(&env)?;

        set_paused(&env, true);
        env.events().publish(
            (Symbol::new(&env, "paused"),),
            ContractPaused {
                timestamp: env.ledger().timestamp(),
            },
        );
        Ok(())
    }

    /// Access: Admin only
    pub fn unpause(env: Env) -> Result<(), ContractError> {
        require_admin(&env)?;

        set_paused(&env, false);
        env.events().publish(
            (Symbol::new(&env, "unpaused"),),
            ContractUnpaused {
                timestamp: env.ledger().timestamp(),
            },
        );
        Ok(())
    }

    // ------------------------------------------------------------
    // upgrade (Issue #48)
    // ------------------------------------------------------------
    /// Upgrade the contract to a new WASM hash.
    ///
    /// Only the admin can trigger an upgrade. This function emits an event
    /// but does not directly perform the upgrade—that is done by the network
    /// after the contract is authorized to update its code hash via governance.
    ///
    /// # Arguments
    /// - `env`: The Soroban environment
    /// - `new_wasm_hash`: The hash of the new WASM binary to upgrade to (32 bytes)
    ///
    /// # Returns
    /// - `Ok(())` if the upgrade event was successfully published
    /// - `Err(ContractError)` if called by non-admin
    ///
    /// # Notes
    /// This function:
    /// - Requires admin authentication
    /// - Emits a ContractUpgraded event for audit trail
    /// - Does NOT perform the actual upgrade (handled by Soroban runtime)
    /// - Should only be called after off-chain governance approval
    ///
    /// Access: Admin only
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), ContractError> {
        require_admin(&env)?;

        let admin = get_admin(&env).ok_or(ContractError::Unauthorized)?;

        env.events().publish(
            (Symbol::new(&env, "upgraded"), admin.clone()),
            ContractUpgraded {
                admin,
                new_wasm_hash,
                timestamp: env.ledger().timestamp(),
            },
        );

        Ok(())
    }

    // ------------------------------------------------------------
    // get_contract_stats (read-only view)
    // ------------------------------------------------------------
    /// Access: Anyone
    pub fn get_contract_stats(env: Env) -> ContractStats {
        get_contract_stats(&env)
    }

    // ------------------------------------------------------------
    // list_invoices_by_submitter (Paginated)
    // ------------------------------------------------------------
    /// Access: Anyone
    pub fn list_invoices_by_submitter(
        env: Env,
        submitter: Address,
        page: u32,
        page_size: u32,
    ) -> Vec<Invoice> {
        let page_size = page_size.min(50);
        let invoice_ids = get_submitter_invoices(&env, &submitter);
        let total_invoices = invoice_ids.len();

        let start = page * page_size;
        if start >= total_invoices {
            return Vec::new(&env);
        }

        let end = (start + page_size).min(total_invoices);
        let mut result = Vec::new(&env);

        for i in start..end {
            if let Some(id) = invoice_ids.get(i) {
                result.push_back(load_invoice(&env, id));
            }
        }

        result
    }

    // ------------------------------------------------------------
    // list_invoices_by_lp (Paginated)
    // ------------------------------------------------------------
    /// Access: Anyone
    pub fn list_invoices_by_lp(env: Env, lp: Address, page: u32, page_size: u32) -> Vec<Invoice> {
        let page_size = page_size.min(50);
        let invoice_ids = get_lp_invoices(&env, &lp);
        let total_invoices = invoice_ids.len();

        let start = page * page_size;
        if start >= total_invoices {
            return Vec::new(&env);
        }

        let end = (start + page_size).min(total_invoices);
        let mut result = Vec::new(&env);

        for i in start..end {
            if let Some(id) = invoice_ids.get(i) {
                result.push_back(load_invoice(&env, id));
            }
        }

        result
    }

    // ------------------------------------------------------------
    // submit_invoice (NOW TOKEN-AWARE)
    // ------------------------------------------------------------
    /// Access: Submitter only
    pub fn submit_invoice(
        env: Env,
        freelancer: Address,
        payer: Address,
        amount: i128,
        due_date: u64,
        discount_rate: u32,
        token: Address,
        referral_code: ReferralCode,
    ) -> Result<u64, ContractError> {
        if is_paused(&env) {
            return Err(ContractError::ContractPaused);
        }

        require_submitter(&env, &freelancer)?;

        if freelancer == payer {
            return Err(ContractError::SelfInvoice);
        }

        if discount_rate == 0 || discount_rate > crate::constants::MAX_DISCOUNT_RATE {
            return Err(ContractError::InvalidDiscountRate);
        }

        validate_invoice_terms(&env, amount, due_date, discount_rate)?;

        // token validation
        if !is_approved_token(&env, &token) {
            return Err(ContractError::Unauthorized);
        }

        // Re-validate amount using token-aware decimal precision now that we
        // know the token is on the allowlist (and therefore has decimals stored).
        validate_invoice_terms_with_token(&env, amount, due_date, discount_rate, &token)?;

        let id = next_invoice_id(&env)?;

        // Capture the freelancer's reputation score at submission time
        let submitter_reputation = get_payer_score(&env, &freelancer);

        let invoice = Invoice {
            id,
            freelancer: freelancer.clone(),
            payer,
            token,
            amount,
            due_date: due_date.try_into().unwrap(),
            discount_rate,
            status: InvoiceStatus::Pending,
            funder: None,
            funded_at: None,
            amount_funded: 0,
            amount_paid: 0,
            referral_code: referral_code.clone(),
            submitter_reputation,
        };

        save_invoice(&env, &invoice);

        // Update submitter index
        add_invoice_to_submitter(&env, &freelancer, id);

        // Increment total invoices counter
        increment_total_invoices(&env);

        // Increment detailed reputation invoices_submitted count
        increment_invoices_submitted(&env, &freelancer);

        env.events().publish(
            (
                Symbol::new(&env, "submitted"),
                invoice.id,
                invoice.freelancer.clone(),
                invoice.payer.clone(),
            ),
            InvoiceSubmitted {
                invoice_id: invoice.id,
                freelancer: invoice.freelancer.clone(),
                payer: invoice.payer.clone(),
                token: invoice.token.clone(),
                amount: invoice.amount,
                due_date: u64::from(invoice.due_date),
                discount_rate: invoice.discount_rate,
                referral_code: referral_code.clone(),
                status: invoice.status.clone(),
                timestamp: env.ledger().timestamp(),
            },
        );

        // Track referral count if provided
        if let ReferralCode::Present(code) = &referral_code {
            let key = crate::storage::DataKey::ReferralCount(code.clone());
            let current: u64 = env.storage().persistent().get(&key).unwrap_or(0);
            env.storage().persistent().set(&key, &(current + 1));
        }

        Ok(id)
    }

    // ------------------------------------------------------------
    // update_invoice
    // ------------------------------------------------------------
    /// Access: Submitter only
    pub fn update_invoice(
        env: Env,
        freelancer: Address,
        invoice_id: u64,
        amount: i128,
        due_date: u64,
        discount_rate: u32,
    ) -> Result<(), ContractError> {
        if is_paused(&env) {
            return Err(ContractError::ContractPaused);
        }

        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }

        let mut invoice = load_invoice(&env, invoice_id);
        require_submitter_by_id(&env, &freelancer, invoice_id)?;

        if invoice.status == InvoiceStatus::Pending
            && env.ledger().timestamp() >= u64::from(invoice.due_date)
        {
            invoice.status = InvoiceStatus::Expired;
            save_invoice(&env, &invoice);
            return Err(ContractError::InvoiceExpired);
        }

        match invoice.status {
            InvoiceStatus::Pending => {}
            InvoiceStatus::PartiallyFunded | InvoiceStatus::Funded => {
                return Err(ContractError::AlreadyFunded)
            }
            InvoiceStatus::Paid => return Err(ContractError::AlreadyPaid),
            InvoiceStatus::Defaulted => return Err(ContractError::InvoiceDefaulted),
            InvoiceStatus::Appealed => return Err(ContractError::InvoiceAppealed),
            InvoiceStatus::Disputed => return Err(ContractError::InvoiceDisputed),
            InvoiceStatus::Expired => return Err(ContractError::InvoiceExpired),
            InvoiceStatus::Cancelled => return Err(ContractError::AlreadyCancelled),
        }

        validate_invoice_terms(&env, amount, due_date, discount_rate)?;

        invoice.amount = amount;
        invoice.due_date = due_date.try_into().unwrap();
        invoice.discount_rate = discount_rate;

        save_invoice(&env, &invoice);

        env.events().publish(
            (
                Symbol::new(&env, "updated"),
                invoice.id,
                invoice.freelancer.clone(),
                invoice.payer.clone(),
            ),
            InvoiceUpdated {
                invoice_id: invoice.id,
                freelancer: invoice.freelancer.clone(),
                payer: invoice.payer.clone(),
                token: invoice.token.clone(),
                amount: invoice.amount,
                due_date: u64::from(invoice.due_date),
                discount_rate: invoice.discount_rate,
                status: invoice.status.clone(),
            },
        );

        Ok(())
    }

    // ------------------------------------------------------------
    // convert_invoice_token
    // ------------------------------------------------------------
    /// Access: Submitter only
    pub fn convert_invoice_token(
        env: Env,
        freelancer: Address,
        invoice_id: u64,
        new_token: Address,
    ) -> Result<(), ContractError> {
        if is_paused(&env) {
            return Err(ContractError::ContractPaused);
        }

        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }

        let mut invoice = load_invoice(&env, invoice_id);
        require_submitter_by_id(&env, &freelancer, invoice_id)?;

        // Only allowed in Pending state
        if invoice.status != InvoiceStatus::Pending {
            match invoice.status {
                InvoiceStatus::PartiallyFunded | InvoiceStatus::Funded => {
                    return Err(ContractError::AlreadyFunded)
                }
                InvoiceStatus::Paid => return Err(ContractError::AlreadyPaid),
                _ => return Err(ContractError::Unauthorized), // Generic unauthorized for other states
            }
        }

        // Check if invoice is expired (mirroring update_invoice logic)
        if env.ledger().timestamp() >= u64::from(invoice.due_date) {
            invoice.status = InvoiceStatus::Expired;
            save_invoice(&env, &invoice);
            return Err(ContractError::InvoiceExpired);
        }

        // New token must be in the allowlist
        if !is_approved_token(&env, &new_token) {
            return Err(ContractError::Unauthorized);
        }

        let old_token = invoice.token.clone();
        invoice.token = new_token.clone();

        save_invoice(&env, &invoice);

        env.events().publish(
            (Symbol::new(&env, "token_changed"), invoice_id),
            InvoiceTokenChanged {
                invoice_id,
                old_token,
                new_token,
            },
        );

        Ok(())
    }

    // ------------------------------------------------------------
    // submit_invoices_batch
    // ------------------------------------------------------------
    /// Access: Submitter only
    pub fn submit_invoices_batch(
        env: Env,
        invoices: Vec<InvoiceParams>,
    ) -> Result<Vec<u64>, ContractError> {
        if is_paused(&env) {
            return Err(ContractError::ContractPaused);
        }

        if invoices.len() > 10 {
            return Err(ContractError::BatchTooLarge);
        }

        let mut authenticated_freelancers: Vec<Address> = Vec::new(&env);
        let mut ids = Vec::new(&env);
        for params in invoices.iter() {
            if !authenticated_freelancers.contains(&params.freelancer) {
                require_submitter(&env, &params.freelancer)?;
                authenticated_freelancers.push_back(params.freelancer.clone());
            }

            validate_invoice_terms(&env, params.amount, params.due_date, params.discount_rate)?;

            if !is_approved_token(&env, &params.token) {
                return Err(ContractError::Unauthorized);
            }

            // Re-validate with token-aware decimal precision.
            validate_invoice_terms_with_token(
                &env,
                params.amount,
                params.due_date,
                params.discount_rate,
                &params.token,
            )?;

            let id = next_invoice_id(&env)?;

            // Capture the freelancer's reputation score at submission time
            let submitter_reputation = get_payer_score(&env, &params.freelancer);

            let invoice = Invoice {
                id,
                freelancer: params.freelancer.clone(),
                payer: params.payer,
                token: params.token,
                amount: params.amount,
                due_date: params.due_date.try_into().unwrap(),
                discount_rate: params.discount_rate,
                status: InvoiceStatus::Pending,
                funder: None,
                funded_at: None,
                amount_funded: 0,
                amount_paid: 0,
                referral_code: params.referral_code.clone(),
                submitter_reputation,
            };

            save_invoice(&env, &invoice);

            // Update submitter index
            add_invoice_to_submitter(&env, &params.freelancer, id);

            // Increment total invoices counter
            increment_total_invoices(&env);
            env.events().publish(
                (
                    Symbol::new(&env, "submitted"),
                    invoice.id,
                    invoice.freelancer.clone(),
                    invoice.payer.clone(),
                ),
                InvoiceSubmitted {
                    invoice_id: invoice.id,
                    freelancer: invoice.freelancer.clone(),
                    payer: invoice.payer.clone(),
                    token: invoice.token.clone(),
                    amount: invoice.amount,
                    due_date: u64::from(invoice.due_date),
                    discount_rate: invoice.discount_rate,
                    referral_code: params.referral_code.clone(),
                    status: invoice.status.clone(),
                    timestamp: env.ledger().timestamp(),
                },
            );

            // Track referral count if provided
            if let ReferralCode::Present(code) = &params.referral_code {
                let key = crate::storage::DataKey::ReferralCount(code.clone());
                let current: u64 = env.storage().persistent().get(&key).unwrap_or(0);
                env.storage().persistent().set(&key, &(current + 1));
            }

            ids.push_back(id);
        }

        Ok(ids)
    }

    /// Access: Anyone
    pub fn get_referral_stats(env: Env, code: BytesN<32>) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::ReferralCount(code))
            .unwrap_or(0)
    }

    // ================================================================
    // Issue #34: LP Priority Queue
    //
    // Design:
    //  1. Any LP calls `join_fund_queue(lp, invoice_id)` to register intent.
    //     Their current LP reputation score is snapshotted.
    //  2. Anyone can call `resolve_fund_queue(invoice_id)` to lock in the
    //     highest-score LP as the approved funder.
    //  3. `fund_invoice` checks: if a QueueResolution exists for this invoice,
    //     only the approved LP may fund it.
    //  If no LP ever joins the queue the existing first-come-first-served
    //  behaviour is preserved unchanged.
    // ================================================================

    /// Register an LP's intent to fund an invoice.
    /// The LP's current reputation score is snapshotted for ordering.
    /// Access: LP only
    pub fn join_fund_queue(env: Env, lp: Address, invoice_id: u64) -> Result<(), ContractError> {
        require_lp(&env, &lp)?;

        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }

        // Queue resolution already happened — too late to join.
        if get_queue_resolution(&env, invoice_id).is_some() {
            return Err(ContractError::NotApprovedFunder);
        }

        let invoice = load_invoice(&env, invoice_id);
        match invoice.status {
            InvoiceStatus::Pending | InvoiceStatus::PartiallyFunded => {}
            InvoiceStatus::Funded => return Err(ContractError::AlreadyFunded),
            InvoiceStatus::Paid => return Err(ContractError::AlreadyPaid),
            InvoiceStatus::Defaulted => return Err(ContractError::InvoiceDefaulted),
            InvoiceStatus::Appealed => return Err(ContractError::InvoiceAppealed),
            InvoiceStatus::Disputed => return Err(ContractError::InvoiceDisputed),
            InvoiceStatus::Expired => return Err(ContractError::InvoiceExpired),
            InvoiceStatus::Cancelled => return Err(ContractError::AlreadyCancelled),
        }

        let mut queue = get_fund_queue(&env, invoice_id);

        // Prevent duplicate entries.
        for i in 0..queue.len() {
            if queue.get(i).unwrap().lp == lp {
                return Err(ContractError::AlreadyInQueue);
            }
        }

        let score = get_lp_score(&env, &lp);
        queue.push_back(LpFundRequest {
            lp: lp.clone(),
            score,
        });
        save_fund_queue(&env, invoice_id, &queue);

        env.events().publish(
            (Symbol::new(&env, "fund_requested"), invoice_id, lp.clone()),
            FundRequested {
                invoice_id,
                lp,
                score,
            },
        );

        Ok(())
    }

    /// Select the highest-reputation LP from the queue as the approved funder.
    /// Returns the winning LP address.
    /// Can be called by anyone once at least one LP has joined the queue.
    /// Access: Anyone
    pub fn resolve_fund_queue(env: Env, invoice_id: u64) -> Result<Address, ContractError> {
        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }

        // Already resolved.
        if let Some(approved) = get_queue_resolution(&env, invoice_id) {
            return Ok(approved);
        }

        let queue = get_fund_queue(&env, invoice_id);
        if queue.is_empty() {
            return Err(ContractError::NotFunded); // no one in queue
        }

        // Find the LP with the highest score (ties broken by first-come-first-served).
        let mut best_lp = queue.get(0).unwrap().lp.clone();
        let mut best_score = queue.get(0).unwrap().score;

        for i in 1..queue.len() {
            let entry = queue.get(i).unwrap();
            if entry.score > best_score {
                best_score = entry.score;
                best_lp = entry.lp.clone();
            }
        }

        save_queue_resolution(&env, invoice_id, &best_lp);

        env.events().publish(
            (
                Symbol::new(&env, "fund_queue_resolved"),
                invoice_id,
                best_lp.clone(),
            ),
            FundQueueResolved {
                invoice_id,
                approved_lp: best_lp.clone(),
                score: best_score,
            },
        );

        Ok(best_lp)
    }

    // ------------------------------------------------------------
    // fund_invoice (USES invoice.token) — now queue-aware
    // ------------------------------------------------------------
    /// Access: LP only
    ///
    /// `require_oracle_verification` — when `true`, the oracle stored in
    /// contract config is queried for the payer's verification status.
    /// If the oracle returns `false` (unverified), the call returns
    /// `ContractError::PayerUnverified`. When `false`, the oracle is not
    /// consulted and the existing behaviour is preserved.
    pub fn fund_invoice(
        env: Env,
        funder: Address,
        invoice_id: u64,
        fund_amount: i128,
        require_oracle_verification: bool,
    ) -> Result<(), ContractError> {
        if is_paused(&env) {
            return Err(ContractError::ContractPaused);
        }

        require_lp(&env, &funder)?;

        // Issue #71: load the invoice once instead of `invoice_exists` + `load_invoice`
        // (which read the same persistent key twice on the hottest path).
        let mut invoice =
            try_load_invoice(&env, invoice_id).ok_or(ContractError::InvoiceNotFound)?;

        // ── Issue #34: priority queue check ──────────────────────
        // If a queue has been resolved, only the approved LP may fund.
        if let Some(approved) = get_queue_resolution(&env, invoice_id) {
            if approved != funder {
                return Err(ContractError::NotApprovedFunder);
            }
        }

        // Issue #19: the invoice token must still be on the governance allowlist.
        if !is_approved_token(&env, &invoice.token) {
            return Err(ContractError::Unauthorized);
        }

        // Issue #28: reject funding when the payer's reputation is below the
        // configured minimum threshold (default 0 allows everyone).
        let min_payer_reputation = get_min_payer_reputation(&env);
        if min_payer_reputation > 0 && get_payer_score(&env, &invoice.payer) < min_payer_reputation
        {
            return Err(ContractError::PayerReputationTooLow);
        }

        // Issues #92 + #93: optional oracle verification with data-freshness guard.
        // When require_oracle_verification is true, the oracle stored in config is
        // called. If no oracle is configured the flag is a no-op.
        if require_oracle_verification {
            if let Some(oracle_addr) = crate::storage::get_config(&env).and_then(|c| c.price_oracle)
            {
                let response: OracleVerificationResponse = env.invoke_contract(
                    &oracle_addr,
                    &Symbol::new(&env, "get_payer_data"),
                    vec![&env, invoice.payer.clone().into_val(&env)],
                );

                // Issue #93: reject stale oracle data.
                // Staleness = current_ledger_sequence - oracle.timestamp >= max_oracle_age_ledgers.
                // If max_oracle_age_ledgers == 0 the check is disabled (governance escape hatch).
                let max_age = crate::storage::get_config(&env)
                    .map(|c| c.max_oracle_age_ledgers)
                    .unwrap_or(DEFAULT_MAX_ORACLE_AGE_LEDGERS);
                if max_age > 0 {
                    let current_ledger = env.ledger().sequence() as u64;
                    let age = current_ledger.saturating_sub(response.timestamp as u64);
                    if age >= max_age {
                        return Err(ContractError::OracleDataStale);
                    }
                }

                // Issue #92: reject unverified payers.
                if !response.is_verified {
                    return Err(ContractError::PayerUnverified);
                }
            }
        }

        if invoice.status == InvoiceStatus::Pending
            && env.ledger().timestamp() > u64::from(invoice.due_date)
        {
            invoice.status = InvoiceStatus::Expired;
            save_invoice(&env, &invoice);
            env.events().publish(
                (Symbol::new(&env, "expired"), invoice.id),
                InvoiceExpired {
                    invoice_id: invoice.id,
                    freelancer: invoice.freelancer.clone(),
                    status: invoice.status.clone(),
                },
            );
            return Err(ContractError::InvoiceExpired);
        }

        match invoice.status {
            InvoiceStatus::Paid => return Err(ContractError::AlreadyPaid),
            InvoiceStatus::Defaulted => return Err(ContractError::InvoiceDefaulted),
            InvoiceStatus::Appealed => return Err(ContractError::InvoiceAppealed),
            InvoiceStatus::Disputed => return Err(ContractError::InvoiceDisputed),
            InvoiceStatus::Expired => return Err(ContractError::InvoiceExpired),
            InvoiceStatus::Funded => return Err(ContractError::AlreadyFunded),
            InvoiceStatus::Pending | InvoiceStatus::PartiallyFunded => {} // all good
            InvoiceStatus::Cancelled => return Err(ContractError::AlreadyCancelled),
        }

        if invoice.amount_funded + fund_amount > invoice.amount {
            return Err(ContractError::OverfundingRejected);
        }

        // --- Execute transfer ---
        let token = token_client(&env, &invoice.token);
        let contract_address = env.current_contract_address();

        // Handle token precision if needed
        let normalized_fund_amount = if is_xlm_token(&env, &invoice.token) {
            normalize_xlm_amount(fund_amount)
        } else if is_eurc_token(&env, &invoice.token) {
            normalize_eurc_amount(fund_amount)
        } else {
            normalize_usdc_amount(fund_amount)
        };

        let fund_discount = normalized_fund_amount
            .checked_mul(discount_rate_as_i128(invoice.discount_rate))
            .unwrap_or(0)
            / 10_000;
        let cost = normalized_fund_amount - fund_discount;

        token.transfer(&funder, &contract_address, &cost);

        // --- Update contributor list ---
        let mut funders = get_invoice_funders(&env, invoice_id);
        let mut found = false;
        for i in 0..funders.len() {
            let (addr, amt) = funders.get(i).unwrap();
            if addr == funder {
                funders.set(i, (addr, amt + fund_amount));
                found = true;
                break;
            }
        }
        if !found {
            funders.push_back((funder.clone(), fund_amount));
        }
        save_invoice_funders(&env, invoice_id, &funders);

        // --- Update invoice state ---
        invoice.amount_funded += fund_amount;

        if invoice.amount_funded == invoice.amount {
            // Fully funded — pay out to freelancer
            let discount_amount = invoice
                .amount
                .checked_mul(discount_rate_as_i128(invoice.discount_rate))
                .unwrap_or(0)
                / 10_000;
            let freelancer_payout = invoice.amount - discount_amount;

            token.transfer(&contract_address, &invoice.freelancer, &freelancer_payout);

            invoice.status = InvoiceStatus::Funded;
            invoice.funded_at = Some(env.ledger().timestamp().try_into().unwrap());
            invoice.funder = Some(funder.clone());

            // Boost LP score on successful funding
            let current_lp_score = get_lp_score(&env, &funder);
            set_lp_score(&env, &funder, current_lp_score + 1);
        } else {
            invoice.status = InvoiceStatus::PartiallyFunded;
        }

        save_invoice(&env, &invoice);

        // Update LP index
        add_invoice_to_lp(&env, &funder, invoice_id);

        // Increment total funded counter if fully funded
        if invoice.status == InvoiceStatus::Funded {
            increment_total_funded(&env);
        }

        add_volume(&env, &invoice.token, fund_amount);

        notify_distribution_funding(&env, &funder, fund_amount);

        let now = env.ledger().timestamp();

        let seconds_to_due = if u64::from(invoice.due_date) > now {
            u64::from(invoice.due_date) - now
        } else {
            0
        };

        let days_to_due = seconds_to_due / (24 * 60 * 60);

        let effective_yield_bps = ((invoice.discount_rate as u64 * days_to_due) / 365) as u32;

        env.events().publish(
            (Symbol::new(&env, "funded"), invoice.id, funder.clone()),
            InvoiceFunded {
                invoice_id: invoice.id,
                funder: funder.clone(),
                freelancer: invoice.freelancer.clone(),
                payer: invoice.payer.clone(),
                token: invoice.token.clone(),
                fund_amount,
                amount_funded: invoice.amount_funded,
                invoice_amount: invoice.amount,
                due_date: u64::from(invoice.due_date),
                discount_rate: invoice.discount_rate,
                funded_at: invoice.funded_at.map(|ts| ts.into()),
                status: invoice.status.clone(),

                // NEW
                lp: funder.clone(),
                effective_yield_bps,
                timestamp: now,
            },
        );

        Ok(())
    }

    // ------------------------------------------------------------
    // transfer_invoice
    // ------------------------------------------------------------
    /// Access: Submitter only
    pub fn transfer_invoice(
        env: Env,
        invoice_id: u64,
        new_freelancer: Address,
    ) -> Result<(), ContractError> {
        if is_paused(&env) {
            return Err(ContractError::ContractPaused);
        }

        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }

        let mut invoice = load_invoice(&env, invoice_id);

        require_submitter_by_id(&env, &invoice.freelancer, invoice_id)?;

        match invoice.status {
            InvoiceStatus::Pending => {}
            InvoiceStatus::PartiallyFunded | InvoiceStatus::Funded => {
                return Err(ContractError::AlreadyFunded)
            }
            InvoiceStatus::Paid => return Err(ContractError::AlreadyPaid),
            InvoiceStatus::Defaulted => return Err(ContractError::InvoiceDefaulted),
            InvoiceStatus::Appealed => return Err(ContractError::InvoiceAppealed),
            InvoiceStatus::Disputed => return Err(ContractError::InvoiceDisputed),
            InvoiceStatus::Expired => return Err(ContractError::InvoiceExpired),
            InvoiceStatus::Cancelled => return Err(ContractError::AlreadyCancelled),
        }

        let old_freelancer = invoice.freelancer.clone();
        invoice.freelancer = new_freelancer.clone();

        save_invoice(&env, &invoice);

        // Update submitter index
        remove_invoice_from_submitter(&env, &old_freelancer, invoice_id);
        add_invoice_to_submitter(&env, &new_freelancer, invoice_id);

        env.events().publish(
            (Symbol::new(&env, "transferred"), invoice_id),
            InvoiceTransferred {
                invoice_id,
                old_freelancer,
                new_freelancer,
                status: invoice.status.clone(),
            },
        );

        Ok(())
    }

    // ------------------------------------------------------------
    // transfer_lp_position
    /// Access: Current LP only
    pub fn transfer_lp_position(
        env: Env,
        invoice_id: u64,
        new_lp: Address,
    ) -> Result<(), ContractError> {
        if is_paused(&env) {
            return Err(ContractError::ContractPaused);
        }

        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }

        let mut invoice = load_invoice(&env, invoice_id);
        match invoice.status {
            InvoiceStatus::Funded => {}
            InvoiceStatus::Pending | InvoiceStatus::PartiallyFunded => {
                return Err(ContractError::NotFunded)
            }
            InvoiceStatus::Paid => return Err(ContractError::AlreadyPaid),
            InvoiceStatus::Defaulted => return Err(ContractError::InvoiceDefaulted),
            InvoiceStatus::Appealed => return Err(ContractError::InvoiceAppealed),
            InvoiceStatus::Disputed => return Err(ContractError::InvoiceDisputed),
            InvoiceStatus::Expired => return Err(ContractError::InvoiceExpired),
            InvoiceStatus::Cancelled => return Err(ContractError::AlreadyCancelled),
        }

        let current_lp = invoice.funder.clone().ok_or(ContractError::Unauthorized)?;

        current_lp.require_auth();

        if current_lp == new_lp {
            return Err(ContractError::Unauthorized);
        }

        let mut funders = get_invoice_funders(&env, invoice_id);
        for i in 0..funders.len() {
            let (addr, amt) = funders.get(i).unwrap();
            if addr == current_lp {
                funders.set(i, (new_lp.clone(), amt));
            }
        }
        save_invoice_funders(&env, invoice_id, &funders);

        invoice.funder = Some(new_lp.clone());
        save_invoice(&env, &invoice);

        remove_invoice_from_lp(&env, &current_lp, invoice_id);
        add_invoice_to_lp(&env, &new_lp, invoice_id);

        env.events().publish(
            (Symbol::new(&env, "lp_position_transferred"), invoice_id),
            LPPositionTransferred {
                invoice_id,
                old_lp: current_lp,
                new_lp,
                status: invoice.status.clone(),
            },
        );

        Ok(())
    }

    // ------------------------------------------------------------
    // cancel_invoice
    // ------------------------------------------------------------
    /// Access: Submitter only
    pub fn cancel_invoice(env: Env, invoice_id: u64) -> Result<(), ContractError> {
        if is_paused(&env) {
            return Err(ContractError::ContractPaused);
        }

        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }

        let mut invoice = load_invoice(&env, invoice_id);

        require_submitter_by_id(&env, &invoice.freelancer, invoice_id)?;

        match invoice.status {
            InvoiceStatus::Pending => {}
            InvoiceStatus::PartiallyFunded => {
                let funders = get_invoice_funders(&env, invoice_id);
                let token = token_client(&env, &invoice.token);
                let contract_address = env.current_contract_address();
                for i in 0..funders.len() {
                    let (funder_addr, fund_amt) = funders.get(i).unwrap();
                    let fund_discount = fund_amt
                        .checked_mul(discount_rate_as_i128(invoice.discount_rate))
                        .unwrap_or(0)
                        / 10_000;
                    let refund = fund_amt - fund_discount;
                    token.transfer(&contract_address, &funder_addr, &refund);
                }
            }
            InvoiceStatus::Funded => return Err(ContractError::AlreadyFunded),
            InvoiceStatus::Paid => return Err(ContractError::AlreadyPaid),
            InvoiceStatus::Defaulted => return Err(ContractError::InvoiceDefaulted),
            InvoiceStatus::Appealed => return Err(ContractError::InvoiceAppealed),
            InvoiceStatus::Disputed => return Err(ContractError::InvoiceDisputed),
            InvoiceStatus::Expired => return Err(ContractError::InvoiceExpired),
            InvoiceStatus::Cancelled => return Err(ContractError::AlreadyCancelled),
        }

        invoice.status = InvoiceStatus::Cancelled;

        save_invoice(&env, &invoice);

        env.events().publish(
            (Symbol::new(&env, "cancelled"), invoice_id),
            InvoiceCancelled {
                invoice_id,
                freelancer: invoice.freelancer.clone(),
                status: invoice.status.clone(),
            },
        );

        Ok(())
    }

    // ------------------------------------------------------------
    // expire_invoice
    // ------------------------------------------------------------
    /// Access: Anyone
    pub fn expire_invoice(env: Env, invoice_id: u64) -> Result<(), ContractError> {
        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }

        let mut invoice = load_invoice(&env, invoice_id);

        if env.ledger().timestamp() <= u64::from(invoice.due_date) {
            return Err(ContractError::NotYetDefaulted);
        }

        match invoice.status {
            InvoiceStatus::Pending => {
                invoice.status = InvoiceStatus::Expired;
                save_invoice(&env, &invoice);
                env.events().publish(
                    (Symbol::new(&env, "expired"), invoice.id),
                    InvoiceExpired {
                        invoice_id: invoice.id,
                        freelancer: invoice.freelancer.clone(),
                        status: invoice.status.clone(),
                    },
                );
                Ok(())
            }
            InvoiceStatus::PartiallyFunded | InvoiceStatus::Funded => {
                Err(ContractError::AlreadyFunded)
            }
            InvoiceStatus::Paid => Err(ContractError::AlreadyPaid),
            InvoiceStatus::Defaulted => Err(ContractError::InvoiceDefaulted),
            InvoiceStatus::Appealed => Err(ContractError::InvoiceAppealed),
            InvoiceStatus::Disputed => Err(ContractError::InvoiceDisputed),
            InvoiceStatus::Expired => Err(ContractError::InvoiceExpired),
            InvoiceStatus::Cancelled => Err(ContractError::AlreadyCancelled),
        }
    }

    // ------------------------------------------------------------
    // mark_paid (USES invoice.token)
    // ------------------------------------------------------------
    /// Access: Payer only
    pub fn mark_paid(env: Env, invoice_id: u64, amount: i128) -> Result<(), ContractError> {
        if is_paused(&env) {
            return Err(ContractError::ContractPaused);
        }

        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }

        // Issue #71: single load instead of `invoice_exists` + `load_invoice`.
        let mut invoice =
            try_load_invoice(&env, invoice_id).ok_or(ContractError::InvoiceNotFound)?;

        require_payer_by_id(&env, invoice_id)?;

        match invoice.status {
            InvoiceStatus::Pending | InvoiceStatus::PartiallyFunded => {
                return Err(ContractError::NotFunded)
            }
            InvoiceStatus::Paid => return Err(ContractError::AlreadyPaid),
            InvoiceStatus::Defaulted => return Err(ContractError::InvoiceDefaulted),
            InvoiceStatus::Appealed => return Err(ContractError::InvoiceAppealed),
            InvoiceStatus::Disputed => return Err(ContractError::InvoiceDisputed),
            InvoiceStatus::Expired => return Err(ContractError::InvoiceExpired),
            InvoiceStatus::Funded => {}
            InvoiceStatus::Cancelled => return Err(ContractError::AlreadyCancelled),
        }

        let remaining = invoice.amount - invoice.amount_paid;
        if amount > remaining {
            return Err(ContractError::OverpaymentRejected);
        }

        let funders = get_invoice_funders(&env, invoice_id);
        if funders.is_empty() {
            return Err(ContractError::NotFunded);
        }

        let token = token_client(&env, &invoice.token);
        let contract_address = env.current_contract_address();

        // Handle token precision if needed
        let normalized_amount = if is_xlm_token(&env, &invoice.token) {
            normalize_xlm_amount(amount)
        } else if is_eurc_token(&env, &invoice.token) {
            normalize_eurc_amount(amount)
        } else {
            normalize_usdc_amount(amount)
        };

        // Payer sends partial/full amount to the contract
        token.transfer(&invoice.payer, &contract_address, &normalized_amount);

        invoice.amount_paid += amount;

        // If not fully paid, save and emit partial event
        if invoice.amount_paid < invoice.amount {
            save_invoice(&env, &invoice);
            env.events().publish(
                (
                    Symbol::new(&env, "partially_paid"),
                    invoice.id,
                    invoice.payer.clone(),
                ),
                InvoicePartiallyPaid {
                    invoice_id: invoice.id,
                    payer: invoice.payer.clone(),
                    amount_paid_now: amount,
                    total_amount_paid: invoice.amount_paid,
                    remaining_amount: invoice.amount - invoice.amount_paid,
                },
            );
            return Ok(());
        }

        // --- FULL PAYMENT LOGIC ---
        // Calculate protocol fee and deduct it
        let fee_rate: u32 = env
            .storage()
            .instance()
            .get(&crate::storage::DataKey::FeeRate)
            .unwrap_or(0);
        let protocol_fee = invoice.amount.checked_mul(fee_rate as i128).unwrap_or(0) / 10_000;

        if protocol_fee > 0 {
            let admin: Address = env
                .storage()
                .instance()
                .get(&crate::storage::DataKey::Admin)
                .unwrap();
            token.transfer(&contract_address, &admin, &protocol_fee);
        }

        let distribute_amount = invoice.amount - protocol_fee;

        // Legacy compatibility: use first LP for event emission
        let primary_lp = funders.get(0).unwrap().0.clone();

        // Total amount funded by primary LP
        let primary_lp_funded = funders.get(0).unwrap().1;

        // LP payout after settlement distribution
        let primary_lp_payout = distribute_amount
            .checked_mul(primary_lp_funded)
            .unwrap_or(0)
            / invoice.amount;

        // LP earnings
        let lp_earned = primary_lp_payout - primary_lp_funded;

        // Distribute proportionally to funders
        for i in 0..funders.len() {
            let (funder_addr, fund_amt) = funders.get(i).unwrap();
            let funder_share =
                distribute_amount.checked_mul(fund_amt).unwrap_or(0) / invoice.amount;
            if funder_share > 0 {
                token.transfer(&contract_address, &funder_addr, &funder_share);
            }
        }

        // ---- Update invoice ----
        invoice.status = InvoiceStatus::Paid;

        save_invoice(&env, &invoice);

        // Increment total paid counter
        increment_total_paid(&env);

        let paid_on_time = env.ledger().timestamp() <= u64::from(invoice.due_date);
        notify_distribution_settlement(&env, &invoice.freelancer, &invoice.payer, paid_on_time);

        // --- Update payer reputation ---
        let current_score = get_payer_score(&env, &invoice.payer);
        set_payer_score(&env, &invoice.payer, current_score + 1);

        // Increment detailed reputation invoices_paid count for both payer and freelancer
        increment_invoices_paid(&env, &invoice.payer);
        increment_invoices_paid(&env, &invoice.freelancer);

        env.events().publish(
            (
                Symbol::new(&env, "paid"),
                invoice.id,
                invoice.payer.clone(),
                primary_lp.clone(),
            ),
            InvoicePaid {
                invoice_id: invoice.id,
                payer: invoice.payer.clone(),
                lp: primary_lp,
                freelancer: invoice.freelancer.clone(),
                token: invoice.token.clone(),
                amount_paid: invoice.amount,
                lp_earned,
                lp_payout: primary_lp_payout,
                settlement_timestamp: env.ledger().timestamp(),
                paid_on_time,
                status: invoice.status.clone(),
            },
        );

        Ok(())
    }

    // ----------------------------------------------------------------
    // claim_yield
    // ----------------------------------------------------------------
    /// Access: LP only
    pub fn claim_yield(env: Env, invoice_id: u64) -> Result<i128, ContractError> {
        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }

        let invoice = load_invoice(&env, invoice_id);

        // Only the funder can query their own yield
        if let Some(ref funder) = invoice.funder {
            require_lp_by_id(&env, funder, invoice_id)?;
        } else {
            return Err(ContractError::NothingToClaim);
        }

        match invoice.status {
            InvoiceStatus::Pending | InvoiceStatus::PartiallyFunded | InvoiceStatus::Funded => {
                Ok(0)
            }
            InvoiceStatus::Defaulted => Err(ContractError::InvoiceDefaulted),
            InvoiceStatus::Appealed => Err(ContractError::InvoiceAppealed),
            InvoiceStatus::Disputed => Err(ContractError::InvoiceDisputed),
            InvoiceStatus::Expired => Err(ContractError::InvoiceExpired),
            InvoiceStatus::Cancelled => Err(ContractError::AlreadyCancelled),
            InvoiceStatus::Paid => {
                let yield_amount = invoice
                    .amount
                    .checked_mul(discount_rate_as_i128(invoice.discount_rate))
                    .unwrap_or(0)
                    / 10_000;
                Ok(yield_amount)
            }
        }
    }

    // ----------------------------------------------------------------
    // claim_default
    // ----------------------------------------------------------------
    /// Access: LP only
    pub fn claim_default(env: Env, funder: Address, invoice_id: u64) -> Result<(), ContractError> {
        if is_paused(&env) {
            return Err(ContractError::ContractPaused);
        }

        require_lp(&env, &funder)?;

        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }

        let mut invoice = load_invoice(&env, invoice_id);

        let funders = get_invoice_funders(&env, invoice_id);
        let mut is_funder = false;
        for i in 0..funders.len() {
            if funders.get(i).unwrap().0 == funder {
                is_funder = true;
                break;
            }
        }

        if !is_funder {
            return Err(ContractError::Unauthorized);
        }

        let now = env.ledger().timestamp();
        if now < u64::from(invoice.due_date) {
            return Err(ContractError::NotYetDefaulted);
        }

        match invoice.status {
            InvoiceStatus::Funded => {}
            InvoiceStatus::Pending | InvoiceStatus::PartiallyFunded => {
                return Err(ContractError::NotFunded)
            }
            InvoiceStatus::Paid => return Err(ContractError::AlreadyPaid),
            InvoiceStatus::Defaulted => return Err(ContractError::InvoiceDefaulted),
            InvoiceStatus::Appealed => return Err(ContractError::InvoiceAppealed),
            InvoiceStatus::Disputed => return Err(ContractError::InvoiceDisputed),
            InvoiceStatus::Expired => return Err(ContractError::InvoiceExpired),
            InvoiceStatus::Cancelled => return Err(ContractError::AlreadyCancelled),
        }

        let token = token_client(&env, &invoice.token);
        let contract_address = env.current_contract_address();

        let mut total_refunded = 0;

        for i in 0..funders.len() {
            let (funder_addr, fund_amt) = funders.get(i).unwrap();
            let fund_discount = fund_amt
                .checked_mul(discount_rate_as_i128(invoice.discount_rate))
                .unwrap_or(0)
                / 10_000;
            let refund = fund_amt - fund_discount;
            token.transfer(&contract_address, &funder_addr, &refund);
            total_refunded += refund;
        }

        invoice.status = InvoiceStatus::Defaulted;
        save_invoice(&env, &invoice);

        // --- Update payer reputation ---
        // Snapshot the score BEFORE applying the penalty so appeal_default()
        // can restore it exactly if the appeal is upheld.
        let current_score = get_payer_score(&env, &invoice.payer);
        save_pre_default_payer_score(&env, invoice_id, current_score);

        if current_score > 5 {
            set_payer_score(&env, &invoice.payer, current_score - 5);
        } else {
            set_payer_score(&env, &invoice.payer, 0);
        }

        // Increment detailed reputation invoices_defaulted count for the payer
        increment_invoices_defaulted(&env, &invoice.payer);

        env.events().publish(
            (Symbol::new(&env, "defaulted"), invoice.id, funder.clone()),
            InvoiceDefaulted {
                invoice_id: invoice.id,
                funder,
                freelancer: invoice.freelancer.clone(),
                payer: invoice.payer.clone(),
                token: invoice.token.clone(),
                amount: invoice.amount,
                due_date: u64::from(invoice.due_date),
                defaulted_at: now,
                discount_amount: total_refunded,
                status: invoice.status.clone(),
            },
        );

        Ok(())
    }

    // ================================================================
    // Issue #36: appeal_default — payer contests an unfair default
    //
    // Flow:
    //   1. Payer calls `appeal_default(invoice_id, evidence_hash)`.
    //   2. Invoice transitions to `Appealed` status.
    //   3. Admin/governance calls `resolve_appeal(invoice_id, upheld)`.
    //      - upheld=true  → default reversed, score restored.
    //      - upheld=false → invoice remains Defaulted.
    // ================================================================

    /// File an appeal against an unfair default marking.
    ///
    /// * `invoice_id`    – the defaulted invoice
    /// * `evidence_hash` – SHA-256 hash of off-chain evidence provided by the payer
    /// Access: Payer only
    pub fn appeal_default(
        env: Env,
        invoice_id: u64,
        evidence_hash: BytesN<32>,
    ) -> Result<(), ContractError> {
        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }

        let mut invoice = load_invoice(&env, invoice_id);

        // Only the payer may appeal.
        require_payer_by_id(&env, invoice_id)?;

        // Check AlreadyAppealed BEFORE status check: after the first appeal the
        // status is `Appealed` (not `Defaulted`), so the status guard would fire
        // with the wrong error code if checked first.
        if get_appeal(&env, invoice_id).is_some() {
            return Err(ContractError::AlreadyAppealed);
        }

        // Invoice must be in Defaulted state.
        if invoice.status != InvoiceStatus::Defaulted {
            return Err(ContractError::NotDefaulted);
        }

        let now = env.ledger().timestamp();

        // Appeal must be filed within the appeal window after default.
        // A default can only occur after due_date, so we measure from due_date.
        if now > u64::from(invoice.due_date) + APPEAL_WINDOW_SECONDS {
            return Err(ContractError::AppealWindowClosed);
        }

        // Use the pre-default score snapshot saved by claim_default().
        // Fall back to the current score if somehow missing (shouldn't happen).
        let pre_default_score = get_pre_default_payer_score(&env, invoice_id)
            .unwrap_or_else(|| get_payer_score(&env, &invoice.payer));

        save_appeal(
            &env,
            invoice_id,
            &AppealRecord {
                evidence_hash: evidence_hash.clone(),
                appealed_at: now.try_into().unwrap(),
                pre_default_score,
            },
        );

        invoice.status = InvoiceStatus::Appealed;
        save_invoice(&env, &invoice);

        env.events().publish(
            (
                Symbol::new(&env, "default_appealed"),
                invoice_id,
                invoice.payer.clone(),
            ),
            DefaultAppealed {
                invoice_id,
                payer: invoice.payer.clone(),
                evidence_hash,
                appealed_at: now,
            },
        );

        Ok(())
    }

    /// Resolve a pending appeal (admin / governance only).
    ///
    /// * `upheld=true`  → reverse the default, restore pre-default score, status → Defaulted (reversed).
    ///   In practice the status transitions back to Defaulted with score restored so the LP
    ///   can still collect principal they were already refunded. The key effect is reputation repair.
    /// * `upheld=false` → reject the appeal; invoice remains Defaulted (status reverts from Appealed).
    /// Access: Admin only
    pub fn resolve_appeal(env: Env, invoice_id: u64, upheld: bool) -> Result<(), ContractError> {
        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }

        let mut invoice = load_invoice(&env, invoice_id);

        if invoice.status != InvoiceStatus::Appealed {
            return Err(ContractError::NotDefaulted);
        }

        let appeal = get_appeal(&env, invoice_id).ok_or(ContractError::InvoiceNotFound)?;

        let now = env.ledger().timestamp();

        if upheld {
            // Restore the payer's reputation to what it was before the default.
            set_payer_score(&env, &invoice.payer, appeal.pre_default_score);

            // Decrement invoices_defaulted count since the default was reversed
            let mut profile = get_reputation(&env, &invoice.payer);
            profile.invoices_defaulted = profile.invoices_defaulted.saturating_sub(1);
            set_reputation(&env, &profile);

            // Status moves back to Defaulted — the LP still received their refund,
            // but the reputational penalty on the payer is reversed.
            invoice.status = InvoiceStatus::Defaulted;
        } else {
            // Appeal rejected; mark as Defaulted again (was temporarily Appealed).
            invoice.status = InvoiceStatus::Defaulted;
        }

        save_invoice(&env, &invoice);

        env.events().publish(
            (
                Symbol::new(&env, "appeal_resolved"),
                invoice_id,
                invoice.payer.clone(),
            ),
            AppealResolved {
                invoice_id,
                payer: invoice.payer.clone(),
                upheld,
                resolved_at: now,
            },
        );

        Ok(())
    }

    // ================================================================
    // Dispute Mechanism — payer raised disputes before settlement
    // ================================================================

    /// Dispute an invoice before settlement.
    ///
    /// * `invoice_id`  – the invoice to dispute
    /// * `reason_hash` – SHA-256 hash of off-chain dispute evidence
    /// Access: Payer only
    pub fn dispute_invoice(
        env: Env,
        invoice_id: u64,
        reason_hash: BytesN<32>,
    ) -> Result<(), ContractError> {
        if is_paused(&env) {
            return Err(ContractError::ContractPaused);
        }

        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }

        let mut invoice = load_invoice(&env, invoice_id);

        // Only the payer may dispute.
        require_payer_by_id(&env, invoice_id)?;

        // Check if already disputed.
        if get_dispute(&env, invoice_id).is_some() {
            return Err(ContractError::AlreadyDisputed);
        }

        // Only Pending, PartiallyFunded or Funded invoices can be disputed (before settlement).
        match invoice.status {
            InvoiceStatus::Pending | InvoiceStatus::PartiallyFunded | InvoiceStatus::Funded => {}
            InvoiceStatus::Paid => return Err(ContractError::AlreadyPaid),
            InvoiceStatus::Defaulted => return Err(ContractError::InvoiceDefaulted),
            InvoiceStatus::Appealed => return Err(ContractError::InvoiceAppealed),
            InvoiceStatus::Expired => return Err(ContractError::InvoiceExpired),
            InvoiceStatus::Cancelled => return Err(ContractError::AlreadyCancelled),
            InvoiceStatus::Disputed => return Err(ContractError::AlreadyDisputed),
        }

        let now_ts = env.ledger().timestamp();
        let now_ledger = env.ledger().sequence();

        save_dispute(
            &env,
            invoice_id,
            &DisputeRecord {
                reason_hash: reason_hash.clone(),
                disputed_at: now_ledger,
            },
        );

        invoice.status = InvoiceStatus::Disputed;
        save_invoice(&env, &invoice);

        env.events().publish(
            (
                Symbol::new(&env, "disputed"),
                invoice_id,
                invoice.payer.clone(),
            ),
            InvoiceDisputed {
                invoice_id,
                payer: invoice.payer.clone(),
                reason_hash,
                disputed_at: now_ts,
            },
        );

        Ok(())
    }

    /// Resolve a dispute (admin / governance only).
    ///
    /// * `resolution_hash` – Optional hash of resolution details
    /// * `resolution`      – Ruling: 1 = Upheld (Payer right), 2 = Rejected (Freelancer right)
    /// Access: Admin only
    pub fn resolve_dispute(
        env: Env,
        invoice_id: u64,
        resolution_hash: BytesN<32>,
        resolution: u32,
    ) -> Result<(), ContractError> {
        require_admin(&env)?;

        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }

        let mut invoice = load_invoice(&env, invoice_id);

        if invoice.status != InvoiceStatus::Disputed {
            return Err(ContractError::NotDisputed);
        }

        match resolution {
            1 => {
                // Upheld: Payer is right.
                // Refund LPs if it was funded.
                let funders = get_invoice_funders(&env, invoice_id);
                if !funders.is_empty() {
                    let token = token_client(&env, &invoice.token);
                    let contract_address = env.current_contract_address();
                    for i in 0..funders.len() {
                        let (funder_addr, fund_amt) = funders.get(i).unwrap();
                        let fund_discount = fund_amt
                            .checked_mul(discount_rate_as_i128(invoice.discount_rate))
                            .unwrap_or(0)
                            / 10_000;
                        let refund = fund_amt - fund_discount;
                        token.transfer(&contract_address, &funder_addr, &refund);
                    }
                }
                invoice.status = InvoiceStatus::Cancelled;
            }
            2 => {
                // Rejected: Freelancer is right.
                // Restore status based on funding level.
                if invoice.amount_funded == invoice.amount {
                    invoice.status = InvoiceStatus::Funded;
                } else if invoice.amount_funded > 0 {
                    invoice.status = InvoiceStatus::PartiallyFunded;
                } else {
                    invoice.status = InvoiceStatus::Pending;
                }
            }
            _ => return Err(ContractError::Unauthorized), // Invalid resolution
        }

        save_invoice(&env, &invoice);

        env.events().publish(
            (
                Symbol::new(&env, "dispute_resolved"),
                invoice_id,
                resolution_hash.clone(),
            ),
            DisputeResolved {
                invoice_id,
                resolution_hash,
                resolution,
                resolved_at: env.ledger().timestamp(),
            },
        );

        Ok(())
    }

    /// Auto-resolve a dispute after the timeout has passed.
    ///
    /// * `invoice_id` – the invoice to auto-resolve
    /// Access: Anyone
    pub fn auto_resolve_dispute(env: Env, invoice_id: u64) -> Result<(), ContractError> {
        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }

        let mut invoice = load_invoice(&env, invoice_id);

        if invoice.status != InvoiceStatus::Disputed {
            return Err(ContractError::NotDisputed);
        }

        let dispute = get_dispute(&env, invoice_id).ok_or(ContractError::InvoiceNotFound)?;
        let config = crate::storage::get_config(&env).ok_or(ContractError::Unauthorized)?;

        let now_ledger = env.ledger().sequence();

        if u64::from(now_ledger) < u64::from(dispute.disputed_at) + config.dispute_timeout_ledgers {
            return Err(ContractError::Unauthorized); // Or a more specific error like TimeoutNotReached
        }

        // Auto-resolve: Default to Rejected (Freelancer right) to prevent DOS.
        if invoice.amount_funded == invoice.amount {
            invoice.status = InvoiceStatus::Funded;
        } else if invoice.amount_funded > 0 {
            invoice.status = InvoiceStatus::PartiallyFunded;
        } else {
            invoice.status = InvoiceStatus::Pending;
        }

        save_invoice(&env, &invoice);

        let empty_hash = BytesN::from_array(&env, &[0u8; 32]);
        env.events().publish(
            (
                Symbol::new(&env, "dispute_resolved"),
                invoice_id,
                empty_hash.clone(),
            ),
            DisputeResolved {
                invoice_id,
                resolution_hash: empty_hash,
                resolution: 2, // Rejected
                resolved_at: env.ledger().timestamp(),
            },
        );

        Ok(())
    }

    // ================================================================
    // Contract Configuration
    // ================================================================

    #[allow(clippy::too_many_arguments)]
    pub fn update_config(
        env: Env,
        caller: Address,
        high_rep_threshold: u32,
        bonus_bps: u32,
        min_discount_rate_bps: u32,
        decay_rate_bps: u32,
        decay_period_ledgers: u64,
        dispute_timeout_ledgers: u64,
        xlm_sac_address: Address,
        usdc_sac_address: Address,
        eurc_sac_address: Address,
    ) -> Result<(), ContractError> {
        crate::config::update_config(
            &env,
            &caller,
            high_rep_threshold,
            bonus_bps,
            min_discount_rate_bps,
            decay_rate_bps,
            decay_period_ledgers,
            dispute_timeout_ledgers,
            xlm_sac_address,
            usdc_sac_address,
            eurc_sac_address,
        )
        .map_err(|_| ContractError::Unauthorized)
    }

    pub fn get_config(env: Env) -> Result<Config, ContractError> {
        crate::storage::get_config(&env).ok_or(ContractError::Unauthorized)
    }
    // payer_score
    // ----------------------------------------------------------------
    /// Access: Anyone
    pub fn payer_score(env: Env, payer: Address) -> u32 {
        get_payer_score(&env, &payer)
    }

    // ----------------------------------------------------------------
    // lp_score  (Issue #34)
    // ----------------------------------------------------------------
    /// Access: Anyone
    pub fn lp_score(env: Env, lp: Address) -> u32 {
        get_lp_score(&env, &lp)
    }

    // ----------------------------------------------------------------
    // get_top_payers (Issue #77)
    // ----------------------------------------------------------------
    /// Return up to `limit` payers with the highest reputation scores.
    /// Reads from the maintained top-payers heap — no full-list sort required.
    /// Access: Anyone
    pub fn get_top_payers(env: Env, limit: u32) -> Vec<TopPayerEntry> {
        crate::top_payers::get_top_payers(&env, limit)
    }

    // ----------------------------------------------------------------
    // get_reputation (Issue #26)
    // ----------------------------------------------------------------
    /// Read an address's detailed reputation profile. Unknown addresses return
    /// a zeroed profile rather than panicking.
    /// Access: Anyone
    pub fn get_reputation(env: Env, address: Address) -> ReputationProfile {
        get_reputation(&env, &address)
    }

    // ----------------------------------------------------------------
    // min_payer_reputation config (Issue #28)
    // ----------------------------------------------------------------
    /// Current minimum payer reputation required to fund an invoice (0 = off).
    /// Access: Anyone
    pub fn min_payer_reputation(env: Env) -> u32 {
        get_min_payer_reputation(&env)
    }

    /// Update the minimum payer reputation threshold.
    /// Access: Admin only
    pub fn set_min_payer_reputation(env: Env, value: u32) -> Result<(), ContractError> {
        require_admin(&env)?;
        let updated_by = get_admin(&env).ok_or(ContractError::Unauthorized)?;
        let old_value = get_min_payer_reputation(&env);
        set_min_payer_reputation(&env, value);
        let pn = Symbol::new(&env, "min_payer_reputation");
        env.events().publish(
            (
                Symbol::new(&env, "parameter_updated"),
                pn.clone(),
                updated_by.clone(),
            ),
            ParameterUpdated {
                param_name: pn,
                old_value: old_value as i128,
                new_value: value as i128,
                updated_by,
            },
        );
        Ok(())
    }

    // ----------------------------------------------------------------
    // suggested_discount_rate
    // ----------------------------------------------------------------
    /// Access: Anyone
    pub fn suggested_discount_rate(env: Env, payer: Address) -> u32 {
        let score = get_payer_score(&env, &payer);
        let capped = score.min(100);
        let rate = 500 + (100 - capped) * 5;
        rate.max(50)
    }

    /// Returns the invoice with the given `invoice_id`.
    ///
    /// This is a read-only view method that returns the full `Invoice`
    /// struct, including submitter, payer, LP, token, amount, discount rate,
    /// due date, status, and funding state.
    ///
    /// # Errors
    ///
    /// Returns `ContractError::InvoiceNotFound` if the invoice does not exist.
    // ----------------------------------------------------------------
    // get_invoice
    // ----------------------------------------------------------------
    /// Access: Anyone
    pub fn get_invoice(env: Env, invoice_id: u64) -> Result<Invoice, ContractError> {
        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }
        Ok(load_invoice(&env, invoice_id))
    }

    /// Access: Anyone
    pub fn get_invoice_count(env: Env) -> u64 {
        crate::invoice::read_next_invoice_id(&env) - 1
    }

    // ----------------------------------------------------------------
    // query_nft_metadata
    // ----------------------------------------------------------------
    /// Get NFT metadata for an invoice
    ///
    /// Returns complete NFT metadata including invoice ID, amount, due date,
    /// discount rate, token address, current owner, and mint timestamp.
    ///
    /// # Arguments
    /// * `env` - Soroban environment
    /// * `invoice_id` - The invoice ID
    ///
    /// # Returns
    /// Option containing the NFT metadata if the NFT exists, None otherwise
    ///
    /// # Access
    /// Anyone
    pub fn query_nft_metadata(env: Env, invoice_id: u64) -> Option<crate::nft::InvoiceNftMetadata> {
        crate::nft::query_nft_metadata(env, invoice_id)
    }

    // ----------------------------------------------------------------
    // query_nft_owner
    // ----------------------------------------------------------------
    /// Get the owner of an invoice NFT
    ///
    /// Returns the current owner address of the NFT representing the invoice.
    ///
    /// # Arguments
    /// * `env` - Soroban environment
    /// * `invoice_id` - The invoice ID
    ///
    /// # Returns
    /// Option containing the owner address if the NFT exists, None otherwise
    ///
    /// # Access
    /// Anyone
    pub fn query_nft_owner(env: Env, invoice_id: u64) -> Option<Address> {
        crate::nft::query_nft_owner(env, invoice_id)
    }
}

// ----------------------------------------------------------------
// TOKEN HELPERS
// ----------------------------------------------------------------

fn token_client<'a>(env: &'a Env, token: &Address) -> TokenClient<'a> {
    TokenClient::new(env, token)
}

fn discount_rate_as_i128(rate: u32) -> i128 {
    rate as i128
}

/// Compute 10^exp as i128 without std.  Used for token-decimal scaling.
/// Saturates at i128::MAX to prevent overflow for extreme inputs (max useful
/// value is 10^18 which fits comfortably inside i128).
fn ten_pow(exp: u32) -> i128 {
    let mut result: i128 = 1;
    for _ in 0..exp {
        result = result.saturating_mul(10);
    }
    result
}

// ----------------------------------------------------------------
// XLM PRECISION HANDLING
// ----------------------------------------------------------------
/// Check if a token address is the XLM SAC address
fn is_xlm_token(env: &Env, token: &Address) -> bool {
    if let Some(config) = crate::storage::get_config(env) {
        token == &config.xlm_sac_address
    } else {
        false
    }
}

/// Convert amount from XLM precision (7 decimals) to contract precision
fn normalize_xlm_amount(amount: i128) -> i128 {
    amount
}

/// Check if a token address is the USDC address
#[allow(dead_code)]
fn is_usdc_token(env: &Env, token: &Address) -> bool {
    if let Some(config) = crate::storage::get_config(env) {
        token == &config.usdc_sac_address
    } else {
        false
    }
}

/// Convert amount from USDC precision (6 decimals) to contract precision
fn normalize_usdc_amount(amount: i128) -> i128 {
    amount
}

/// Check if a token address is the EURC address
fn is_eurc_token(env: &Env, token: &Address) -> bool {
    if let Some(config) = crate::storage::get_config(env) {
        token == &config.eurc_sac_address
    } else {
        false
    }
}

/// Convert amount from EURC precision (6 decimals) to contract precision
fn normalize_eurc_amount(amount: i128) -> i128 {
    amount
}

fn validate_invoice_terms(
    env: &Env,
    amount: i128,
    due_date: u64,
    discount_rate: u32,
) -> Result<(), ContractError> {
    // Backward-compatible fallback (no token context).  Uses the minimum for a
    // 6-decimal token (USDC).  New call-sites should prefer
    // `validate_invoice_terms_with_token` so the check is token-aware.
    validate_invoice_terms_for_min(env, amount, 1_000_000, due_date, discount_rate)
}

/// Validate invoice terms using the decimal precision stored for `token`.
///
/// The minimum accepted amount is `1` whole unit in the token's own precision:
/// - 6-decimal token (USDC): minimum = 1_000_000  (= 1 USDC)
/// - 7-decimal token (XLM):  minimum = 10_000_000 (= 1 XLM)
///
/// Falls back to the 6-decimal floor when no decimals are registered for the
/// token (i.e. a token added via legacy code paths before Issue #23).
fn validate_invoice_terms_with_token(
    env: &Env,
    amount: i128,
    due_date: u64,
    discount_rate: u32,
    token: &Address,
) -> Result<(), ContractError> {
    let decimals: u32 = env
        .storage()
        .persistent()
        .get(&crate::storage::DataKey::TokenDecimals(token.clone()))
        .unwrap_or(6);

    let min_amount: i128 = ten_pow(decimals);
    validate_invoice_terms_for_min(env, amount, min_amount, due_date, discount_rate)
}

/// Core validation logic shared by the two public entry points above.
fn validate_invoice_terms_for_min(
    env: &Env,
    amount: i128,
    min_amount: i128,
    due_date: u64,
    discount_rate: u32,
) -> Result<(), ContractError> {
    if amount < min_amount {
        return Err(ContractError::InvalidAmount);
    }

    let max_rate: u32 = env
        .storage()
        .instance()
        .get(&crate::storage::DataKey::MaxDiscountRate)
        .unwrap_or(5000);
    if discount_rate == 0 || discount_rate > max_rate {
        return Err(ContractError::InvalidDiscountRate);
    }

    // The on-chain storage representation now uses u32 timestamps.
    if due_date > u64::from(u32::MAX) {
        return Err(ContractError::InvalidDueDate);
    }

    let now = env.ledger().timestamp();

    // Validate due date is in the future
    if due_date <= now {
        return Err(ContractError::InvalidDueDate);
    }

    if due_date < now + MIN_INVOICE_DURATION {
        return Err(ContractError::DueDateTooSoon);
    }

    if due_date > now + MAX_INVOICE_DURATION {
        return Err(ContractError::DueDateTooFar);
    }

    Ok(())
}

fn is_approved_token(env: &Env, token: &Address) -> bool {
    // First check the explicit allowlist in storage
    if env
        .storage()
        .persistent()
        .get(&crate::storage::DataKey::ApprovedToken(token.clone()))
        .unwrap_or(false)
    {
        return true;
    }

    // Then check the wired tokens in Config
    if let Some(config) = crate::storage::get_config(env) {
        if token == &config.usdc_sac_address
            || token == &config.eurc_sac_address
            || token == &config.xlm_sac_address
        {
            return true;
        }
    }

    false
}

fn notify_distribution_funding(env: &Env, lp: &Address, amount_usdc_equivalent: i128) {
    let Some(dist_contract) = env
        .storage()
        .instance()
        .get::<_, Address>(&crate::storage::DataKey::DistributionContract)
    else {
        return;
    };

    let args = vec![
        env,
        lp.clone().into_val(env),
        amount_usdc_equivalent.into_val(env),
    ];
    env.invoke_contract::<()>(&dist_contract, &Symbol::new(env, "accrue_lp"), args);
}

fn notify_distribution_settlement(
    env: &Env,
    freelancer: &Address,
    payer: &Address,
    settled_on_time: bool,
) {
    let Some(dist_contract) = env
        .storage()
        .instance()
        .get::<_, Address>(&crate::storage::DataKey::DistributionContract)
    else {
        return;
    };

    let args = vec![
        env,
        freelancer.clone().into_val(env),
        payer.clone().into_val(env),
        settled_on_time.into_val(env),
    ];
    env.invoke_contract::<()>(&dist_contract, &Symbol::new(env, "accrue_settlement"), args);
}

// ----------------------------------------------------------------
// TEST MODULES
// ----------------------------------------------------------------

pub(crate) mod test;
#[cfg(test)]
mod tests_access_control;
mod tests_appeal;
mod tests_arithmetic;
mod tests_auth;
mod tests_benchmarks;
mod tests_discount_invariants;
mod tests_dispute;
mod tests_distribution;
#[cfg(test)]
mod tests_governance_features;
mod tests_invariants;
#[cfg(test)]
mod tests_invoice_paid_event;
#[cfg(test)]
mod tests_lazy_storage;
#[cfg(test)]
mod tests_lp_funding_details_event;
mod tests_lp_priority_queue;
mod tests_mutation;
#[cfg(test)]
mod tests_oracle_freshness;
#[cfg(test)]
mod tests_oracle_verification;
#[cfg(test)]
mod tests_partial_payment;
mod tests_protocol_fee;
#[cfg(test)]
mod tests_referral;
#[cfg(test)]
mod tests_reputation_events;
mod tests_security;
mod tests_state_machine;
mod tests_storage;
mod tests_storage_extra;
#[cfg(test)]
mod tests_token_decimals;
#[cfg(test)]
mod tests_token_switch;
#[cfg(test)]
mod tests_top_payers;
