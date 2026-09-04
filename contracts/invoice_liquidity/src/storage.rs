use soroban_sdk::{contracttype, Address, BytesN, Env, Symbol};

use crate::config::Config;
use crate::invoice::{AppealRecord, Invoice, LpFundRequest};

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataKey {
    // Instance Storage
    Admin,
    Config,
    FeeRate,
    MaxDiscountRate,
    DistributionContract,
    Paused,
    /// Minimum payer reputation required to fund an invoice (Issue #28). Default 0.
    MinPayerReputation,
    NextInvoiceId,
    /// Issue #124: multi-sig admin configuration (signers + threshold).
    MultisigAdmin,
    /// Issue #124: monotonic counter for unique multisig proposal IDs.
    MultisigProposalCounter,

    // Persistent Storage
    Invoice(u64),         // DEPRECATED: kept for backwards compatibility
    InvoiceCore(u64),     // NEW: hot-path core data (accessed >95% of time)
    InvoiceMetadata(u64), // NEW: cold-path metadata (accessed <5% of time)
    InvoiceCount,
    Token,
    PayerScore(Address),
    InvoiceFunders(u64),
    ApprovedToken(Address),
    TokenList,
    /// Decimal precision for each allowlisted token (e.g. 6 for USDC, 7 for XLM).
    TokenDecimals(Address),
    /// Detailed reputation profile per address (Issue #26).
    Reputation(Address),
    Appeal(u64),
    PreDefaultPayerScore(u64),
    LpScore(Address),
    FundQueue(u64),
    QueueResolution(u64),
    /// Ledger sequence when the first LP joined the fund queue for an invoice.
    /// Used to enforce a minimum maturity delay before `resolve_fund_queue` may
    /// be called, preventing MEV / front-running (Issue #MEV-1).
    FundQueueOpenedAt(u64),

    // Stats (Persistent)
    TotalInvoices,
    TotalFunded,
    TotalPaid,
    TotalVolumeUsdc,
    TotalVolumeEurc,
    TotalVolumeXlm,
    TokenVolume(Address),
    /// Referral counts keyed by fixed-size code
    ReferralCount(BytesN<32>),
    Dispute(u64),
    SubmitterInvoices(Address),
    LpInvoices(Address),
    /// Fixed-size min-heap of the top payers by reputation score (Issue #77).
    TopPayersHeap,
    /// NFT Metadata storage (Issue #423)
    InvoiceNft(u64),
    /// NFT Owner tracking (Issue #423)
    InvoiceNftOwner(u64),
    /// Issue #533: Fee tier configuration — ordered list of (min_amount, fee_rate_bps).
    FeeTiers,
    /// Issue #124: multi-sig proposals by ID.
    MultisigProposal(u64),
    /// Issue #539: Storage version tracking for migration safety.
    StorageVersion,
    /// Reentrancy guard lock (Issue #535)
    ReentrancyLock,
    /// Last ledger sequence when each rate-limited function was called (Issue #541).
    /// Keyed by a Symbol representing the function name.
    RateLimit(Symbol),
    /// Issue #532: governance-controlled oracle registry default, keyed by feed type.
    OracleRegistry(crate::oracle_registry::OracleFeedType),
    /// Issue #532: per-token oracle override, takes priority over OracleRegistry.
    TokenOracle(crate::oracle_registry::OracleFeedType, Address),
    /// Issue #532: last recorded oracle health snapshot for a feed type + token.
    OracleHealth(crate::oracle_registry::OracleFeedType, Address),
    /// Issue #529: deployed insurance pool contract address, consulted by
    /// claim_default() to compensate enrolled LPs on a confirmed default.
    InsurancePool,
}

// ----------------------------------------------------------------
// Config Helpers
// ----------------------------------------------------------------

pub fn get_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Admin)
}

pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
}

pub fn get_config(env: &Env) -> Option<Config> {
    env.storage().instance().get(&DataKey::Config)
}

pub fn set_config(env: &Env, config: &Config) {
    env.storage().instance().set(&DataKey::Config, config);
}

/// Issue #529: the configured insurance pool contract address, if any.
pub fn get_insurance_pool(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::InsurancePool)
}

pub fn set_insurance_pool(env: &Env, pool: &Address) {
    env.storage().instance().set(&DataKey::InsurancePool, pool);
}

pub fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

pub fn set_paused(env: &Env, paused: bool) {
    env.storage().instance().set(&DataKey::Paused, &paused);
}

// ----------------------------------------------------------------
// Invoice Helpers
// ----------------------------------------------------------------

/// Save invoice by splitting into hot and cold data for optimized storage.
///
/// This function saves the invoice in two separate storage entries:
/// - InvoiceCore: Contains frequently-accessed fields (>95% of operations)
/// - InvoiceMetadata: Contains rarely-accessed fields (<5% of operations)
///
/// This optimization reduces gas costs by:
/// 1. Minimizing serialization/deserialization of cold data on hot paths
/// 2. Reducing the size of data moved in/out of storage
///
/// **Gas savings:** ~10-15% on fund_invoice and mark_paid operations
pub fn save_invoice(env: &Env, invoice: &Invoice) {
    let id = invoice.id;

    // Save hot-path core data
    let core_key = DataKey::InvoiceCore(id);
    let core = invoice.to_core();
    env.storage().persistent().set(&core_key, &core);
    env.storage()
        .persistent()
        .extend_ttl(&core_key, 1_000_000, 2_000_000);

    // Save cold-path metadata
    let metadata_key = DataKey::InvoiceMetadata(id);
    let metadata = invoice.to_metadata();
    env.storage().persistent().set(&metadata_key, &metadata);
    env.storage()
        .persistent()
        .extend_ttl(&metadata_key, 1_000_000, 2_000_000);
}

/// Load invoice by combining hot and cold data from storage.
///
/// This function reconstructs the full Invoice by loading:
/// - InvoiceCore: Hot-path data (always present)
/// - InvoiceMetadata: Cold-path data (always present after split)
///
/// Falls back to old Invoice key format for backwards compatibility
/// with data written before the split was implemented.
pub fn load_invoice(env: &Env, id: u64) -> Invoice {
    // Try new split format first (preferred)
    if let Some(core) = env
        .storage()
        .persistent()
        .get::<DataKey, crate::invoice::InvoiceCore>(&DataKey::InvoiceCore(id))
    {
        if let Some(metadata) = env
            .storage()
            .persistent()
            .get::<DataKey, crate::invoice::InvoiceMetadata>(&DataKey::InvoiceMetadata(id))
        {
            return core.with_metadata(metadata);
        }
    }

    // Fall back to old format for backwards compatibility
    env.storage()
        .persistent()
        .get(&DataKey::Invoice(id))
        .expect("invoice not found")
}

pub fn invoice_exists(env: &Env, id: u64) -> bool {
    // Check new split format first, then fall back to old format
    env.storage().persistent().has(&DataKey::InvoiceCore(id))
        || env.storage().persistent().has(&DataKey::Invoice(id))
}

/// Load only the hot-path core data of an invoice.
///
/// This function is optimized for hot paths (fund_invoice, mark_paid)
/// that don't need metadata. Avoids deserializing cold data.
///
/// Returns None if invoice not found, panics with "invoice core not found"
/// if the core is missing (data corruption).
pub fn load_invoice_core(env: &Env, id: u64) -> crate::invoice::InvoiceCore {
    // Try new split format first
    if let Some(core) = env
        .storage()
        .persistent()
        .get::<DataKey, crate::invoice::InvoiceCore>(&DataKey::InvoiceCore(id))
    {
        return core;
    }

    // Fall back to old format and extract core
    if let Some(invoice) = env
        .storage()
        .persistent()
        .get::<DataKey, Invoice>(&DataKey::Invoice(id))
    {
        return invoice.to_core();
    }

    panic!("invoice core not found");
}

/// Try to load only the hot-path core data of an invoice.
///
/// This function is optimized for hot paths and returns None if not found.
pub fn try_load_invoice_core(env: &Env, id: u64) -> Option<crate::invoice::InvoiceCore> {
    // Try new split format first
    if let Some(core) = env
        .storage()
        .persistent()
        .get::<DataKey, crate::invoice::InvoiceCore>(&DataKey::InvoiceCore(id))
    {
        return Some(core);
    }

    // Fall back to old format and extract core
    if let Some(invoice) = env
        .storage()
        .persistent()
        .get::<DataKey, Invoice>(&DataKey::Invoice(id))
    {
        return Some(invoice.to_core());
    }

    None
}

pub fn read_next_invoice_id(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::NextInvoiceId)
        .unwrap_or(1)
}

pub fn write_next_invoice_id(env: &Env, id: u64) {
    env.storage().instance().set(&DataKey::NextInvoiceId, &id);
}

pub fn next_invoice_id(env: &Env) -> Result<u64, crate::errors::ContractError> {
    let current_id = read_next_invoice_id(env);
    let next_id = current_id
        .checked_add(1)
        .ok_or(crate::errors::ContractError::ArithmeticOverflow)?;

    write_next_invoice_id(env, next_id);

    Ok(current_id)
}

// ----------------------------------------------------------------
// Funder List Helpers
// ----------------------------------------------------------------

pub fn get_invoice_funders(env: &Env, id: u64) -> soroban_sdk::Vec<(Address, i128)> {
    env.storage()
        .persistent()
        .get(&DataKey::InvoiceFunders(id))
        .unwrap_or_else(|| soroban_sdk::Vec::new(env))
}

pub fn save_invoice_funders(env: &Env, id: u64, funders: &soroban_sdk::Vec<(Address, i128)>) {
    env.storage()
        .persistent()
        .set(&DataKey::InvoiceFunders(id), funders);
}

// ----------------------------------------------------------------
// Reputation Helpers
// ----------------------------------------------------------------

pub fn get_lp_score(env: &Env, lp: &Address) -> u32 {
    env.storage()
        .persistent()
        .get(&DataKey::LpScore(lp.clone()))
        .unwrap_or(50)
}

pub fn set_lp_score(env: &Env, lp: &Address, score: u32) {
    let score = score.min(100);
    env.storage()
        .persistent()
        .set(&DataKey::LpScore(lp.clone()), &score);
}

// ----------------------------------------------------------------
// LP Queue Helpers
// ----------------------------------------------------------------

pub fn get_fund_queue(env: &Env, invoice_id: u64) -> soroban_sdk::Vec<LpFundRequest> {
    env.storage()
        .persistent()
        .get(&DataKey::FundQueue(invoice_id))
        .unwrap_or_else(|| soroban_sdk::Vec::new(env))
}

pub fn save_fund_queue(env: &Env, invoice_id: u64, queue: &soroban_sdk::Vec<LpFundRequest>) {
    env.storage()
        .persistent()
        .set(&DataKey::FundQueue(invoice_id), queue);
}

pub fn get_queue_resolution(env: &Env, invoice_id: u64) -> Option<Address> {
    env.storage()
        .persistent()
        .get(&DataKey::QueueResolution(invoice_id))
}

pub fn save_queue_resolution(env: &Env, invoice_id: u64, approved_lp: &Address) {
    env.storage()
        .persistent()
        .set(&DataKey::QueueResolution(invoice_id), approved_lp);
}

/// Record the ledger sequence when the first LP joined the fund queue.
/// Must only be called once per invoice (when the queue transitions from empty
/// to non-empty).  Subsequent joins do not overwrite this timestamp.
pub fn try_set_fund_queue_opened_at(env: &Env, invoice_id: u64) {
    let key = DataKey::FundQueueOpenedAt(invoice_id);
    if !env.storage().persistent().has(&key) {
        env.storage()
            .persistent()
            .set(&key, &env.ledger().sequence());
    }
}

/// Return the ledger sequence when the fund queue for `invoice_id` was first
/// opened (i.e. the first LP join), or `None` if the queue is still empty.
pub fn get_fund_queue_opened_at(env: &Env, invoice_id: u64) -> Option<u32> {
    env.storage()
        .persistent()
        .get(&DataKey::FundQueueOpenedAt(invoice_id))
}

// ----------------------------------------------------------------
// Appeal Helpers
// ----------------------------------------------------------------

pub fn get_appeal(env: &Env, invoice_id: u64) -> Option<AppealRecord> {
    env.storage().persistent().get(&DataKey::Appeal(invoice_id))
}

pub fn save_appeal(env: &Env, invoice_id: u64, record: &AppealRecord) {
    env.storage()
        .persistent()
        .set(&DataKey::Appeal(invoice_id), record);
}

pub fn save_pre_default_payer_score(env: &Env, invoice_id: u64, score: u32) {
    env.storage()
        .persistent()
        .set(&DataKey::PreDefaultPayerScore(invoice_id), &score);
}

pub fn get_pre_default_payer_score(env: &Env, invoice_id: u64) -> Option<u32> {
    env.storage()
        .persistent()
        .get(&DataKey::PreDefaultPayerScore(invoice_id))
}

// ----------------------------------------------------------------
// Contract Stats Helpers
// ----------------------------------------------------------------

/// In-memory stats accumulator for optimizing batch updates.
/// Use this struct to accumulate multiple stat changes and commit
/// them with a single storage operation for better gas efficiency.
#[derive(Clone, Debug)]
pub struct StatsAccumulator {
    pub invoices_delta: i64,
    pub funded_delta: i64,
    pub paid_delta: i64,
}

impl Default for StatsAccumulator {
    fn default() -> Self {
        Self::new()
    }
}

impl StatsAccumulator {
    pub fn new() -> Self {
        StatsAccumulator {
            invoices_delta: 0,
            funded_delta: 0,
            paid_delta: 0,
        }
    }

    pub fn add_invoice(&mut self) {
        self.invoices_delta = self.invoices_delta.saturating_add(1);
    }

    pub fn add_funded(&mut self) {
        self.funded_delta = self.funded_delta.saturating_add(1);
    }

    pub fn add_paid(&mut self) {
        self.paid_delta = self.paid_delta.saturating_add(1);
    }

    /// Commit accumulated deltas to persistent storage.
    /// This is more efficient than calling increment_* functions multiple times.
    pub fn commit(self, env: &Env) {
        if self.invoices_delta > 0 {
            let current: u64 = env
                .storage()
                .persistent()
                .get(&DataKey::TotalInvoices)
                .unwrap_or(0);
            env.storage().persistent().set(
                &DataKey::TotalInvoices,
                &current.saturating_add(self.invoices_delta as u64),
            );
        }
        if self.funded_delta > 0 {
            let current: u64 = env
                .storage()
                .persistent()
                .get(&DataKey::TotalFunded)
                .unwrap_or(0);
            env.storage().persistent().set(
                &DataKey::TotalFunded,
                &current.saturating_add(self.funded_delta as u64),
            );
        }
        if self.paid_delta > 0 {
            let current: u64 = env
                .storage()
                .persistent()
                .get(&DataKey::TotalPaid)
                .unwrap_or(0);
            env.storage().persistent().set(
                &DataKey::TotalPaid,
                &current.saturating_add(self.paid_delta as u64),
            );
        }
    }
}

pub fn increment_total_invoices(env: &Env) {
    let current: u64 = env
        .storage()
        .persistent()
        .get(&DataKey::TotalInvoices)
        .unwrap_or(0);
    env.storage()
        .persistent()
        .set(&DataKey::TotalInvoices, &current.saturating_add(1));
}

pub fn increment_total_funded(env: &Env) {
    let current: u64 = env
        .storage()
        .persistent()
        .get(&DataKey::TotalFunded)
        .unwrap_or(0);
    env.storage()
        .persistent()
        .set(&DataKey::TotalFunded, &current.saturating_add(1));
}

pub fn increment_total_paid(env: &Env) {
    let current: u64 = env
        .storage()
        .persistent()
        .get(&DataKey::TotalPaid)
        .unwrap_or(0);
    env.storage()
        .persistent()
        .set(&DataKey::TotalPaid, &current.saturating_add(1));
}

// add_volume moved to invoice.rs where the configured token addresses are available

/// Get current total invoices count.
pub fn get_total_invoices(env: &Env) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::TotalInvoices)
        .unwrap_or(0)
}

/// Get current total funded count.
pub fn get_total_funded(env: &Env) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::TotalFunded)
        .unwrap_or(0)
}

/// Get current total paid count.
pub fn get_total_paid(env: &Env) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::TotalPaid)
        .unwrap_or(0)
}

// ----------------------------------------------------------------
// Multi-sig Admin Helpers (Issue #124)
// ----------------------------------------------------------------

pub fn get_multisig_admin(env: &Env) -> Option<crate::multisig::MultisigAdmin> {
    env.storage().instance().get(&DataKey::MultisigAdmin)
}

pub fn set_multisig_admin(env: &Env, admin: &crate::multisig::MultisigAdmin) {
    env.storage().instance().set(&DataKey::MultisigAdmin, admin);
}

pub fn get_multisig_proposal(
    env: &Env,
    proposal_id: u64,
) -> Option<crate::multisig::MultisigProposal> {
    env.storage()
        .persistent()
        .get(&DataKey::MultisigProposal(proposal_id))
}

pub fn save_multisig_proposal(env: &Env, proposal: &crate::multisig::MultisigProposal) {
    env.storage()
        .persistent()
        .set(&DataKey::MultisigProposal(proposal.id), proposal);
}

/// Next proposal ID (starts at 1).
pub fn get_next_proposal_id(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::MultisigProposalCounter)
        .unwrap_or(1)
}

pub fn increment_proposal_id(env: &Env) {
    let next_id = get_next_proposal_id(env).saturating_add(1);
    env.storage()
        .instance()
        .set(&DataKey::MultisigProposalCounter, &next_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::invoice::InvoiceStatus;
    use crate::InvoiceLiquidityContract;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn test_storage_helpers_and_stats() {
        let env = Env::default();
        let contract_id = env.register(InvoiceLiquidityContract, ());

        env.as_contract(&contract_id, || {
            let user = Address::generate(&env);
            let admin = Address::generate(&env);

            // Admin
            assert_eq!(get_admin(&env), None);
            set_admin(&env, &admin);
            assert_eq!(get_admin(&env), Some(admin.clone()));

            // Config
            assert_eq!(get_config(&env), None);
            let config = Config {
                high_rep_threshold: 80,
                bonus_bps: 100,
                min_discount_rate_bps: 50,
                decay_rate_bps: 50,
                decay_period_ledgers: 1000,
                dispute_timeout_ledgers: 5000,
                xlm_sac_address: user.clone(),
                usdc_sac_address: user.clone(),
                eurc_sac_address: user.clone(),
                price_oracle: None,
                max_oracle_age_ledgers: 17280,
            };
            set_config(&env, &config);
            assert_eq!(get_config(&env), Some(config));

            // Insurance pool & pause
            assert_eq!(get_insurance_pool(&env), None);
            set_insurance_pool(&env, &admin);
            assert_eq!(get_insurance_pool(&env), Some(admin.clone()));

            assert!(!is_paused(&env));
            set_paused(&env, true);
            assert!(is_paused(&env));
            set_paused(&env, false);

            // Next invoice id
            assert_eq!(read_next_invoice_id(&env), 1);
            let id1 = next_invoice_id(&env).unwrap();
            assert_eq!(id1, 1);
            assert_eq!(read_next_invoice_id(&env), 2);

            // Invoice save / load / exists
            assert!(!invoice_exists(&env, 1));
            let inv = Invoice {
                id: 1,
                freelancer: user.clone(),
                payer: user.clone(),
                token: user.clone(),
                amount: 1000,
                due_date: 100000,
                discount_rate: 300,
                status: InvoiceStatus::Pending,
                funder: None,
                funded_at: None,
                amount_funded: 0,
                amount_paid: 0,
                referral_code: crate::invoice::ReferralCode::None,
                submitter_reputation: 50,
            };
            save_invoice(&env, &inv);
            assert!(invoice_exists(&env, 1));
            let loaded = load_invoice(&env, 1);
            assert_eq!(loaded.id, 1);
            let core = load_invoice_core(&env, 1);
            assert_eq!(core.id, 1);
            assert!(try_load_invoice_core(&env, 1).is_some());
            assert!(try_load_invoice_core(&env, 999).is_none());

            // Funders list
            let mut funders = get_invoice_funders(&env, 1);
            assert_eq!(funders.len(), 0);
            funders.push_back((user.clone(), 5000));
            save_invoice_funders(&env, 1, &funders);
            assert_eq!(get_invoice_funders(&env, 1).len(), 1);

            // LP score
            assert_eq!(get_lp_score(&env, &user), 50);
            set_lp_score(&env, &user, 90);
            assert_eq!(get_lp_score(&env, &user), 90);

            // Queue
            let queue = get_fund_queue(&env, 1);
            assert_eq!(queue.len(), 0);
            save_fund_queue(&env, 1, &queue);
            assert_eq!(get_queue_resolution(&env, 1), None);
            save_queue_resolution(&env, 1, &user);
            assert_eq!(get_queue_resolution(&env, 1), Some(user.clone()));

            // Queue opened at
            assert_eq!(get_fund_queue_opened_at(&env, 1), None);
            try_set_fund_queue_opened_at(&env, 1);
            assert!(get_fund_queue_opened_at(&env, 1).is_some());

            // Appeal & pre-default score
            assert_eq!(get_appeal(&env, 1), None);
            let appeal_rec = AppealRecord {
                evidence_hash: soroban_sdk::BytesN::from_array(&env, &[1u8; 32]),
                appealed_at: 5000,
                pre_default_score: 80,
            };
            save_appeal(&env, 1, &appeal_rec);
            assert_eq!(get_appeal(&env, 1), Some(appeal_rec));

            assert_eq!(get_pre_default_payer_score(&env, 1), None);
            save_pre_default_payer_score(&env, 1, 75);
            assert_eq!(get_pre_default_payer_score(&env, 1), Some(75));

            // Stats accumulator & incrementors
            let mut acc = StatsAccumulator::default();
            acc.add_invoice();
            acc.add_funded();
            acc.add_paid();
            acc.commit(&env);

            assert_eq!(get_total_invoices(&env), 1);
            assert_eq!(get_total_funded(&env), 1);
            assert_eq!(get_total_paid(&env), 1);

            increment_total_invoices(&env);
            increment_total_funded(&env);
            increment_total_paid(&env);

            assert_eq!(get_total_invoices(&env), 2);
            assert_eq!(get_total_funded(&env), 2);
            assert_eq!(get_total_paid(&env), 2);
        });
    }
}
