#![cfg(test)]

//! Issue #1161 — privileged-control regression suite.
//!
//! Each test maps to a row of `docs/authority-matrix.md`. Unauthorized calls
//! are made with `mock_auths` signing *only* as an imposter, so a call that
//! succeeds proves a missing gate rather than a test-harness artefact; the
//! `*_positive_control` tests show the same calls succeed for the real admin.

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    Address, BytesN, Env, IntoVal, Val,
};

struct Auth {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    admin: Address,
    usdc: Address,
}

fn setup() -> Auth {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let usdc = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let eurc = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let xlm = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);
    contract.initialize(&admin, &usdc, &eurc, &xlm);

    let mut ledger = env.ledger().get();
    ledger.timestamp = 1_700_000_000;
    ledger.sequence_number = 100;
    env.ledger().set(ledger);

    Auth {
        env,
        contract,
        admin,
        usdc,
    }
}

impl Auth {
    /// Authorize the next invocation of `fn_name` for `who` only.
    fn sign_as(&self, who: &Address, fn_name: &'static str, args: soroban_sdk::Vec<Val>) {
        self.env.mock_auths(&[MockAuth {
            address: who,
            invoke: &MockAuthInvoke {
                contract: &self.contract.address,
                fn_name,
                args,
                sub_invokes: &[],
            },
        }]);
    }

    fn advance_ledgers(&self, n: u64) {
        let mut ledger = self.env.ledger().get();
        ledger.sequence_number += n as u32;
        ledger.timestamp += n * 5;
        self.env.ledger().set(ledger);
    }

    fn signers(&self, n: usize) -> soroban_sdk::Vec<Address> {
        let mut v = soroban_sdk::Vec::new(&self.env);
        for _ in 0..n {
            v.push_back(Address::generate(&self.env));
        }
        v
    }
}

// ----------------------------------------------------------------
// A1: every direct-admin setter rejects a non-admin signer
// ----------------------------------------------------------------

/// Runs `$call` with only `$imposter` signing `$fn_name($args)` and asserts it
/// fails. One macro invocation per row of the authority matrix.
macro_rules! rejects_imposter {
    ($t:expr, $imposter:expr, $fn_name:literal, $args:expr, $call:expr) => {{
        $t.sign_as(&$imposter, $fn_name, $args.into_val(&$t.env));
        assert!(
            $call.is_err(),
            concat!($fn_name, " accepted a non-admin signer")
        );
    }};
}

#[test]
fn every_direct_admin_entrypoint_rejects_an_imposter() {
    let t = setup();
    let c = &t.contract;
    let x = Address::generate(&t.env);
    let a = Address::generate(&t.env);
    let hash = BytesN::from_array(&t.env, &[9u8; 32]);
    let feed = oracle_registry::OracleFeedType::Identity;

    // Admin rotation, pause, upgrade, migration
    rejects_imposter!(t, x, "set_admin", (a.clone(),), c.try_set_admin(&a));
    rejects_imposter!(t, x, "pause", (), c.try_pause());
    rejects_imposter!(t, x, "unpause", (), c.try_unpause());
    rejects_imposter!(t, x, "upgrade", (hash.clone(),), c.try_upgrade(&hash));
    rejects_imposter!(t, x, "migrate", (), c.try_migrate());
    rejects_imposter!(t, x, "rehearse_rollback", (), c.try_rehearse_rollback());
    // Economic parameters
    rejects_imposter!(
        t,
        x,
        "update_fee_rate",
        (100_u32,),
        c.try_update_fee_rate(&100)
    );
    let tiers = soroban_sdk::vec![&t.env, (0_i128, 100_u32)];
    rejects_imposter!(
        t,
        x,
        "update_fee_tiers",
        (tiers.clone(),),
        c.try_update_fee_tiers(&tiers)
    );
    rejects_imposter!(
        t,
        x,
        "update_max_discount",
        (1_000_u32,),
        c.try_update_max_discount(&1_000)
    );
    rejects_imposter!(
        t,
        x,
        "update_decay_params",
        (100_u32, 1_000_u64),
        c.try_update_decay_params(&100, &1_000)
    );
    rejects_imposter!(
        t,
        x,
        "set_min_payer_reputation",
        (10_u32,),
        c.try_set_min_payer_reputation(&10)
    );
    rejects_imposter!(
        t,
        x,
        "set_max_invoice_amount",
        (1_i128,),
        c.try_set_max_invoice_amount(&1)
    );
    rejects_imposter!(
        t,
        x,
        "set_token_volume_cap",
        (t.usdc.clone(), 1_i128),
        c.try_set_token_volume_cap(&t.usdc, &1)
    );
    // Token allowlist
    rejects_imposter!(
        t,
        x,
        "add_token",
        (a.clone(), 7_u32),
        c.try_add_token(&a, &7)
    );
    rejects_imposter!(
        t,
        x,
        "remove_token",
        (t.usdc.clone(),),
        c.try_remove_token(&t.usdc)
    );
    rejects_imposter!(
        t,
        x,
        "correct_token_decimals",
        (t.usdc.clone(), 7_u32),
        c.try_correct_token_decimals(&t.usdc, &7)
    );
    // Wiring to other contracts
    rejects_imposter!(
        t,
        x,
        "set_distribution_contract",
        (a.clone(),),
        c.try_set_distribution_contract(&a)
    );
    rejects_imposter!(
        t,
        x,
        "set_insurance_pool",
        (a.clone(),),
        c.try_set_insurance_pool(&a)
    );
    // Oracle configuration
    rejects_imposter!(
        t,
        x,
        "set_price_oracle",
        (a.clone(),),
        c.try_set_price_oracle(&a)
    );
    rejects_imposter!(
        t,
        x,
        "set_max_oracle_age",
        (10_u64,),
        c.try_set_max_oracle_age(&10)
    );
    rejects_imposter!(
        t,
        x,
        "register_oracle",
        (feed, a.clone()),
        c.try_register_oracle(&feed, &a)
    );
    rejects_imposter!(t, x, "remove_oracle", (feed,), c.try_remove_oracle(&feed));
    rejects_imposter!(
        t,
        x,
        "add_price_source",
        (feed, a.clone()),
        c.try_add_price_source(&feed, &a)
    );
    rejects_imposter!(
        t,
        x,
        "add_identity_oracle",
        (feed, a.clone()),
        c.try_add_identity_oracle(&feed, &a)
    );
    rejects_imposter!(
        t,
        x,
        "set_identity_quorum",
        (1_u32,),
        c.try_set_identity_quorum(&1)
    );
    rejects_imposter!(
        t,
        x,
        "set_max_price_deviation_bps",
        (100_u32,),
        c.try_set_max_price_deviation_bps(&100)
    );
    rejects_imposter!(
        t,
        x,
        "reset_oracle_circuit",
        (feed, t.usdc.clone()),
        c.try_reset_oracle_circuit(&feed, &t.usdc)
    );
    // Dispute / appeal resolution
    rejects_imposter!(
        t,
        x,
        "resolve_dispute",
        (1_u64, hash.clone(), 1_u32),
        c.try_resolve_dispute(&1, &hash, &1)
    );
    rejects_imposter!(
        t,
        x,
        "resolve_appeal",
        (1_u64, true),
        c.try_resolve_appeal(&1, &true)
    );
    // Multisig bootstrap
    let signers = t.signers(2);
    rejects_imposter!(
        t,
        x,
        "initialize_multisig_admin",
        (signers.clone(), 1_u32),
        c.try_initialize_multisig_admin(&signers, &1)
    );
}

#[test]
fn update_config_rejects_a_caller_who_is_not_admin() {
    let t = setup();
    let config = t.contract.get_config();
    let x = Address::generate(&t.env);
    // `update_config` takes the caller explicitly; signing as yourself is not enough.
    assert_eq!(
        t.contract.try_update_config(
            &x,
            &config.high_rep_threshold,
            &config.bonus_bps,
            &config.min_discount_rate_bps,
            &config.decay_rate_bps,
            &config.decay_period_ledgers,
            &config.dispute_timeout_ledgers,
            &config.xlm_sac_address,
            &config.usdc_sac_address,
            &config.eurc_sac_address,
        ),
        Err(Ok(ContractError::Unauthorized))
    );
}

#[test]
fn admin_setters_positive_control() {
    let t = setup();
    t.sign_as(&t.admin, "update_fee_rate", (100_u32,).into_val(&t.env));
    t.contract.update_fee_rate(&100);
    t.sign_as(&t.admin, "pause", ().into_val(&t.env));
    t.contract.pause();
    assert!(t.contract.is_paused());
}

// ----------------------------------------------------------------
// A2: admin rotation
// ----------------------------------------------------------------

#[test]
fn rotated_out_admin_loses_every_privilege() {
    let t = setup();
    let new_admin = Address::generate(&t.env);
    t.contract.set_admin(&new_admin);

    rejects_imposter!(t, t.admin, "pause", (), t.contract.try_pause());
    rejects_imposter!(
        t,
        t.admin,
        "update_fee_rate",
        (100_u32,),
        t.contract.try_update_fee_rate(&100)
    );

    t.sign_as(&new_admin, "pause", ().into_val(&t.env));
    t.contract.pause();
    assert!(t.contract.is_paused());
}

#[test]
fn admin_rotation_is_rate_limited() {
    let t = setup();
    t.contract.set_admin(&Address::generate(&t.env));
    assert_eq!(
        t.contract.try_set_admin(&Address::generate(&t.env)),
        Err(Ok(ContractError::RateLimited))
    );
    t.advance_ledgers(crate::constants::ADMIN_CHANGE_COOLDOWN_LEDGERS);
    t.contract.set_admin(&Address::generate(&t.env));
}

// ----------------------------------------------------------------
// A3: pause / unpause
// ----------------------------------------------------------------

#[test]
fn repeated_pause_and_unpause_are_idempotent() {
    let t = setup();
    t.contract.pause();
    t.contract.pause();
    assert!(t.contract.is_paused());
    t.contract.unpause();
    t.contract.unpause();
    assert!(!t.contract.is_paused());
}

// ----------------------------------------------------------------
// A4: upgrade / migrate
// ----------------------------------------------------------------

#[test]
fn failed_upgrade_leaves_contract_state_untouched() {
    let t = setup();
    let version_before = t.contract.get_storage_version();
    let unknown_wasm = BytesN::from_array(&t.env, &[0xAB; 32]);

    assert!(t.contract.try_upgrade(&unknown_wasm).is_err());

    assert_eq!(t.contract.get_storage_version(), version_before);
    assert_eq!(
        t.contract.get_version(),
        soroban_sdk::String::from_str(&t.env, crate::constants::CONTRACT_VERSION)
    );
    // The failed attempt rolled back, so it neither consumed the cooldown
    // nor wrote an audit-log entry.
    assert_eq!(t.contract.get_recent_admin_actions(&10).len(), 0);
}

#[test]
fn migrate_is_idempotent_at_the_current_version() {
    let t = setup();
    let first = t.contract.migrate();
    let second = t.contract.migrate();
    assert_eq!(first, crate::constants::CURRENT_STORAGE_VERSION);
    assert_eq!(second, first);
}

// ----------------------------------------------------------------
// A5: multisig admin path
// ----------------------------------------------------------------

#[test]
fn multisig_bootstrap_is_one_shot() {
    let t = setup();
    let signers = t.signers(3);
    t.contract.initialize_multisig_admin(&signers, &2);
    assert_eq!(
        t.contract.try_initialize_multisig_admin(&t.signers(1), &1),
        Err(Ok(ContractError::MultisigAlreadyConfigured))
    );
}

#[test]
fn non_signer_cannot_propose_sign_execute_or_touch_rotation() {
    let t = setup();
    let signers = t.signers(3);
    t.contract.initialize_multisig_admin(&signers, &2);
    let a = signers.get(0).unwrap();
    let outsider = Address::generate(&t.env);
    let not_signer = ContractError::NotAuthorizedSigner;

    assert_eq!(
        t.contract
            .try_propose_pause(&outsider)
            .unwrap_err()
            .unwrap(),
        not_signer
    );
    let id = t.contract.propose_pause(&a);
    assert_eq!(
        t.contract
            .try_sign_proposal(&outsider, &id)
            .unwrap_err()
            .unwrap(),
        not_signer
    );
    assert_eq!(
        t.contract
            .try_execute_proposal(&outsider, &id)
            .unwrap_err()
            .unwrap(),
        not_signer
    );
    assert_eq!(
        t.contract
            .try_finalize_signer_rotation(&outsider)
            .unwrap_err()
            .unwrap(),
        not_signer
    );
    assert_eq!(
        t.contract
            .try_cancel_signer_rotation(&outsider)
            .unwrap_err()
            .unwrap(),
        not_signer
    );
    assert!(!t.contract.is_paused());
}

#[test]
fn approvals_from_removed_signers_do_not_count() {
    // Finding F-03: before the fix, `a`'s approval on `pause_id` survived the
    // signer-set change, so a single current signer (`d`) could execute.
    let t = setup();
    let old = t.signers(3);
    let (a, b, c) = (
        old.get(0).unwrap(),
        old.get(1).unwrap(),
        old.get(2).unwrap(),
    );
    t.contract.initialize_multisig_admin(&old, &2);

    let pause_id = t.contract.propose_pause(&a);

    let d = Address::generate(&t.env);
    let new_set = soroban_sdk::vec![&t.env, b.clone(), c.clone(), d.clone()];
    let update_id = t.contract.propose_update_multisig(&b, &new_set, &2);
    t.contract.sign_proposal(&c, &update_id);
    t.contract.execute_proposal(&b, &update_id);

    t.contract.sign_proposal(&d, &pause_id);
    assert_eq!(
        t.contract.try_execute_proposal(&d, &pause_id),
        Err(Ok(ContractError::ThresholdNotReached))
    );
    assert!(!t.contract.is_paused());

    t.contract.sign_proposal(&b, &pause_id);
    t.contract.execute_proposal(&d, &pause_id);
    assert!(t.contract.is_paused());
}

#[test]
fn signer_rotation_respects_threshold_and_timelock() {
    let t = setup();
    let signers = t.signers(3);
    let (a, b, c) = (
        signers.get(0).unwrap(),
        signers.get(1).unwrap(),
        signers.get(2).unwrap(),
    );
    t.contract.initialize_multisig_admin(&signers, &2);
    let replacement = Address::generate(&t.env);

    let id = t.contract.propose_rotate_signer(&a, &c, &replacement);
    assert_eq!(
        t.contract.try_execute_proposal(&a, &id),
        Err(Ok(ContractError::ThresholdNotReached))
    );
    t.contract.sign_proposal(&b, &id);
    t.contract.execute_proposal(&a, &id);

    assert_eq!(
        t.contract.try_finalize_signer_rotation(&a),
        Err(Ok(ContractError::RotationTimelockNotExpired))
    );
    t.advance_ledgers(multisig::ROTATION_TIMELOCK_LEDGERS);
    t.contract.finalize_signer_rotation(&a);

    assert_eq!(
        t.contract.try_propose_pause(&c),
        Err(Ok(ContractError::NotAuthorizedSigner))
    );
    t.contract.propose_pause(&replacement);
}

#[test]
fn multisig_path_enforces_the_same_parameter_bounds_as_direct_admin() {
    let t = setup();
    let signers = t.signers(2);
    t.contract.initialize_multisig_admin(&signers, &1);
    let a = signers.get(0).unwrap();

    assert_eq!(
        t.contract
            .try_propose_set_fee_rate(&a, &(crate::constants::MAX_PROTOCOL_FEE_BPS + 1)),
        Err(Ok(ContractError::InvalidFeeRate))
    );
    assert_eq!(
        t.contract
            .try_propose_set_max_discount(&a, &(crate::constants::MAX_DISCOUNT_RATE + 1)),
        Err(Ok(ContractError::InvalidDiscountRate))
    );
    // An invalid signer config can be proposed, but never applied.
    let id = t.contract.propose_update_multisig(&a, &t.signers(1), &2);
    assert_eq!(
        t.contract.try_execute_proposal(&a, &id),
        Err(Ok(ContractError::InvalidMultisigConfig))
    );
}
