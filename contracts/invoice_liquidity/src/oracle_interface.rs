//! Off-chain payer-verification oracle interface.
//!
//! Issue #91 — defines the cross-contract trait and helpers the ILN contract
//! uses to query payer verification status from a trusted oracle contract.
//!
//! The oracle is optional. When no oracle address is registered in
//! `Config.price_oracle`, all payer-verification checks pass (fail-open).

use soroban_sdk::{contractclient, contracttype, Address, Env};

/// Verification record returned by the oracle.
#[contracttype]
#[derive(Clone, Debug)]
pub struct VerificationResult {
    /// Whether the payer's off-chain identity/creditworthiness is verified.
    pub verified: bool,
    /// Unix epoch seconds when the oracle last updated this entry.
    pub timestamp: u64,
}

/// Cross-contract client trait for a payer-verification oracle.
///
/// Any contract registered as the ILN payer oracle must expose these two
/// entry-points with exactly these signatures.
#[contractclient(name = "OracleClient")]
pub trait OracleInterface {
    /// Returns the verification record for `payer`.
    fn get_verification(env: Env, payer: Address) -> VerificationResult;

    /// Update the verification status for `payer`.
    ///
    /// Access control is enforced inside the oracle contract; the ILN
    /// contract never calls this method directly.
    fn update_verification(env: Env, payer: Address, verified: bool);
}

/// Default staleness threshold: 7 days in seconds.
pub const ORACLE_STALENESS_THRESHOLD_SECS: u64 = 7 * 24 * 60 * 60;

/// Query the payer oracle (if one is configured) and return whether `payer`
/// is verified with fresh data.
///
/// Semantics:
/// - Returns `true` (permissive) if no oracle address is in `Config.price_oracle`.
/// - Returns `false` if the oracle reports the payer as unverified.
/// - Returns `false` if the oracle's timestamp is older than
///   `ORACLE_STALENESS_THRESHOLD_SECS`.
/// - Returns `true` when verified and the data is fresh.
pub fn check_payer_verified(env: &Env, payer: &Address) -> bool {
    let config = match crate::storage::get_config(env) {
        Some(c) => c,
        None => return true,
    };
    let oracle_addr = match config.price_oracle {
        Some(a) => a,
        None => return true,
    };
    let client = OracleClient::new(env, &oracle_addr);
    let result = client.get_verification(payer);
    env.ledger().timestamp().saturating_sub(result.timestamp) <= ORACLE_STALENESS_THRESHOLD_SECS
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{contract, contractimpl, testutils::Address as _};

    #[contract]
    pub struct MockVerificationOracle;

    #[contractimpl]
    impl MockVerificationOracle {
        pub fn get_verification(_env: Env, _payer: Address) -> VerificationResult {
            VerificationResult {
                verified: true,
                timestamp: 1_700_000_000,
            }
        }
        pub fn update_verification(_env: Env, _payer: Address, _verified: bool) {}
    }

    #[test]
    fn test_check_payer_verified_paths() {
        let env = Env::default();
        let contract_id = env.register(crate::InvoiceLiquidityContract, ());

        env.as_contract(&contract_id, || {
            let payer = Address::generate(&env);

            // No config
            assert!(check_payer_verified(&env, &payer));

            // Config without oracle
            let xlm = Address::generate(&env);
            let usdc = Address::generate(&env);
            let eurc = Address::generate(&env);
            let mut config = crate::config::Config {
                high_rep_threshold: 80,
                bonus_bps: 100,
                min_discount_rate_bps: 50,
                decay_rate_bps: 50,
                decay_period_ledgers: 1000,
                dispute_timeout_ledgers: 5000,
                xlm_sac_address: xlm,
                usdc_sac_address: usdc,
                eurc_sac_address: eurc,
                price_oracle: None,
                max_oracle_age_ledgers: 17280,
            };
            crate::storage::set_config(&env, &config);
            assert!(check_payer_verified(&env, &payer));

            // With mock oracle
            let oracle_id = env.register(MockVerificationOracle, ());
            config.price_oracle = Some(oracle_id);
            crate::storage::set_config(&env, &config);
            assert!(check_payer_verified(&env, &payer));
        });
    }
}
