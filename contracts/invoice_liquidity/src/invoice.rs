use soroban_sdk::{contracttype, Address, Env};

// ----------------------------------------------------------------
// Status enum — tracks lifecycle of invoice
// ----------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum InvoiceStatus {
    Pending,         // submitted, waiting for a liquidity provider to fund it
    Funded,          // LP has funded it, freelancer has been paid out
    PartiallyFunded, // partially funded by one or more LPs
    Paid,            // payer has settled in full, LP has been released
    Defaulted,       // past due_date and still unpaid
    Expired,         // past due_date with no funding
    Cancelled,       // freelancer cancelled the invoice before funding
}

// ----------------------------------------------------------------
// Invoice struct (UPDATED - token stays per invoice)
// ----------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug)]
pub struct Invoice {
    pub id: u64,
    pub freelancer: Address, // who submitted the invoice (receives liquidity)
    pub payer: Address,      // the client who owes the money
    pub token: Address,      // token used for this invoice lifecycle
    pub amount: i128,        // full invoice value in stroops (1 USDC = 10_000_000)
    pub due_date: u64,       // Unix timestamp — when the payer must settle by
    pub discount_rate: u32,  // basis points, e.g. 300 = 3.00%
    pub status: InvoiceStatus,
    pub funder: Option<Address>, // set when an LP funds the invoice (legacy for full funding)
    pub funded_at: Option<u64>,  // ledger timestamp when funding occurred
    pub amount_funded: i128,     // cumulative amount funded so far
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct InvoiceParams {
    pub freelancer: Address,
    pub payer: Address,
    pub amount: i128,
    pub due_date: u64,
    pub discount_rate: u32,
    pub token: Address,
}

#[contracttype]
#[derive(Clone, Debug, Default)]
pub struct PayerStats {
    pub invoices_submitted: u64,
    pub invoices_paid: u64,
    pub invoices_defaulted: u64,
    pub total_volume: i128,
}

// ----------------------------------------------------------------
// Storage key (UPDATED for multi-token registry)
// ----------------------------------------------------------------

#[contracttype]
pub enum StorageKey {
    Invoice(u64),        // Invoice by ID
    InvoiceCount,        // auto-increment counter for IDs
    Token,               // USDC token address
    PayerScore(Address), // Reputation score for a payer
    PayerStats(Address), // Reputation counters for a payer
    InvoiceFunders(u64), // List of funders for a partially funded invoice
    ApprovedToken(Address),
    TokenList,
    Admin,
    FeeRate,
    MaxDiscountRate,
    DistributionContract,
}

// ----------------------------------------------------------------
// Storage helpers (UNCHANGED CORE LOGIC)
// ----------------------------------------------------------------

pub fn save_invoice(env: &Env, invoice: &Invoice) {
    let key = StorageKey::Invoice(invoice.id);
    env.storage().persistent().set(&key, invoice);
    env.storage()
        .persistent()
        .extend_ttl(&key, 1_000_000, 2_000_000);
}

pub fn load_invoice(env: &Env, id: u64) -> Invoice {
    env.storage()
        .persistent()
        .get(&StorageKey::Invoice(id))
        .expect("invoice not found")
}

pub fn invoice_exists(env: &Env, id: u64) -> bool {
    env.storage().persistent().has(&StorageKey::Invoice(id))
}

pub fn next_invoice_id(env: &Env) -> u64 {
    let current: u64 = env
        .storage()
        .persistent()
        .get(&StorageKey::InvoiceCount)
        .unwrap_or(0);

    let next = current + 1;

    env.storage()
        .persistent()
        .set(&StorageKey::InvoiceCount, &next);

    next
}

/// Get a payer's reputation score (0-100, default 50)
pub fn get_payer_score(env: &Env, payer: &Address) -> u32 {
    env.storage()
        .persistent()
        .get(&StorageKey::PayerScore(payer.clone()))
        .unwrap_or(50)
}

/// Update a payer's reputation score
pub fn set_payer_score(env: &Env, payer: &Address, score: u32) {
    let mut score = score;
    if score > 100 {
        score = 100;
    }
    env.storage()
        .persistent()
        .set(&StorageKey::PayerScore(payer.clone()), &score);
}

pub fn get_payer_stats(env: &Env, payer: &Address) -> PayerStats {
    env.storage()
        .persistent()
        .get(&StorageKey::PayerStats(payer.clone()))
        .unwrap_or_default()
}

pub fn set_payer_stats(env: &Env, payer: &Address, stats: &PayerStats) {
    env.storage()
        .persistent()
        .set(&StorageKey::PayerStats(payer.clone()), stats);
}

/// Get the list of funders and their contributions for an invoice
pub fn get_invoice_funders(env: &Env, id: u64) -> soroban_sdk::Vec<(Address, i128)> {
    env.storage()
        .persistent()
        .get(&StorageKey::InvoiceFunders(id))
        .unwrap_or(soroban_sdk::Vec::new(env))
}

/// Save the list of funders for an invoice
pub fn save_invoice_funders(env: &Env, id: u64, funders: &soroban_sdk::Vec<(Address, i128)>) {
    env.storage()
        .persistent()
        .set(&StorageKey::InvoiceFunders(id), funders);
}
