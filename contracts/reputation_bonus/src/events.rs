use soroban_sdk::{contracttype, symbol_short, Address, Env, Symbol};

use crate::invoice::{Invoice, InvoiceStatus};

/// Stable audit identifiers for governance-controlled reputation parameters.
/// Keep these strings unique and unchanged unless the audit schema changes.
pub const PARAM_HIGH_REP_THRESHOLD: &str = "high_rep_threshold";
pub const PARAM_BONUS_BPS: &str = "bonus_bps";
pub const PARAM_MIN_DISCOUNT_RATE_BPS: &str = "min_discount_rate_bps";

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ParameterUpdated {
    pub param_name: Symbol,
    pub old_value: i128,
    pub new_value: i128,
    pub updated_by: Address,
}

pub fn emit_parameter_updated(
    env: &Env,
    param_name: &str,
    old_value: i128,
    new_value: i128,
    updated_by: &Address,
) {
    let event_name = Symbol::new(env, "parameter_updated");
    let pn = Symbol::new(env, param_name);
    env.events().publish(
        (event_name, pn.clone(), updated_by.clone()),
        ParameterUpdated {
            param_name: pn,
            old_value,
            new_value,
            updated_by: updated_by.clone(),
        },
    );
}

/// Emitted once, when the contract is initialised (Issue #538).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractInitialized {
    pub admin: Address,
}

pub fn emit_initialized(env: &Env, admin: &Address) {
    env.events().publish(
        (symbol_short!("init"), admin.clone()),
        ContractInitialized {
            admin: admin.clone(),
        },
    );
}

/// Emitted when the full bonus config is replaced via `set_config` (Issue #538).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ConfigSet {
    pub high_rep_threshold: u32,
    pub bonus_bps: u32,
    pub min_discount_rate_bps: u32,
}

pub fn emit_config_set(
    env: &Env,
    high_rep_threshold: u32,
    bonus_bps: u32,
    min_discount_rate_bps: u32,
) {
    env.events().publish(
        (symbol_short!("cfg_set"),),
        ConfigSet {
            high_rep_threshold,
            bonus_bps,
            min_discount_rate_bps,
        },
    );
}

/// Emitted when a new invoice is submitted (Issue #538).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceSubmitted {
    pub invoice_id: u64,
    pub freelancer: Address,
    pub payer: Address,
    pub amount: i128,
    pub due_date: u64,
    pub effective_discount_rate_bps: u32,
}

pub fn emit_invoice_submitted(env: &Env, invoice: &Invoice) {
    env.events().publish(
        (
            symbol_short!("submitted"),
            invoice.id,
            invoice.freelancer.clone(),
            invoice.payer.clone(),
        ),
        InvoiceSubmitted {
            invoice_id: invoice.id,
            freelancer: invoice.freelancer.clone(),
            payer: invoice.payer.clone(),
            amount: invoice.amount,
            due_date: invoice.due_date,
            effective_discount_rate_bps: invoice.effective_discount_rate_bps,
        },
    );
}

/// Emitted when an invoice status transitions (paid/defaulted) (Issue #538).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceStatusChanged {
    pub invoice_id: u64,
    pub freelancer: Address,
    pub payer: Address,
    pub status: InvoiceStatus,
}

pub fn emit_invoice_status_changed(env: &Env, invoice: &Invoice) {
    let topic = match invoice.status {
        InvoiceStatus::Paid => symbol_short!("paid"),
        InvoiceStatus::Defaulted => symbol_short!("defaulted"),
        InvoiceStatus::Pending => symbol_short!("pending"),
        InvoiceStatus::Funded => symbol_short!("funded"),
    };
    env.events().publish(
        (topic, invoice.id),
        InvoiceStatusChanged {
            invoice_id: invoice.id,
            freelancer: invoice.freelancer.clone(),
            payer: invoice.payer.clone(),
            status: invoice.status.clone(),
        },
    );
}
