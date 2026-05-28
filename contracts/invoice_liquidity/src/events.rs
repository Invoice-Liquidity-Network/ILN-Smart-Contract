use soroban_sdk::{contractevent, Address};

use crate::invoice::InvoiceStatus;

#[contractevent(topics = ["submitted"])]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceSubmitted {
    #[topic]
    pub invoice_id: u64,
    #[topic]
    pub freelancer: Address,
    #[topic]
    pub payer: Address,
    pub token: Address,
    pub amount: i128,
    pub due_date: u64,
    pub discount_rate: u32,
    pub status: InvoiceStatus,
    /// Ledger timestamp when the invoice was submitted.  Included so indexers
    /// can reconstruct the full invoice record from events alone.
    pub timestamp: u64,
}

#[contractevent(topics = ["updated"])]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceUpdated {
    #[topic]
    pub invoice_id: u64,
    #[topic]
    pub freelancer: Address,
    #[topic]
    pub payer: Address,
    pub token: Address,
    pub amount: i128,
    pub due_date: u64,
    pub discount_rate: u32,
    pub status: InvoiceStatus,
}

#[contractevent(topics = ["funded"])]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceFunded {
    #[topic]
    pub invoice_id: u64,
    #[topic]
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
}

#[contractevent(topics = ["paid"])]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoicePaid {
    #[topic]
    pub invoice_id: u64,
    #[topic]
    pub payer: Address,
    pub funder: Address,
    pub freelancer: Address,
    pub token: Address,
    pub amount: i128,
    pub discount_amount: i128,
    pub due_date: u64,
    pub paid_on_time: bool,
    pub status: InvoiceStatus,
}

#[contractevent(topics = ["defaulted"])]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceDefaulted {
    #[topic]
    pub invoice_id: u64,
    #[topic]
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

#[contractevent(topics = ["transferred"])]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceTransferred {
    #[topic]
    pub invoice_id: u64,
    pub old_freelancer: Address,
    pub new_freelancer: Address,
    pub status: InvoiceStatus,
}

#[contractevent(topics = ["cancelled"])]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceCancelled {
    #[topic]
    pub invoice_id: u64,
    pub freelancer: Address,
    pub status: InvoiceStatus,
}

/// Emitted whenever the contract admin address is updated.
/// Provides a permanent on-chain audit trail for admin transitions.
#[contractevent(topics = ["admin_changed"])]
#[derive(Clone, Debug, PartialEq)]
pub struct AdminChanged {
    pub old_admin: Address,
    pub new_admin: Address,
    /// Ledger timestamp of the change.
    pub timestamp: u64,
}

#[contractevent(topics = ["reputation_updated"])]
#[derive(Clone, Debug, PartialEq)]
pub struct ReputationUpdated {
    #[topic]
    pub address: Address,
    pub old_score: u32,
    pub new_score: u32,
    pub invoices_submitted: u64,
    pub invoices_paid: u64,
    pub invoices_defaulted: u64,
}
