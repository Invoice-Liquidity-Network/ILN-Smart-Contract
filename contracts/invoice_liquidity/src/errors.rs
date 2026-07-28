use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum ContractError {
    InvoiceNotFound = 1,
    AlreadyFunded = 2,
    AlreadyPaid = 3,
    NotFunded = 4,
    Unauthorized = 5,
    InvalidAmount = 6,
    InvalidDiscountRate = 7,
    InvalidDueDate = 8,
    InvoiceDefaulted = 9,
    NothingToClaim = 10,
    NotYetDefaulted = 11,
    OverfundingRejected = 12,
    InvoiceExpired = 13,
    BatchTooLarge = 14,
    AlreadyCancelled = 15,
    AlreadyInitialized = 16,
    // ── Issue #36: appeal_default ──────────────────────────────────
    /// Payer attempted to appeal an invoice that is already in Appealed state.
    AlreadyAppealed = 17,
    /// Appeal window has closed; appeal can no longer be submitted.
    AppealWindowClosed = 18,
    /// Action requires the invoice to be in Defaulted state.
    NotDefaulted = 19,
    // ── Issue #34: LP priority queue ──────────────────────────────
    /// LP has already joined the fund queue for this invoice.
    AlreadyInQueue = 20,
    /// fund_invoice rejected because a different LP was selected by the priority queue.
    NotApprovedFunder = 21,
    /// Invoice is in Appealed state and cannot be acted upon yet.
    InvoiceAppealed = 22,
    AlreadyDisputed = 23,
    NotDisputed = 24,
    InvoiceDisputed = 25,
    ContractPaused = 26,
    DueDateTooSoon = 27,
    DueDateTooFar = 28,
    SelfInvoice = 29,
    OverpaymentRejected = 30,
    /// Issue #28: payer's reputation is below the configured minimum threshold.
    PayerReputationTooLow = 31,
    ArithmeticOverflow = 32,
    /// Token charges a fee during `transfer`, causing the received amount to differ
    /// from the amount sent and breaking ILN accounting.
    FeeOnTransferToken = 33,
    /// Issue #92: oracle returned unverified for the invoice payer when
    /// require_oracle_verification was set to true.
    PayerUnverified = 34,
    /// Issue #93: oracle data is older than max_oracle_age_ledgers and must
    /// be rejected to prevent stale-data attacks.
    OracleDataStale = 35,
    /// Invoice amount is below the configurable minimum threshold.
    AmountTooSmall = 36,
    /// Reentrant call detected — the function was called while already executing (Issue #535).
    Reentrancy = 37,
    /// Rate-limited function called before the cooldown period elapsed (Issue #541).
    RateLimited = 38,
    /// Issue #604: bonus_bps exceeds the configured maximum.
    InvalidBonusBps = 39,
    /// Issue #604: min_discount_rate_bps is 0.
    InvalidMinDiscountRate = 40,
    /// Issue #604: decay_rate_bps is 0 or exceeds the configured maximum.
    InvalidDecayRateBps = 41,
    /// Issue #604: decay_period_ledgers is below the configured minimum.
    InvalidDecayPeriodLedgers = 42,
    /// Issue #604: dispute_timeout_ledgers is below the configured minimum.
    InvalidDisputeTimeoutLedgers = 43,
    /// Issue #604: high_rep_threshold is 0.
    InvalidHighRepThreshold = 44,
}

impl From<crate::config::ConfigError> for ContractError {
    fn from(err: crate::config::ConfigError) -> Self {
        match err {
            crate::config::ConfigError::Unauthorized => ContractError::Unauthorized,
            crate::config::ConfigError::InvalidBonusBps => ContractError::InvalidBonusBps,
            crate::config::ConfigError::InvalidMinDiscountRate => {
                ContractError::InvalidMinDiscountRate
            }
            crate::config::ConfigError::InvalidDecayRateBps => ContractError::InvalidDecayRateBps,
            crate::config::ConfigError::InvalidDecayPeriodLedgers => {
                ContractError::InvalidDecayPeriodLedgers
            }
            crate::config::ConfigError::InvalidDisputeTimeoutLedgers => {
                ContractError::InvalidDisputeTimeoutLedgers
            }
            crate::config::ConfigError::InvalidHighRepThreshold => {
                ContractError::InvalidHighRepThreshold
            }
        }
    }
}
