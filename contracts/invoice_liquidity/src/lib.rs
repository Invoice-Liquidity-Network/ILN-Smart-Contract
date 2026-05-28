#![no_std]

mod errors;
mod events;
mod invoice;
mod tests_regression;

pub use errors::ContractError;
pub use invoice::{Invoice, InvoiceParams, InvoiceStatus};

use soroban_sdk::{
    contract, contractimpl, token::Client as TokenClient, vec, Address, Env, IntoVal, Symbol, Vec,
};

use events::{
    AdminChanged, InvoiceCancelled, InvoiceDefaulted, InvoiceFunded, InvoicePaid, InvoiceSubmitted,
    InvoiceTransferred, InvoiceUpdated, ReputationUpdated,
};
use invoice::{
    get_invoice_funders, get_payer_score, get_payer_stats, invoice_exists, load_invoice,
    next_invoice_id, save_invoice, save_invoice_funders, set_payer_score, set_payer_stats,
    StorageKey,
};

// ----------------------------------------------------------------
// CONTRACT
// ----------------------------------------------------------------

#[contract]
pub struct InvoiceLiquidityContract;

#[contractimpl]
impl InvoiceLiquidityContract {
    // ------------------------------------------------------------
    // initialize (multi-token aware)
    // ------------------------------------------------------------
    pub fn initialize(
        env: Env,
        admin: Address,
        token: Address,
        xlm_token: Address,
    ) -> Result<(), ContractError> {
        if env.storage().instance().has(&StorageKey::InvoiceCount) {
            return Err(ContractError::AlreadyInitialized);
        }

        env.storage().instance().set(&StorageKey::Admin, &admin);
        env.storage().instance().set(&StorageKey::FeeRate, &0_u32);
        env.storage()
            .instance()
            .set(&StorageKey::MaxDiscountRate, &5000_u32);

        // approve first token (USDC or default)
        env.storage()
            .persistent()
            .set(&StorageKey::ApprovedToken(token.clone()), &true);

        // approve native XLM SAC
        env.storage()
            .persistent()
            .set(&StorageKey::ApprovedToken(xlm_token.clone()), &true);

        let mut list: Vec<Address> = Vec::new(&env);
        list.push_back(token.clone());
        list.push_back(xlm_token.clone());

        env.storage()
            .persistent()
            .set(&StorageKey::TokenList, &list);

        Ok(())
    }

    // ------------------------------------------------------------
    pub fn set_admin(env: Env, new_admin: Address) {
        let old_admin: Address = env.storage().instance().get(&StorageKey::Admin).unwrap();
        old_admin.require_auth();
        env.storage().instance().set(&StorageKey::Admin, &new_admin);
        env.events().publish_event(&AdminChanged {
            old_admin,
            new_admin,
            timestamp: env.ledger().timestamp(),
        });
    }

    pub fn update_fee_rate(env: Env, rate: u32) {
        let admin: Address = env.storage().instance().get(&StorageKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&StorageKey::FeeRate, &rate);
    }

    pub fn update_max_discount(env: Env, rate: u32) {
        let admin: Address = env.storage().instance().get(&StorageKey::Admin).unwrap();
        admin.require_auth();
        env.storage()
            .instance()
            .set(&StorageKey::MaxDiscountRate, &rate);
    }

    pub fn set_distribution_contract(env: Env, distribution_contract: Address) {
        let admin: Address = env.storage().instance().get(&StorageKey::Admin).unwrap();
        admin.require_auth();
        env.storage()
            .instance()
            .set(&StorageKey::DistributionContract, &distribution_contract);
    }

    pub fn add_token(env: Env, token: Address) {
        let admin: Address = env.storage().instance().get(&StorageKey::Admin).unwrap();
        admin.require_auth();
        env.storage()
            .persistent()
            .set(&StorageKey::ApprovedToken(token.clone()), &true);

        let mut list: Vec<Address> = env
            .storage()
            .persistent()
            .get(&StorageKey::TokenList)
            .unwrap_or(Vec::new(&env));
        if !list.contains(&token) {
            list.push_back(token);
            env.storage()
                .persistent()
                .set(&StorageKey::TokenList, &list);
        }
    }

    pub fn remove_token(env: Env, token: Address) {
        let admin: Address = env.storage().instance().get(&StorageKey::Admin).unwrap();
        admin.require_auth();
        env.storage()
            .persistent()
            .set(&StorageKey::ApprovedToken(token.clone()), &false);
    }

    // ------------------------------------------------------------
    // submit_invoice (NOW TOKEN-AWARE)
    // ------------------------------------------------------------
    pub fn submit_invoice(
        env: Env,
        freelancer: Address,
        payer: Address,
        amount: i128,
        due_date: u64,
        discount_rate: u32,
        token: Address,
    ) -> Result<u64, ContractError> {
        freelancer.require_auth();

        validate_invoice_terms(&env, amount, due_date, discount_rate)?;

        // token validation
        if !is_approved_token(&env, &token) {
            return Err(ContractError::Unauthorized);
        }

        let id = next_invoice_id(&env);

        let invoice = Invoice {
            id,
            freelancer,
            payer,
            token,
            amount,
            due_date,
            discount_rate,
            status: InvoiceStatus::Pending,
            funder: None,
            funded_at: None,
            amount_funded: 0,
        };

        save_invoice(&env, &invoice);
        record_invoice_submission(&env, &invoice.payer);

        env.events().publish_event(&InvoiceSubmitted {
            invoice_id: invoice.id,
            freelancer: invoice.freelancer.clone(),
            payer: invoice.payer.clone(),
            token: invoice.token.clone(),
            amount: invoice.amount,
            due_date: invoice.due_date,
            discount_rate: invoice.discount_rate,
            status: invoice.status.clone(),
            timestamp: env.ledger().timestamp(),
        });

        Ok(id)
    }

    // ------------------------------------------------------------
    // update_invoice
    // ------------------------------------------------------------
    pub fn update_invoice(
        env: Env,
        freelancer: Address,
        invoice_id: u64,
        amount: i128,
        due_date: u64,
        discount_rate: u32,
    ) -> Result<(), ContractError> {
        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }

        let mut invoice = load_invoice(&env, invoice_id);
        freelancer.require_auth();

        if invoice.freelancer != freelancer {
            return Err(ContractError::Unauthorized);
        }

        if invoice.status == InvoiceStatus::Pending && env.ledger().timestamp() >= invoice.due_date
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
            InvoiceStatus::Expired => return Err(ContractError::InvoiceExpired),
            InvoiceStatus::Cancelled => return Err(ContractError::AlreadyCancelled),
        }

        validate_invoice_terms(&env, amount, due_date, discount_rate)?;

        invoice.amount = amount;
        invoice.due_date = due_date;
        invoice.discount_rate = discount_rate;

        save_invoice(&env, &invoice);

        env.events().publish_event(&InvoiceUpdated {
            invoice_id: invoice.id,
            freelancer: invoice.freelancer.clone(),
            payer: invoice.payer.clone(),
            token: invoice.token.clone(),
            amount: invoice.amount,
            due_date: invoice.due_date,
            discount_rate: invoice.discount_rate,
            status: invoice.status.clone(),
        });

        Ok(())
    }

    // ------------------------------------------------------------
    // submit_invoices_batch
    // ------------------------------------------------------------
    pub fn submit_invoices_batch(
        env: Env,
        invoices: Vec<InvoiceParams>,
    ) -> Result<Vec<u64>, ContractError> {
        if invoices.len() > 10 {
            return Err(ContractError::BatchTooLarge);
        }

        let mut authenticated_freelancers: Vec<Address> = Vec::new(&env);
        let mut ids = Vec::new(&env);
        for params in invoices.iter() {
            if !authenticated_freelancers.contains(&params.freelancer) {
                params.freelancer.require_auth();
                authenticated_freelancers.push_back(params.freelancer.clone());
            }

            validate_invoice_terms(&env, params.amount, params.due_date, params.discount_rate)?;

            if !is_approved_token(&env, &params.token) {
                return Err(ContractError::Unauthorized);
            }

            let id = next_invoice_id(&env);

            let invoice = Invoice {
                id,
                freelancer: params.freelancer,
                payer: params.payer,
                token: params.token,
                amount: params.amount,
                due_date: params.due_date,
                discount_rate: params.discount_rate,
                status: InvoiceStatus::Pending,
                funder: None,
                funded_at: None,
                amount_funded: 0,
            };

            save_invoice(&env, &invoice);
            record_invoice_submission(&env, &invoice.payer);

            env.events().publish_event(&InvoiceSubmitted {
                invoice_id: invoice.id,
                freelancer: invoice.freelancer.clone(),
                payer: invoice.payer.clone(),
                token: invoice.token.clone(),
                amount: invoice.amount,
                due_date: invoice.due_date,
                discount_rate: invoice.discount_rate,
                status: invoice.status.clone(),
                timestamp: env.ledger().timestamp(),
            });

            ids.push_back(id);
        }

        Ok(ids)
    }

    // ------------------------------------------------------------
    // fund_invoice (USES invoice.token)
    // ------------------------------------------------------------
    pub fn fund_invoice(
        env: Env,
        funder: Address,
        invoice_id: u64,
        fund_amount: i128,
    ) -> Result<(), ContractError> {
        funder.require_auth();

        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }

        let mut invoice = load_invoice(&env, invoice_id);

        if invoice.status == InvoiceStatus::Pending && env.ledger().timestamp() >= invoice.due_date
        {
            invoice.status = InvoiceStatus::Expired;
            save_invoice(&env, &invoice);
            return Err(ContractError::InvoiceExpired);
        }

        match invoice.status {
            InvoiceStatus::Paid => return Err(ContractError::AlreadyPaid),
            InvoiceStatus::Defaulted => return Err(ContractError::InvoiceDefaulted),
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
        
        let fund_discount = fund_amount
            .checked_mul(discount_rate_as_i128(invoice.discount_rate))
            .unwrap_or(0)
            / 10_000;
        let cost = fund_amount - fund_discount;
        
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
            invoice.funded_at = Some(env.ledger().timestamp());
            invoice.funder = Some(funder.clone()); // Legacy support for single funder if it was first
        } else {
            invoice.status = InvoiceStatus::PartiallyFunded;
        }

        save_invoice(&env, &invoice);

        notify_distribution_funding(&env, &funder, fund_amount);

        env.events().publish_event(&InvoiceFunded {
            invoice_id: invoice.id,
            funder: funder.clone(),
            freelancer: invoice.freelancer.clone(),
            payer: invoice.payer.clone(),
            token: invoice.token.clone(),
            fund_amount,
            amount_funded: invoice.amount_funded,
            invoice_amount: invoice.amount,
            due_date: invoice.due_date,
            discount_rate: invoice.discount_rate,
            funded_at: invoice.funded_at,
            status: invoice.status.clone(),
        });

        Ok(())
    }

    // ------------------------------------------------------------
    // transfer_invoice
    // ------------------------------------------------------------
    pub fn transfer_invoice(
        env: Env,
        invoice_id: u64,
        new_freelancer: Address,
    ) -> Result<(), ContractError> {
        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }

        let mut invoice = load_invoice(&env, invoice_id);

        invoice.freelancer.require_auth();

        match invoice.status {
            InvoiceStatus::Pending => {}
            InvoiceStatus::PartiallyFunded | InvoiceStatus::Funded => {
                return Err(ContractError::AlreadyFunded)
            }
            InvoiceStatus::Paid => return Err(ContractError::AlreadyPaid),
            InvoiceStatus::Defaulted => return Err(ContractError::InvoiceDefaulted),
            InvoiceStatus::Expired => return Err(ContractError::InvoiceExpired),
            InvoiceStatus::Cancelled => return Err(ContractError::AlreadyCancelled),
        }

        let old_freelancer = invoice.freelancer.clone();
        invoice.freelancer = new_freelancer.clone();

        save_invoice(&env, &invoice);

        env.events().publish_event(&InvoiceTransferred {
            invoice_id,
            old_freelancer,
            new_freelancer,
            status: invoice.status.clone(),
        });

        Ok(())
    }

    // ------------------------------------------------------------
    // cancel_invoice
    // ------------------------------------------------------------
    pub fn cancel_invoice(env: Env, invoice_id: u64) -> Result<(), ContractError> {
        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }

        let mut invoice = load_invoice(&env, invoice_id);

        invoice.freelancer.require_auth();

        match invoice.status {
            InvoiceStatus::Pending => {}
            InvoiceStatus::PartiallyFunded => {
                let funders = get_invoice_funders(&env, invoice_id);
                let token = token_client(&env, &invoice.token);
                let contract_address = env.current_contract_address();
                for i in 0..funders.len() {
                    let (funder_addr, fund_amt) = funders.get(i).unwrap();
                    let fund_discount = fund_amt.checked_mul(discount_rate_as_i128(invoice.discount_rate)).unwrap_or(0) / 10_000;
                    let refund = fund_amt - fund_discount;
                    token.transfer(&contract_address, &funder_addr, &refund);
                }
            }
            InvoiceStatus::Funded => {
                return Err(ContractError::AlreadyFunded)
            }
            InvoiceStatus::Paid => return Err(ContractError::AlreadyPaid),
            InvoiceStatus::Defaulted => return Err(ContractError::InvoiceDefaulted),
            InvoiceStatus::Expired => return Err(ContractError::InvoiceExpired),
            InvoiceStatus::Cancelled => return Err(ContractError::AlreadyCancelled),
        }

        invoice.status = InvoiceStatus::Cancelled;

        save_invoice(&env, &invoice);

        env.events().publish_event(&InvoiceCancelled {
            invoice_id,
            freelancer: invoice.freelancer.clone(),
            status: invoice.status.clone(),
        });

        Ok(())
    }

    // ------------------------------------------------------------
    // expire_invoice
    // ------------------------------------------------------------
    pub fn expire_invoice(env: Env, invoice_id: u64) -> Result<(), ContractError> {
        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }

        let mut invoice = load_invoice(&env, invoice_id);

        if env.ledger().timestamp() < invoice.due_date {
            return Err(ContractError::NotYetDefaulted);
        }

        match invoice.status {
            InvoiceStatus::Pending => {
                invoice.status = InvoiceStatus::Expired;
                save_invoice(&env, &invoice);
                Ok(())
            }
            InvoiceStatus::PartiallyFunded | InvoiceStatus::Funded => {
                Err(ContractError::AlreadyFunded)
            }
            InvoiceStatus::Paid => Err(ContractError::AlreadyPaid),
            InvoiceStatus::Defaulted => Err(ContractError::InvoiceDefaulted),
            InvoiceStatus::Expired => Err(ContractError::InvoiceExpired),
            InvoiceStatus::Cancelled => Err(ContractError::AlreadyCancelled),
        }
    }

    // ------------------------------------------------------------
    // mark_paid (USES invoice.token)
    // ------------------------------------------------------------
    pub fn mark_paid(env: Env, invoice_id: u64) -> Result<(), ContractError> {
        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }

        let mut invoice = load_invoice(&env, invoice_id);

        invoice.payer.require_auth();

        match invoice.status {
            InvoiceStatus::Pending | InvoiceStatus::PartiallyFunded => {
                return Err(ContractError::NotFunded)
            }
            InvoiceStatus::Paid => return Err(ContractError::AlreadyPaid),
            InvoiceStatus::Defaulted => return Err(ContractError::InvoiceDefaulted),
            InvoiceStatus::Expired => return Err(ContractError::InvoiceExpired),
            InvoiceStatus::Funded => {}
            InvoiceStatus::Cancelled => return Err(ContractError::AlreadyCancelled),
        }

        let funders = get_invoice_funders(&env, invoice_id);
        if funders.len() == 0 {
            return Err(ContractError::NotFunded);
        }

        let token = token_client(&env, &invoice.token);
        let contract_address = env.current_contract_address();

        // Payer sends full invoice amount to the contract
        token.transfer(&invoice.payer, &contract_address, &invoice.amount);

        // Calculate protocol fee and deduct it
        let fee_rate: u32 = env.storage().instance().get(&StorageKey::FeeRate).unwrap_or(0);
        let protocol_fee = invoice.amount.checked_mul(fee_rate as i128).unwrap_or(0) / 10_000;
        
        if protocol_fee > 0 {
            let admin: Address = env.storage().instance().get(&StorageKey::Admin).unwrap();
            token.transfer(&contract_address, &admin, &protocol_fee);
        }

        let distribute_amount = invoice.amount - protocol_fee;

        // Distribute proportionally to funders
        for i in 0..funders.len() {
            let (funder_addr, fund_amt) = funders.get(i).unwrap();
            let funder_share = distribute_amount.checked_mul(fund_amt).unwrap_or(0) / invoice.amount;
            if funder_share > 0 {
                token.transfer(&contract_address, &funder_addr, &funder_share);
            }
        }

        // ---- Update invoice ----
        invoice.status = InvoiceStatus::Paid;

        save_invoice(&env, &invoice);

        let paid_on_time = env.ledger().timestamp() <= invoice.due_date;
        notify_distribution_settlement(&env, &invoice.freelancer, &invoice.payer, paid_on_time);

        // --- Update payer reputation ---
        let current_score = get_payer_score(&env, &invoice.payer);
        apply_reputation_update(
            &env,
            &invoice.payer,
            current_score.saturating_add(1),
            ReputationStatUpdate::Paid,
        );

        env.events().publish_event(&InvoicePaid {
            invoice_id: invoice.id,
            payer: invoice.payer.clone(),
            funder: funders.get(0).unwrap().0.clone(), // legacy event compatibility
            freelancer: invoice.freelancer.clone(),
            token: invoice.token.clone(),
            amount: invoice.amount,
            discount_amount: invoice.amount - distribute_amount, // emit fee taken as discount_amount for legacy compatibility
            due_date: invoice.due_date,
            paid_on_time,
            status: invoice.status.clone(),
        });

        Ok(())
    }

    // ----------------------------------------------------------------
    // claim_yield
    //
    // Called by the LP after mark_paid has been called.
    //
    // In this contract design the yield is paid out automatically
    // inside mark_paid — so claim_yield is a read function that
    // returns how much yield the LP earned on a specific invoice.
    //
    // Useful for frontends to display LP earnings history.
    // ----------------------------------------------------------------
    pub fn claim_yield(env: Env, invoice_id: u64) -> Result<i128, ContractError> {
        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }

        let invoice = load_invoice(&env, invoice_id);

        // Only the funder can query their own yield
        if let Some(ref funder) = invoice.funder {
            funder.require_auth();
        } else {
            return Err(ContractError::NothingToClaim);
        }

        match invoice.status {
            InvoiceStatus::Pending | InvoiceStatus::PartiallyFunded | InvoiceStatus::Funded => {
                // Not settled yet — yield is pending, return 0
                Ok(0)
            }
            InvoiceStatus::Defaulted => Err(ContractError::InvoiceDefaulted),
            InvoiceStatus::Expired => Err(ContractError::InvoiceExpired),
            InvoiceStatus::Cancelled => Err(ContractError::AlreadyCancelled),
            InvoiceStatus::Paid => {
                // Yield = the discount amount the LP earned
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
    //
    // Called by the LP if the invoice is not paid by the due date.
    // Reclaims the escrowed discount amount.
    // ----------------------------------------------------------------
    pub fn claim_default(env: Env, funder: Address, invoice_id: u64) -> Result<(), ContractError> {
        funder.require_auth();

        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }

        let mut invoice = load_invoice(&env, invoice_id);

        // --- Validations ---

        // Only a funder can claim
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

        // Can only be called after due_date has passed
        let now = env.ledger().timestamp();
        if now < invoice.due_date {
            return Err(ContractError::NotYetDefaulted);
        }

        // Invoice must be in Funded status
        match invoice.status {
            InvoiceStatus::Funded => {} // correct state
            InvoiceStatus::Pending | InvoiceStatus::PartiallyFunded => {
                return Err(ContractError::NotFunded)
            }
            InvoiceStatus::Paid => return Err(ContractError::AlreadyPaid),
            InvoiceStatus::Defaulted => return Err(ContractError::InvoiceDefaulted),
            InvoiceStatus::Expired => return Err(ContractError::InvoiceExpired),
            InvoiceStatus::Cancelled => return Err(ContractError::AlreadyCancelled),
        }

        // --- Execution ---

        let token = token_client(&env, &invoice.token);
        let contract_address = env.current_contract_address();

        // Calculate the total refunded for event emission
        let mut total_refunded = 0;

        // Transfer contributed cost back to funders
        for i in 0..funders.len() {
            let (funder_addr, fund_amt) = funders.get(i).unwrap();
            let fund_discount = fund_amt.checked_mul(discount_rate_as_i128(invoice.discount_rate)).unwrap_or(0) / 10_000;
            let refund = fund_amt - fund_discount;
            token.transfer(&contract_address, &funder_addr, &refund);
            total_refunded += refund;
        }

        // Update status to Defaulted
        invoice.status = InvoiceStatus::Defaulted;
        save_invoice(&env, &invoice);

        // Emit defaulted event
        // --- Update payer reputation ---
        let current_score = get_payer_score(&env, &invoice.payer);
        apply_reputation_update(
            &env,
            &invoice.payer,
            current_score.saturating_sub(5),
            ReputationStatUpdate::Defaulted,
        );

        env.events().publish_event(&InvoiceDefaulted {
            invoice_id: invoice.id,
            funder,
            freelancer: invoice.freelancer.clone(),
            payer: invoice.payer.clone(),
            token: invoice.token.clone(),
            amount: invoice.amount,
            due_date: invoice.due_date,
            defaulted_at: now,
            discount_amount: total_refunded, // legacy event compatibility
            status: invoice.status.clone(),
        });

        Ok(())
    }

    // ----------------------------------------------------------------
    // payer_score
    // ----------------------------------------------------------------
    pub fn payer_score(env: Env, payer: Address) -> u32 {
        get_payer_score(&env, &payer)
    }

    // ----------------------------------------------------------------
    // suggested_discount_rate
    //
    // Returns a suggested discount rate in basis points based on
    // payer's reputation score.
    // Higher score = lower risk = lower discount rate.
    // ----------------------------------------------------------------
    pub fn suggested_discount_rate(env: Env, payer: Address) -> u32 {
        let score = get_payer_score(&env, &payer);
        let capped = score.min(100);
        let rate = 500 + (100 - capped) * 5;
        rate.max(50)
    }

    // ----------------------------------------------------------------
    // get_invoice — read-only helper for frontends and tests
    // ----------------------------------------------------------------
    pub fn get_invoice(env: Env, invoice_id: u64) -> Result<Invoice, ContractError> {
        if !invoice_exists(&env, invoice_id) {
            return Err(ContractError::InvoiceNotFound);
        }
        Ok(load_invoice(&env, invoice_id))
    }

    pub fn get_invoice_count(env: Env) -> u64 {
        env.storage()
            .persistent()
            .get(&StorageKey::InvoiceCount)
            .unwrap_or(0)
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

enum ReputationStatUpdate {
    Paid,
    Defaulted,
}

fn record_invoice_submission(env: &Env, payer: &Address) {
    let mut stats = get_payer_stats(env, payer);
    stats.invoices_submitted = stats.invoices_submitted.saturating_add(1);
    set_payer_stats(env, payer, &stats);
}

fn apply_reputation_update(
    env: &Env,
    payer: &Address,
    next_score: u32,
    stat_update: ReputationStatUpdate,
) {
    let old_score = get_payer_score(env, payer);
    let new_score = next_score.min(100);

    let mut stats = get_payer_stats(env, payer);
    match stat_update {
        ReputationStatUpdate::Paid => {
            stats.invoices_paid = stats.invoices_paid.saturating_add(1);
        }
        ReputationStatUpdate::Defaulted => {
            stats.invoices_defaulted = stats.invoices_defaulted.saturating_add(1);
        }
    }

    set_payer_score(env, payer, new_score);
    set_payer_stats(env, payer, &stats);

    env.events().publish_event(&ReputationUpdated {
        address: payer.clone(),
        old_score,
        new_score,
        invoices_submitted: stats.invoices_submitted,
        invoices_paid: stats.invoices_paid,
        invoices_defaulted: stats.invoices_defaulted,
    });
}

fn validate_invoice_terms(
    env: &Env,
    amount: i128,
    due_date: u64,
    discount_rate: u32,
) -> Result<(), ContractError> {
    if amount < 1_000_000 {
        return Err(ContractError::InvalidAmount);
    }

    let max_rate: u32 = env
        .storage()
        .instance()
        .get(&StorageKey::MaxDiscountRate)
        .unwrap_or(5000);
    if discount_rate == 0 || discount_rate > max_rate {
        return Err(ContractError::InvalidDiscountRate);
    }

    let now = env.ledger().timestamp();
    if due_date <= now {
        return Err(ContractError::InvalidDueDate);
    }
    
    let max_offset = 365 * 24 * 60 * 60;
    if due_date > now + max_offset {
        return Err(ContractError::InvalidDueDate);
    }

    Ok(())
}

fn is_approved_token(env: &Env, token: &Address) -> bool {
    env.storage()
        .persistent()
        .get(&StorageKey::ApprovedToken(token.clone()))
        .unwrap_or(false)
}

fn notify_distribution_funding(env: &Env, lp: &Address, amount_usdc_equivalent: i128) {
    let Some(dist_contract) = env
        .storage()
        .instance()
        .get::<_, Address>(&StorageKey::DistributionContract)
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
        .get::<_, Address>(&StorageKey::DistributionContract)
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

mod test;
mod tests_arithmetic;
mod tests_auth;
mod tests_distribution;
mod tests_invariants;
mod tests_mutation;
mod tests_protocol_fee;
mod tests_security;
mod tests_state_machine;
mod tests_storage;
