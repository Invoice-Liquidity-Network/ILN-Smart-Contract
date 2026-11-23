#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum RateError {
    ArithmeticUnderflow,
    ArithmeticOverflow,
}

/// Effective discount rate (bps) for an invoice.
///
/// * `reputation_score >= high_rep_threshold`: `max(base - bonus, min)`, where
///   `base - bonus` saturates at 0 (never underflows).
/// * otherwise: `max(base, min)`.
///
/// All arithmetic is `u32` saturating subtraction and `max`; nothing here can
/// overflow or panic for any input, so the function currently always returns
/// `Ok`. `RateError` is kept for API compatibility with callers that map it.
///
/// Properties relied on (and tested in `tests/numeric_boundaries.rs`):
/// * the result is never below `min_discount_rate_bps`;
/// * the result never exceeds `max(base, min)`;
/// * the comparison is inclusive: a score equal to the threshold earns the bonus;
/// * `base` is not range-checked here, so a `min` above `base` raises the rate.
pub fn calculate_effective_rate(
    base_rate_bps: u32,
    reputation_score: u32,
    high_rep_threshold: u32,
    bonus_bps: u32,
    min_discount_rate_bps: u32,
) -> Result<u32, RateError> {
    if reputation_score >= high_rep_threshold {
        let reduced_rate = base_rate_bps.saturating_sub(bonus_bps);
        let effective_rate = core::cmp::max(reduced_rate, min_discount_rate_bps);
        Ok(effective_rate)
    } else {
        let effective_rate = core::cmp::max(base_rate_bps, min_discount_rate_bps);
        Ok(effective_rate)
    }
}
