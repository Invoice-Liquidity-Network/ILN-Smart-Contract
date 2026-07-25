use soroban_sdk::{contracttype, Address, BytesN, Symbol};

use crate::invoice::{InvoiceStatus, ReferralCode};

/// Emitted when governance adds a token to the funding allowlist (Issue #19).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct TokenAdded {
    pub token: Address,
    /// Number of decimal places for this token (e.g. 6 for USDC, 7 for XLM).
    pub decimals: u32,
}

/// Emitted when governance removes a token from the funding allowlist (Issue #19).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct TokenRemoved {
    pub token: Address,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceSubmitted {
    pub invoice_id: u64,
    pub freelancer: Address,
    pub payer: Address,
    pub token: Address,
    pub amount: i128,
    pub due_date: u64,
    pub discount_rate: u32,
    pub referral_code: ReferralCode,
    pub status: InvoiceStatus,
    /// Ledger timestamp when the invoice was submitted.  Included so indexers
    /// can reconstruct the full invoice record from events alone.
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceUpdated {
    pub invoice_id: u64,
    pub freelancer: Address,
    pub payer: Address,
    pub token: Address,
    pub amount: i128,
    pub due_date: u64,
    pub discount_rate: u32,
    pub status: InvoiceStatus,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceFunded {
    pub invoice_id: u64,
    pub funder: Address,
    pub freelancer: Address,
    pub payer: Address,
    pub token: Address,
    pub fund_amount: i128,
    pub amount_funded: i128,
    pub invoice_amount: i128,
    pub due_date: u64,
    pub discount_rate: u32,
    pub funded_at: Option<u64>,
    pub status: InvoiceStatus,
    // NEW FIELDS
    pub lp: Address,
    pub effective_yield_bps: u32,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoicePaid {
    pub invoice_id: u64,
    pub payer: Address,
    pub lp: Address,
    pub freelancer: Address,
    pub token: Address,
    /// Full amount settled by payer
    pub amount_paid: i128,
    /// LP earnings = amount_paid - amount_funded
    pub lp_earned: i128,
    /// Total amount distributed to LP
    pub lp_payout: i128,
    /// Settlement ledger timestamp
    pub settlement_timestamp: u64,
    pub paid_on_time: bool,
    pub status: InvoiceStatus,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoicePartiallyPaid {
    pub invoice_id: u64,
    pub payer: Address,
    pub amount_paid_now: i128,
    pub total_amount_paid: i128,
    pub remaining_amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractPaused {
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractUnpaused {
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceDefaulted {
    pub invoice_id: u64,
    pub funder: Address,
    pub freelancer: Address,
    pub payer: Address,
    pub token: Address,
    pub amount: i128,
    pub due_date: u64,
    pub defaulted_at: u64,
    pub discount_amount: i128,
    pub status: InvoiceStatus,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceTransferred {
    pub invoice_id: u64,
    pub old_freelancer: Address,
    pub new_freelancer: Address,
    pub status: InvoiceStatus,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceCancelled {
    pub invoice_id: u64,
    pub freelancer: Address,
    pub status: InvoiceStatus,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct LPPositionTransferred {
    pub invoice_id: u64,
    pub old_lp: Address,
    pub new_lp: Address,
    pub status: InvoiceStatus,
}

/// Emitted whenever the contract admin address is updated.
/// Provides a permanent on-chain audit trail for admin transitions.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AdminChanged {
    pub old_admin: Address,
    pub new_admin: Address,
    /// Ledger timestamp of the change.
    pub timestamp: u64,
}

/// Emitted whenever a governance-controlled numeric parameter changes.
///
/// The `param_name` topic is a stable audit identifier. Keep these strings
/// unique per parameter so off-chain indexers can reconstruct config history.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ParameterUpdated {
    pub param_name: Symbol,
    pub old_value: i128,
    pub new_value: i128,
    pub updated_by: Address,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractUpgraded {
    pub admin: Address,
    pub new_wasm_hash: BytesN<32>,
    pub timestamp: u64,
}

// ── Issue #36: appeal_default events ──────────────────────────────────────────

/// Emitted when a payer files an appeal against an unfair default marking.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct DefaultAppealed {
    pub invoice_id: u64,
    pub payer: Address,
    /// SHA-256 hash of off-chain evidence provided by the payer.
    pub evidence_hash: BytesN<32>,
    pub appealed_at: u64,
}

/// Emitted when governance resolves a payer's appeal.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AppealResolved {
    pub invoice_id: u64,
    pub payer: Address,
    /// true = appeal upheld (default reversed); false = appeal rejected.
    pub upheld: bool,
    pub resolved_at: u64,
}

// ── Dispute events ──────────────────────────────────────────────────────────

/// Emitted when a payer disputes an invoice before settlement.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceDisputed {
    pub invoice_id: u64,
    pub payer: Address,
    /// SHA-256 hash of off-chain dispute evidence.
    pub reason_hash: BytesN<32>,
    pub disputed_at: u64,
}

/// Emitted when governance resolves a dispute.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct DisputeResolved {
    pub invoice_id: u64,
    pub resolution_hash: BytesN<32>, // Optional hash of resolution details
    pub resolution: u32, // Ruling: 1 = Upheld (Payer right), 2 = Rejected (Freelancer right)
    pub resolved_at: u64,
}

// ── Issue #34: LP priority queue events ───────────────────────────────────────

/// Emitted when an LP registers their intent to fund via the priority queue.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FundRequested {
    pub invoice_id: u64,
    pub lp: Address,
    /// LP's reputation score at the time of registration.
    pub score: u32,
}

/// Emitted when the priority queue is resolved and a winning LP is selected.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FundQueueResolved {
    pub invoice_id: u64,
    pub approved_lp: Address,
    /// Winning score that secured priority.
    pub score: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceExpired {
    pub invoice_id: u64,
    pub freelancer: Address,
    pub status: InvoiceStatus,
}

/// Emitted when an address's reputation score or counters are updated (Issue #32).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ReputationUpdated {
    pub address: Address,
    pub old_score: u32,
    pub new_score: u32,
    pub invoices_submitted: u32,
    pub invoices_paid: u32,
    pub invoices_defaulted: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceTokenChanged {
    pub invoice_id: u64,
    pub old_token: Address,
    pub new_token: Address,
}

// ── Invoice NFT lifecycle events (nft.rs) ─────────────────────────────────────

/// Emitted when an invoice NFT is minted (invoice submitted).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceNftMinted {
    pub invoice_id: u64,
    pub owner: Address,
    pub amount: i128,
    pub due_date: u32,
    pub timestamp: u64,
}

/// Emitted when an invoice NFT is transferred (e.g. freelancer → LP on funding).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceNftTransferred {
    pub invoice_id: u64,
    pub from: Address,
    pub to: Address,
    pub timestamp: u64,
}

/// Emitted when an invoice NFT is burned (invoice marked paid).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceNftBurned {
    pub invoice_id: u64,
    pub owner: Address,
    pub timestamp: u64,
}
