#![cfg(test)]

//! Tests for Issue #532 — governance-controlled oracle registry.
//!
//! Covers:
//! 1. Registry resolution priority: per-token override > feed-type default > legacy price_oracle.
//! 2. register_oracle / remove_oracle / register_token_oracle / remove_token_oracle CRUD.
//! 3. fund_invoice queries the registry-resolved oracle, not just the legacy field.
//! 4. Oracle health recording (staleness) after a query.

use super::*;
use crate::oracle_registry::OracleFeedType;
use crate::test::setup;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    Address, Env, IntoVal,
};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30;

/// Same shape as tests_oracle_freshness.rs's MockTimestampedOracle: returns
/// a stored `is_verified` + `timestamp` pair configurable per test.
#[contract]
struct MockRegistryOracle;

#[contractimpl]
impl MockRegistryOracle {
    pub fn interface_version(_env: Env) -> u32 {
        crate::oracle_interface::ORACLE_INTERFACE_VERSION
    }

    pub fn set_response(env: Env, verified: bool, ts: u32) {
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("verified"), &verified);
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("ts"), &ts);
    }

    pub fn get_payer_data(env: Env, _payer: Address) -> OracleVerificationResponse {
        let is_verified: bool = env
            .storage()
            .instance()
            .get(&soroban_sdk::symbol_short!("verified"))
            .unwrap_or(true);
        let ts: u32 = env
            .storage()
            .instance()
            .get(&soroban_sdk::symbol_short!("ts"))
            .unwrap_or(env.ledger().sequence());
        OracleVerificationResponse {
            is_verified,
            timestamp: ts,
        }
    }
}

/// `set_price_oracle` / `set_max_oracle_age` are rate-limited
/// (`check_rate_limit`, cooldown = `DEFAULT_RATE_LIMIT_LEDGERS` = 120
/// ledgers). Since the last-call ledger defaults to 0 when never called,
/// and `setup()` starts the ledger at sequence 100, calling either of these
/// immediately after `setup()` incorrectly trips the cooldown on its very
/// first-ever call. Advance the ledger past the cooldown first — this is a
/// pre-existing rate-limiting quirk unrelated to Issue #532, worked around
/// here rather than fixed since fixing `check_rate_limit` is out of scope.
fn advance_past_rate_limit_cooldown(env: &Env) {
    let mut info = env.ledger().get();
    info.sequence_number += 150;
    info.timestamp += 150 * 5;
    env.ledger().set(info);
}

/// register_oracle/remove_oracle/register_token_oracle/remove_token_oracle
/// are now cooldown-gated per resolution channel
/// (`DEFAULT_ORACLE_REGISTRY_COOLDOWN_LEDGERS` = 720 ledgers — see Issue
/// #oracle-registry-cooldown). A test that mutates the *same* channel
/// (same feed type for register_oracle/remove_oracle; same feed type +
/// token for register_token_oracle/remove_token_oracle) more than once
/// must advance the ledger past this cooldown in between, or the second
/// mutation is rejected with `OracleRegistryCooldownActive`. 800 ledgers
/// clears the 720-ledger default with margin.
fn advance_past_oracle_registry_cooldown(env: &Env) {
    let mut info = env.ledger().get();
    info.sequence_number += 800;
    info.timestamp += 800 * 5;
    env.ledger().set(info);
}

/// Same shape as tests_access_control.rs's setup_env(): an env WITHOUT
/// mock_all_auths(), so require_auth() actually enforces the caller.
fn setup_env_no_mock_auths() -> (
    Env,
    Address,
    Address,
    InvoiceLiquidityContractClient<'static>,
) {
    let env = Env::default();
    let admin = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let usdc_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_address = usdc_contract.address();

    let xlm_admin = Address::generate(&env);
    let xlm_contract = env.register_stellar_asset_contract_v2(xlm_admin.clone());
    let xlm_address = xlm_contract.address();

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let client = InvoiceLiquidityContractClient::new(&env, &contract_id);

    env.mock_all_auths();
    client.initialize(&admin, &token_address, &token_address, &xlm_address);

    let mut ledger = env.ledger().get();
    ledger.timestamp = 1_700_000_000;
    env.ledger().set(ledger);

    (env, admin, token_address, client)
}

fn deploy_mock_oracle(t: &crate::test::TestEnv, verified: bool, ts: u32) -> Address {
    let id = t.env.register_contract(None, MockRegistryOracle);
    let client = MockRegistryOracleClient::new(&t.env, &id);
    client.set_response(&verified, &ts);
    id
}

fn make_invoice(t: &crate::test::TestEnv) -> u64 {
    let now = t.env.ledger().timestamp();
    t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &(now + DUE_DATE_OFFSET),
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    )
}

// ── Registry CRUD ────────────────────────────────────────────────────────────

#[test]
fn test_no_oracle_registered_resolves_to_none() {
    let t = setup();
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        None
    );
}

#[test]
fn test_register_oracle_sets_feed_type_default() {
    let t = setup();
    let oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(oracle)
    );
}

#[test]
fn test_remove_oracle_clears_feed_type_default() {
    let t = setup();
    let oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);
    advance_past_oracle_registry_cooldown(&t.env);
    t.contract.remove_oracle(&OracleFeedType::Identity);

    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        None
    );
}

#[test]
fn test_per_token_override_takes_priority_over_feed_type_default() {
    let t = setup();
    let default_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    let token_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());

    t.contract
        .register_oracle(&OracleFeedType::Identity, &default_oracle);
    t.contract
        .register_token_oracle(&OracleFeedType::Identity, &t.token.address, &token_oracle);

    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(token_oracle)
    );
}

#[test]
fn test_remove_token_oracle_falls_back_to_feed_type_default() {
    let t = setup();
    let default_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    let token_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());

    t.contract
        .register_oracle(&OracleFeedType::Identity, &default_oracle);
    t.contract
        .register_token_oracle(&OracleFeedType::Identity, &t.token.address, &token_oracle);
    advance_past_oracle_registry_cooldown(&t.env);
    t.contract
        .remove_token_oracle(&OracleFeedType::Identity, &t.token.address);

    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(default_oracle)
    );
}

#[test]
fn test_legacy_price_oracle_used_as_fallback_for_identity_feed() {
    let t = setup();
    advance_past_rate_limit_cooldown(&t.env);
    let legacy_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract.set_price_oracle(&legacy_oracle);

    // No registry entries at all — resolution falls through to the legacy field.
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(legacy_oracle)
    );
}

// ── Legacy oracle fallback: visibility + disable flag (Issue
// #legacy-oracle-fallback) ─────────────────────────────────────────────────
//
// Falling back to the legacy Config.price_oracle field is convenient for
// migration, but silently masks the fact that the new registry was never
// properly configured for a given token/feed — an operator relying on
// oracle_registry monitoring could easily miss it. These tests cover the
// LegacyOracleFallbackUsed event and the governance-settable flag that lets
// the fallback be disabled entirely once migration is confirmed complete.

#[test]
fn test_legacy_fallback_emits_event() {
    let t = setup();
    advance_past_rate_limit_cooldown(&t.env);
    let legacy_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract.set_price_oracle(&legacy_oracle);

    let resolved = t
        .contract
        .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address);
    assert_eq!(resolved, Some(legacy_oracle));

    let events = t.env.events().all();
    let saw_fallback_event = events.events().iter().any(|e| {
        let s = std::format!("{:?}", e);
        s.contains("legacy_oracle_fallback_used") || s.contains("LegacyOracleFallbackUsed")
    });
    assert!(
        saw_fallback_event,
        "resolving through the legacy price_oracle field must emit LegacyOracleFallbackUsed \
         so it's visible in monitoring/indexer data, not silently invisible"
    );
}

#[test]
fn test_registry_default_does_not_emit_legacy_fallback_event() {
    // Precision check: the event must fire only when the fallback path is
    // actually taken, not on every oracle resolution regardless of source.
    let t = setup();
    let oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    let resolved = t
        .contract
        .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address);
    assert_eq!(resolved, Some(oracle));

    let events = t.env.events().all();
    let saw_fallback_event = events.events().iter().any(|e| {
        let s = std::format!("{:?}", e);
        s.contains("legacy_oracle_fallback_used") || s.contains("LegacyOracleFallbackUsed")
    });
    assert!(
        !saw_fallback_event,
        "resolving through an explicitly registered oracle must not emit \
         LegacyOracleFallbackUsed — that event is specifically for the legacy path"
    );
}

#[test]
fn test_legacy_fallback_enabled_by_default() {
    let t = setup();
    assert!(t.contract.is_legacy_oracle_fallback_enabled());
}

#[test]
fn test_disabling_legacy_fallback_forces_none_when_unconfigured() {
    let t = setup();
    advance_past_rate_limit_cooldown(&t.env);
    let legacy_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract.set_price_oracle(&legacy_oracle);
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(legacy_oracle),
        "sanity check: the fallback resolves normally before being disabled"
    );

    t.contract.set_legacy_oracle_fallback_enabled(&false);
    assert!(!t.contract.is_legacy_oracle_fallback_enabled());

    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        None,
        "with the fallback disabled and no explicit registry entry, resolution must \
         return None (forcing explicit configuration) rather than silently falling \
         back to Config.price_oracle"
    );
}

#[test]
fn test_disabling_legacy_fallback_does_not_affect_explicit_registry_entries() {
    let t = setup();
    advance_past_rate_limit_cooldown(&t.env);
    let legacy_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract.set_price_oracle(&legacy_oracle);

    let registry_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract
        .register_oracle(&OracleFeedType::Identity, &registry_oracle);

    t.contract.set_legacy_oracle_fallback_enabled(&false);

    // Resolution never reaches the legacy-fallback step at all here — an
    // explicit feed-type default is registered — so disabling the fallback
    // must have no effect on this outcome.
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(registry_oracle)
    );
}

#[test]
fn test_legacy_fallback_can_be_re_enabled() {
    let t = setup();
    advance_past_rate_limit_cooldown(&t.env);
    let legacy_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract.set_price_oracle(&legacy_oracle);

    t.contract.set_legacy_oracle_fallback_enabled(&false);
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        None
    );

    // Not a one-way switch: governance can restore the previous behavior.
    t.contract.set_legacy_oracle_fallback_enabled(&true);
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(legacy_oracle)
    );
}

#[test]
fn test_fund_invoice_oracle_verification_is_no_op_when_legacy_fallback_disabled_and_unconfigured() {
    // With the fallback disabled and no explicit registry entry, an invoice
    // requesting oracle verification must degrade to the same fail-open
    // behavior as "no oracle configured at all" — not silently fall back,
    // and not reject funding just because there's nothing left to consult.
    let t = setup();
    advance_past_rate_limit_cooldown(&t.env);
    let legacy_oracle = deploy_mock_oracle(&t, false, t.env.ledger().sequence()); // unverified
    t.contract.set_price_oracle(&legacy_oracle);
    t.contract.set_legacy_oracle_fallback_enabled(&false);

    let invoice_id = make_invoice(&t);
    let result =
        t.contract
            .try_fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true);
    assert!(
        result.is_ok(),
        "with the legacy fallback disabled and no registry entry, oracle verification \
         must be a no-op (fail-open) rather than resolving to the disabled legacy \
         oracle or rejecting funding outright"
    );
}

#[test]
fn test_set_legacy_oracle_fallback_enabled_requires_admin() {
    let (env, _admin, _, client) = setup_env_no_mock_auths();
    let imposter = Address::generate(&env);

    env.mock_auths(&[MockAuth {
        address: &imposter,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "set_legacy_oracle_fallback_enabled",
            args: (false,).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let res = client.try_set_legacy_oracle_fallback_enabled(&false);
    assert!(
        res.is_err(),
        "set_legacy_oracle_fallback_enabled should fail for non-admin caller"
    );
}

#[test]
fn test_registry_default_takes_priority_over_legacy_price_oracle() {
    let t = setup();
    advance_past_rate_limit_cooldown(&t.env);
    let legacy_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    let registry_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());

    t.contract.set_price_oracle(&legacy_oracle);
    t.contract
        .register_oracle(&OracleFeedType::Identity, &registry_oracle);

    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(registry_oracle)
    );
}

#[test]
fn test_price_feed_type_has_no_legacy_fallback() {
    let t = setup();
    advance_past_rate_limit_cooldown(&t.env);
    let legacy_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract.set_price_oracle(&legacy_oracle);

    // The legacy field is Identity-only; the Price feed type has nothing to
    // fall back to since it didn't exist pre-#532.
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Price, &t.token.address),
        None
    );
}

// ── fund_invoice integration ─────────────────────────────────────────────────

#[test]
fn test_fund_invoice_uses_registry_resolved_oracle() {
    let t = setup();
    let oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract
        .register_token_oracle(&OracleFeedType::Identity, &t.token.address, &oracle);

    let invoice_id = make_invoice(&t);
    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true);

    let invoice = t.contract.get_invoice(&invoice_id);
    assert_eq!(invoice.status, InvoiceStatus::Funded);
}

#[test]
fn test_fund_invoice_rejects_unverified_payer_from_registry_oracle() {
    let t = setup();
    let oracle = deploy_mock_oracle(&t, false, t.env.ledger().sequence());
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    let invoice_id = make_invoice(&t);
    let res = t
        .contract
        .try_fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true);
    assert_eq!(res, Err(Ok(ContractError::PayerUnverified)));
}

// ── Oracle health monitoring ──────────────────────────────────────────────────

#[test]
fn test_oracle_health_unrecorded_before_first_query() {
    let t = setup();
    assert_eq!(
        t.contract
            .get_oracle_health(&OracleFeedType::Identity, &t.token.address),
        None
    );
}

#[test]
fn test_oracle_health_recorded_as_fresh_after_successful_query() {
    let t = setup();
    let current_seq = t.env.ledger().sequence();
    let oracle = deploy_mock_oracle(&t, true, current_seq);
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    let invoice_id = make_invoice(&t);
    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true);

    let health = t
        .contract
        .get_oracle_health(&OracleFeedType::Identity, &t.token.address)
        .unwrap();
    assert_eq!(health.oracle, oracle);
    assert!(!health.is_stale);
    assert_eq!(health.consecutive_stale_count, 0);
}

// Note: fund_invoice's health write for a REJECTED (stale/unverified) call
// does not persist — Soroban rolls back all storage writes made during an
// invocation that returns Err, health snapshot included. That's why the
// tests below use check_oracle_health (which never errors) to observe
// staleness, rather than asserting on state left behind by a failed
// fund_invoice call.

#[test]
fn test_check_oracle_health_detects_stale_data_without_erroring() {
    let t = setup();
    // Lower max_oracle_age so a small, TTL-safe ledger jump is enough to
    // trigger staleness (a 20_000-ledger jump would archive unrelated
    // storage entries in the test sandbox).
    advance_past_rate_limit_cooldown(&t.env);
    t.contract.set_max_oracle_age(&10);

    let old_seq = t.env.ledger().sequence();
    let oracle = deploy_mock_oracle(&t, true, old_seq);
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    let mut info = t.env.ledger().get();
    info.sequence_number += 20;
    info.timestamp += 20 * 5;
    t.env.ledger().set(info);

    let health = t
        .contract
        .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer)
        .unwrap();
    assert!(health.is_stale);
    assert_eq!(health.consecutive_stale_count, 1);

    // Confirm it's durable — a fresh read sees the same recorded snapshot.
    let reread = t
        .contract
        .get_oracle_health(&OracleFeedType::Identity, &t.token.address)
        .unwrap();
    assert_eq!(reread, health);
}

#[test]
fn test_check_oracle_health_consecutive_stale_count_increments() {
    let t = setup();
    advance_past_rate_limit_cooldown(&t.env);
    t.contract.set_max_oracle_age(&10);

    let old_seq = t.env.ledger().sequence();
    let oracle = deploy_mock_oracle(&t, true, old_seq);
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    let mut info = t.env.ledger().get();
    info.sequence_number += 20;
    info.timestamp += 20 * 5;
    t.env.ledger().set(info);

    let first = t
        .contract
        .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer)
        .unwrap();
    assert_eq!(first.consecutive_stale_count, 1);

    let second = t
        .contract
        .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer)
        .unwrap();
    assert_eq!(second.consecutive_stale_count, 2);
}

#[test]
fn test_check_oracle_health_resets_count_after_fresh_query() {
    let t = setup();
    advance_past_rate_limit_cooldown(&t.env);
    t.contract.set_max_oracle_age(&10);

    let old_seq = t.env.ledger().sequence();
    let oracle = deploy_mock_oracle(&t, true, old_seq);
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    let mut info = t.env.ledger().get();
    info.sequence_number += 20;
    info.timestamp += 20 * 5;
    t.env.ledger().set(info);

    let stale = t
        .contract
        .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer)
        .unwrap();
    assert!(stale.is_stale);
    assert_eq!(stale.consecutive_stale_count, 1);

    // Refresh the oracle's timestamp to the current ledger — next query is fresh.
    let fresh_ts = t.env.ledger().sequence();
    let oracle_client = MockRegistryOracleClient::new(&t.env, &oracle);
    oracle_client.set_response(&true, &fresh_ts);

    let fresh = t
        .contract
        .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer)
        .unwrap();
    assert!(!fresh.is_stale);
    assert_eq!(fresh.consecutive_stale_count, 0);
}

#[test]
fn test_check_oracle_health_returns_none_when_no_oracle_registered() {
    let t = setup();
    assert_eq!(
        t.contract
            .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer),
        None
    );
}

// ── Access control ────────────────────────────────────────────────────────────

#[test]
fn test_register_oracle_unauthorized_caller() {
    let (env, _admin, _, client) = setup_env_no_mock_auths();
    let imposter = Address::generate(&env);
    let oracle = Address::generate(&env);

    env.mock_auths(&[MockAuth {
        address: &imposter,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "register_oracle",
            args: (OracleFeedType::Price, oracle.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let res = client.try_register_oracle(&OracleFeedType::Price, &oracle);
    assert!(
        res.is_err(),
        "register_oracle should fail for non-admin caller"
    );
}

#[test]
fn test_register_token_oracle_unauthorized_caller() {
    let (env, _admin, token, client) = setup_env_no_mock_auths();
    let imposter = Address::generate(&env);
    let oracle = Address::generate(&env);

    env.mock_auths(&[MockAuth {
        address: &imposter,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "register_token_oracle",
            args: (OracleFeedType::Price, token.clone(), oracle.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let res = client.try_register_token_oracle(&OracleFeedType::Price, &token, &oracle);
    assert!(
        res.is_err(),
        "register_token_oracle should fail for non-admin caller"
    );
}

#[test]
fn test_remove_oracle_unauthorized_caller() {
    let (env, _admin, _, client) = setup_env_no_mock_auths();

    env.mock_all_auths();
    let oracle_id = env.register_contract(None, MockRegistryOracle);
    MockRegistryOracleClient::new(&env, &oracle_id).set_response(&true, &env.ledger().sequence());
    client.register_oracle(&OracleFeedType::Price, &oracle_id);

    let imposter = Address::generate(&env);
    env.mock_auths(&[MockAuth {
        address: &imposter,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "remove_oracle",
            args: (OracleFeedType::Price,).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let res = client.try_remove_oracle(&OracleFeedType::Price);
    assert!(
        res.is_err(),
        "remove_oracle should fail for non-admin caller"
    );
}

#[test]
fn test_register_oracle_accepts_compatible_interface_version() {
    let t = setup();
    let oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    let result = t
        .contract
        .try_register_oracle(&OracleFeedType::Identity, &oracle);
    assert!(result.is_ok(), "compatible oracle version must be accepted");
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(oracle)
    );
}

#[contract]
struct IncompatibleVersionOracle;

#[contractimpl]
impl IncompatibleVersionOracle {
    pub fn interface_version(_env: Env) -> u32 {
        999
    }

    pub fn get_payer_data(env: Env, _payer: Address) -> OracleVerificationResponse {
        OracleVerificationResponse {
            is_verified: true,
            timestamp: env.ledger().sequence(),
        }
    }
}

#[test]
fn test_register_oracle_rejects_incompatible_interface_version() {
    let t = setup();
    let oracle = t.env.register_contract(None, IncompatibleVersionOracle);
    let result = t
        .contract
        .try_register_oracle(&OracleFeedType::Identity, &oracle);
    assert_eq!(
        result.err(),
        Some(Ok(ContractError::IncompatibleInterfaceVersion))
    );
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        None,
        "incompatible oracle must not be persisted"
    );
}

// ── Cross-contract pause boundary ─────────────────────────────────────────────
//
// `pause()` only sets a flag read by the *invoice_liquidity* contract's own
// state-changing entry points (see the `is_paused` guards in `fund_invoice`,
// `submit_invoice`, etc. in lib.rs). It has no effect on:
//   1. This contract's own read-only oracle registry queries
//      (`get_oracle_for_token`, `get_oracle_health`, `check_oracle_health`) —
//      they're informational, carry no `is_paused` guard, and stay callable
//      by monitors/keepers throughout an incident.
//   2. The registry's admin/governance mutations (`register_oracle`,
//      `remove_oracle`, `register_token_oracle`, `remove_token_oracle`) —
//      these are gated by `require_admin` only, not `is_paused`, so
//      governance can still repoint or clear a compromised oracle while the
//      protocol is paused (arguably a requirement during an oracle-related
//      incident, not a gap).
//   3. The externally deployed oracle contracts themselves — they are
//      separate contracts with their own lifecycle, wholly outside this
//      contract's `Paused` flag.
// `fund_invoice` never observes any of this: it checks `is_paused` before
// doing anything else, so a paused call never reaches the oracle registry at
// all — it fails fast with `ContractPaused` and leaves no health record.

#[test]
fn test_get_oracle_for_token_readable_while_paused() {
    let t = setup();
    let oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    t.contract.pause();

    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(oracle),
        "registry resolution is a read-only view and must work while paused"
    );
}

#[test]
fn test_check_oracle_health_readable_while_paused() {
    let t = setup();
    let oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    t.contract.pause();

    // check_oracle_health performs a live cross-contract call to the oracle
    // and persists a health snapshot. Neither the call nor the write is
    // gated on `is_paused` — it must succeed exactly as it would unpaused.
    let health = t
        .contract
        .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer)
        .expect("oracle health check must succeed while contract is paused");
    assert!(!health.is_stale);
    assert_eq!(health.oracle, oracle);

    // And the recorded snapshot is readable back, still while paused.
    assert_eq!(
        t.contract
            .get_oracle_health(&OracleFeedType::Identity, &t.token.address),
        Some(health)
    );
}

#[test]
fn test_fund_invoice_paused_never_reaches_oracle_registry() {
    let t = setup();
    let oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    let invoice_id = make_invoice(&t);
    t.contract.pause();

    // fund_invoice must fail fast on the pause guard, before it ever
    // resolves or queries the oracle registry — even with oracle
    // verification requested and a healthy oracle registered.
    let result =
        t.contract
            .try_fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true);
    assert_eq!(result, Err(Ok(ContractError::ContractPaused)));

    // No health snapshot was ever recorded — proof the oracle was never
    // touched, rather than silently queried and its result discarded.
    assert_eq!(
        t.contract
            .get_oracle_health(&OracleFeedType::Identity, &t.token.address),
        None,
        "a paused fund_invoice call must not query the oracle registry at all"
    );
}

#[test]
fn test_oracle_registry_mutations_unaffected_by_core_contract_pause() {
    let t = setup();
    let default_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    let token_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());

    t.contract.pause();

    // Governance/admin oracle config changes are a different concern from
    // the core contract's operational pause and must go through unaffected.
    t.contract
        .register_oracle(&OracleFeedType::Identity, &default_oracle);
    t.contract.register_token_oracle(
        &OracleFeedType::Identity,
        &t.token.address,
        &token_oracle,
    );
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(token_oracle)
    );

    // Advance past the per-channel mutation cooldown before the next
    // mutation to each of these same two channels below — unrelated to,
    // and unaffected by, the contract's own pause state (pause and this
    // cooldown are independent mechanisms).
    advance_past_oracle_registry_cooldown(&t.env);
    t.contract
        .remove_token_oracle(&OracleFeedType::Identity, &t.token.address);
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(default_oracle),
        "removing the per-token override must succeed while paused, falling back to the default"
    );

    advance_past_oracle_registry_cooldown(&t.env);
    t.contract.remove_oracle(&OracleFeedType::Identity);
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        None,
        "removing the feed-type default must succeed while paused"
    );
}

// ── Circuit breaker ────────────────────────────────────────────────────────────
//
// check_oracle_health / consecutive_stale_count already existed (Issue
// #532) but nothing acted on repeated staleness — funding kept being
// attempted against a degraded oracle indefinitely. This section covers:
//   1. Automatically tripping the breaker after
//      MAX_CONSECUTIVE_STALE_QUERIES consecutive stale observations.
//   2. fund_invoice falling back through the priority chain past a tripped
//      level, or rejecting outright with ContractError::OracleCircuitOpen
//      when no fallback exists.
//   3. Governance-only reset — no auto-recovery on a single fresh query,
//      to avoid flapping.

/// Registers `oracle` as the Identity feed-type default and advances the
/// ledger far enough past `max_age` (already lowered to 10 by the caller
/// via `set_max_oracle_age`) that it reads as stale on every subsequent
/// query, without needing to touch the oracle's own timestamp again.
fn setup_stale_default_oracle(t: &crate::test::TestEnv) -> Address {
    advance_past_rate_limit_cooldown(&t.env);
    t.contract.set_max_oracle_age(&10);

    let old_seq = t.env.ledger().sequence();
    let oracle = deploy_mock_oracle(t, true, old_seq);
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    let mut info = t.env.ledger().get();
    info.sequence_number += 20;
    info.timestamp += 20 * 5;
    t.env.ledger().set(info);

    oracle
}

#[test]
fn test_circuit_trips_after_max_consecutive_stale_queries() {
    let t = setup();
    setup_stale_default_oracle(&t);

    assert!(!t
        .contract
        .is_oracle_circuit_tripped(&OracleFeedType::Identity, &t.token.address));

    // Two stale queries: below the MAX_CONSECUTIVE_STALE_QUERIES=3 threshold.
    t.contract
        .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer);
    t.contract
        .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer);
    assert!(
        !t.contract
            .is_oracle_circuit_tripped(&OracleFeedType::Identity, &t.token.address),
        "circuit must not trip before the threshold is reached"
    );

    // Third consecutive stale query crosses the threshold and trips it.
    let health = t
        .contract
        .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer)
        .unwrap();
    assert_eq!(health.consecutive_stale_count, 3);
    assert!(t
        .contract
        .is_oracle_circuit_tripped(&OracleFeedType::Identity, &t.token.address));

    // Further stale queries keep it tripped (idempotent) — the streak keeps
    // climbing for observability, but nothing re-fires on an already-open
    // breaker.
    let health = t
        .contract
        .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer)
        .unwrap();
    assert_eq!(health.consecutive_stale_count, 4);
    assert!(t
        .contract
        .is_oracle_circuit_tripped(&OracleFeedType::Identity, &t.token.address));
}

#[test]
fn test_fund_invoice_rejects_when_circuit_open_with_no_fallback() {
    let t = setup();
    setup_stale_default_oracle(&t);

    // Only the feed-type default is registered — no per-token override, no
    // legacy price_oracle — so there's nothing to fall back to once it trips.
    for _ in 0..3 {
        t.contract
            .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer);
    }
    assert!(t
        .contract
        .is_oracle_circuit_tripped(&OracleFeedType::Identity, &t.token.address));

    let invoice_id = make_invoice(&t);
    let result =
        t.contract
            .try_fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true);
    assert_eq!(
        result,
        Err(Ok(ContractError::OracleCircuitOpen)),
        "fund_invoice must reject oracle-gated funding rather than silently proceeding \
         once the only registered oracle is circuit-tripped"
    );
}

#[test]
fn test_fund_invoice_falls_back_to_feed_type_default_when_override_tripped() {
    let t = setup();
    advance_past_rate_limit_cooldown(&t.env);
    t.contract.set_max_oracle_age(&10);

    // A healthy feed-type-wide default...
    let good_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract
        .register_oracle(&OracleFeedType::Identity, &good_oracle);

    // ...and a per-token override (higher priority) that will go stale.
    let bad_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract.register_token_oracle(
        &OracleFeedType::Identity,
        &t.token.address,
        &bad_oracle,
    );

    // Advance the ledger so the override's timestamp reads as stale.
    let mut info = t.env.ledger().get();
    info.sequence_number += 20;
    info.timestamp += 20 * 5;
    t.env.ledger().set(info);

    // Refresh the default's timestamp so it stays fresh despite the same
    // ledger advance (it was deployed at the same original timestamp).
    let good_client = MockRegistryOracleClient::new(&t.env, &good_oracle);
    good_client.set_response(&true, &t.env.ledger().sequence());

    // check_oracle_health always observes the highest-priority (override)
    // entry via the plain, circuit-agnostic resolve_oracle — three
    // consecutive stale queries against it trips the breaker.
    for _ in 0..3 {
        t.contract
            .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer);
    }
    assert!(t
        .contract
        .is_oracle_circuit_tripped(&OracleFeedType::Identity, &t.token.address));

    // fund_invoice's oracle-gated verification must now skip the tripped
    // override and fall back to the healthy feed-type default, rather than
    // rejecting the funding.
    let invoice_id = make_invoice(&t);
    let result =
        t.contract
            .try_fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true);
    assert!(
        result.is_ok(),
        "fund_invoice must fall back to the healthy feed-type default when the \
         per-token override is circuit-tripped, per the documented priority order"
    );
}

#[test]
fn test_reset_oracle_circuit_requires_admin() {
    let (env, _admin, token_address, client) = setup_env_no_mock_auths();
    let imposter = Address::generate(&env);

    env.mock_auths(&[MockAuth {
        address: &imposter,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "reset_oracle_circuit",
            args: (OracleFeedType::Identity, token_address.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let res = client.try_reset_oracle_circuit(&OracleFeedType::Identity, &token_address);
    assert!(
        res.is_err(),
        "reset_oracle_circuit should fail for non-admin caller"
    );
}

#[test]
fn test_reset_oracle_circuit_clears_flag_and_restores_verification() {
    let t = setup();
    let oracle = setup_stale_default_oracle(&t);

    for _ in 0..3 {
        t.contract
            .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer);
    }
    assert!(t
        .contract
        .is_oracle_circuit_tripped(&OracleFeedType::Identity, &t.token.address));

    t.contract
        .reset_oracle_circuit(&OracleFeedType::Identity, &t.token.address);
    assert!(!t
        .contract
        .is_oracle_circuit_tripped(&OracleFeedType::Identity, &t.token.address));

    // Refresh the oracle so it's fresh again, then confirm funding resumes
    // against it directly — no fallback needed, no rejection.
    let oracle_client = MockRegistryOracleClient::new(&t.env, &oracle);
    oracle_client.set_response(&true, &t.env.ledger().sequence());

    let invoice_id = make_invoice(&t);
    let result =
        t.contract
            .try_fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true);
    assert!(
        result.is_ok(),
        "funding must resume against the original oracle once governance resets the circuit"
    );
}

#[test]
fn test_circuit_does_not_auto_recover_on_single_fresh_query() {
    let t = setup();
    let oracle = setup_stale_default_oracle(&t);

    for _ in 0..3 {
        t.contract
            .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer);
    }
    assert!(t
        .contract
        .is_oracle_circuit_tripped(&OracleFeedType::Identity, &t.token.address));

    // The oracle recovers and starts answering fresh again...
    let oracle_client = MockRegistryOracleClient::new(&t.env, &oracle);
    oracle_client.set_response(&true, &t.env.ledger().sequence());
    let health = t
        .contract
        .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer)
        .unwrap();
    assert!(!health.is_stale);
    assert_eq!(health.consecutive_stale_count, 0);

    // ...but the circuit stays tripped regardless — no auto-recovery on a
    // single fresh query, to avoid flapping.
    assert!(
        t.contract
            .is_oracle_circuit_tripped(&OracleFeedType::Identity, &t.token.address),
        "a single fresh query must not auto-clear the circuit breaker"
    );

    // Oracle-gated funding is still rejected (no fallback registered) even
    // though the underlying oracle is, right now, reporting fresh data.
    let invoice_id = make_invoice(&t);
    let result =
        t.contract
            .try_fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true);
    assert_eq!(result, Err(Ok(ContractError::OracleCircuitOpen)));
}

#[test]
fn test_circuit_retrips_immediately_if_still_stale_right_after_reset() {
    let t = setup();
    setup_stale_default_oracle(&t);

    for _ in 0..3 {
        t.contract
            .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer);
    }
    assert!(t
        .contract
        .is_oracle_circuit_tripped(&OracleFeedType::Identity, &t.token.address));

    // Governance resets — but the oracle's own data hasn't actually
    // changed, it's still the same stale timestamp.
    t.contract
        .reset_oracle_circuit(&OracleFeedType::Identity, &t.token.address);
    assert!(!t
        .contract
        .is_oracle_circuit_tripped(&OracleFeedType::Identity, &t.token.address));

    // The very next query is still stale — this must re-trip immediately,
    // not require MAX_CONSECUTIVE_STALE_QUERIES more failures: the raw
    // streak counter is untouched by reset_oracle_circuit (only the sticky
    // flag is cleared), so it never dipped below threshold across the reset.
    let health = t
        .contract
        .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer)
        .unwrap();
    assert!(health.is_stale);
    assert!(
        t.contract
            .is_oracle_circuit_tripped(&OracleFeedType::Identity, &t.token.address),
        "a still-stale oracle must re-trip immediately after a reset, not require \
         a fresh multi-query streak on top of the pre-existing one"
    );
}

// ── Oracle swap mid-lifecycle (Issue #oracle-swap) ────────────────────────────
//
// If a registered oracle needs to be replaced (e.g. a provider upgrades its
// own contract), does the swap apply to invoices that already exist, or only
// to ones submitted afterward? See ADR-010's "Oracle Swap Semantics for
// In-Flight Invoices" for the documented answer: the swap applies
// immediately and retroactively to every invoice, because
// require_oracle_verification is a per-fund_invoice-call argument (never
// stored on the invoice) and resolve_oracle always reads the registry's
// current state — there is nothing invoice-scoped to be broken. These tests
// verify that behavior end-to-end rather than leaving it an accident of
// implementation.

#[test]
fn test_oracle_swap_mid_lifecycle_before_first_funding() {
    let t = setup();

    // Old oracle: healthy, verifies the payer.
    let old_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract
        .register_oracle(&OracleFeedType::Identity, &old_oracle);

    let invoice_id = make_invoice(&t);

    // Governance swaps in a new oracle before any funding has happened —
    // register_oracle documents itself as "register (or update)", so this
    // is an in-place replacement, not a separate add. Advance past the
    // per-channel mutation cooldown first (Issue #oracle-registry-cooldown)
    // — well under the default staleness window, so it doesn't affect the
    // freshness of either oracle's timestamp below.
    advance_past_oracle_registry_cooldown(&t.env);
    let new_oracle = deploy_mock_oracle(&t, false, t.env.ledger().sequence());
    t.contract
        .register_oracle(&OracleFeedType::Identity, &new_oracle);
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(new_oracle)
    );

    // The new oracle currently reports the payer as unverified — if
    // fund_invoice were somehow still consulting the old (untouched,
    // still-verified) oracle, this funding attempt would succeed instead.
    // Failing proves the swap took effect for an invoice submitted before it.
    let result =
        t.contract
            .try_fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true);
    assert_eq!(
        result,
        Err(Ok(ContractError::PayerUnverified)),
        "fund_invoice must resolve against the newly-registered oracle, not a stale \
         reference to the one that was current when the invoice was submitted"
    );

    // Once the new oracle reports the payer as verified, funding proceeds
    // normally — the swap didn't leave the invoice permanently broken.
    let new_oracle_client = MockRegistryOracleClient::new(&t.env, &new_oracle);
    new_oracle_client.set_response(&true, &t.env.ledger().sequence());
    let result =
        t.contract
            .try_fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &true);
    assert!(result.is_ok());
    assert_eq!(t.contract.get_invoice(&invoice_id).status, InvoiceStatus::Funded);
}

#[test]
fn test_oracle_swap_mid_lifecycle_after_partial_funding() {
    let t = setup();

    // Old oracle: healthy.
    let old_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract
        .register_oracle(&OracleFeedType::Identity, &old_oracle);

    let invoice_id = make_invoice(&t);
    let half = INVOICE_AMOUNT / 2;

    // First tranche funds against the old oracle and succeeds — the invoice
    // is now genuinely "in flight" (PartiallyFunded), not just submitted.
    t.contract
        .fund_invoice(&t.funder, &invoice_id, &half, &true);
    assert_eq!(
        t.contract.get_invoice(&invoice_id).status,
        InvoiceStatus::PartiallyFunded
    );

    // Governance swaps the oracle mid-lifecycle, while this invoice already
    // has funding history against the old one. Advance past the
    // per-channel mutation cooldown first (Issue #oracle-registry-cooldown).
    advance_past_oracle_registry_cooldown(&t.env);
    let new_oracle = deploy_mock_oracle(&t, false, t.env.ledger().sequence());
    t.contract
        .register_oracle(&OracleFeedType::Identity, &new_oracle);

    // The second tranche (completing the invoice) must resolve against the
    // new oracle, not the old one it started funding under — the old
    // oracle is untouched and still reports verified=true, so a failure
    // here proves the second call is genuinely re-resolving live rather
    // than reusing whatever the first call saw.
    let result = t
        .contract
        .try_fund_invoice(&t.funder, &invoice_id, &half, &true);
    assert_eq!(
        result,
        Err(Ok(ContractError::PayerUnverified)),
        "a partially-funded invoice's remaining tranche must resolve against the \
         oracle registered *now*, not the one that funded the first tranche"
    );
    // The failed attempt must not have altered funding progress.
    assert_eq!(
        t.contract.get_invoice(&invoice_id).status,
        InvoiceStatus::PartiallyFunded
    );

    // Once the new oracle is healthy, the same remaining tranche completes
    // the invoice normally.
    let new_oracle_client = MockRegistryOracleClient::new(&t.env, &new_oracle);
    new_oracle_client.set_response(&true, &t.env.ledger().sequence());
    t.contract
        .fund_invoice(&t.funder, &invoice_id, &half, &true);
    assert_eq!(t.contract.get_invoice(&invoice_id).status, InvoiceStatus::Funded);
}

// ── Oracle registry mutation cooldown (Issue #oracle-registry-cooldown) ───────
//
// register_oracle/register_token_oracle/remove_oracle/remove_token_oracle
// were previously gated by authorization alone, with no cooldown — a
// compromised or malicious admin/governance-authorized caller could rapidly
// flip oracle configuration. These tests cover: rapid mutation attempts
// being rejected, the cooldown expiring correctly, the cooldown being
// scoped per resolution channel (not a single global lock), and reads
// remaining fully available regardless of an active cooldown.

#[test]
fn test_oracle_registry_cooldown_rejects_rapid_mutation() {
    let t = setup();
    let oracle_a = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    let oracle_b = deploy_mock_oracle(&t, true, t.env.ledger().sequence());

    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle_a);

    // Immediately attempting another mutation to the *same* channel (the
    // Identity feed-type default), with no ledger advance, must be
    // rejected — same channel, whether it's another register_oracle call
    // or a remove_oracle call.
    let result = t
        .contract
        .try_register_oracle(&OracleFeedType::Identity, &oracle_b);
    assert_eq!(
        result,
        Err(Ok(ContractError::OracleRegistryCooldownActive))
    );

    let result = t.contract.try_remove_oracle(&OracleFeedType::Identity);
    assert_eq!(
        result,
        Err(Ok(ContractError::OracleRegistryCooldownActive))
    );

    // The rejected attempts must not have changed anything.
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(oracle_a)
    );
}

#[test]
fn test_oracle_registry_cooldown_expires_after_configured_ledgers() {
    let t = setup();
    let oracle_a = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    let oracle_b = deploy_mock_oracle(&t, true, t.env.ledger().sequence());

    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle_a);

    // Too soon: rejected.
    assert_eq!(
        t.contract
            .try_register_oracle(&OracleFeedType::Identity, &oracle_b),
        Err(Ok(ContractError::OracleRegistryCooldownActive))
    );

    // Advance past the default cooldown (720 ledgers) — now it succeeds.
    advance_past_oracle_registry_cooldown(&t.env);
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle_b);
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(oracle_b)
    );
}

#[test]
fn test_oracle_registry_cooldown_is_scoped_per_channel() {
    let t = setup();
    let default_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    let token_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());

    t.contract
        .register_oracle(&OracleFeedType::Identity, &default_oracle);

    // A mutation to a *different* channel (the per-token override for this
    // same feed type, a distinct resolution channel from the feed-type
    // default) must succeed immediately — the cooldown must not act as a
    // single global lock across every oracle registry mutation.
    let result = t.contract.try_register_token_oracle(
        &OracleFeedType::Identity,
        &t.token.address,
        &token_oracle,
    );
    assert!(
        result.is_ok(),
        "a mutation to an unrelated resolution channel must not be blocked by another \
         channel's cooldown"
    );

    // But a second mutation to that *same* per-token channel, immediately
    // after, is correctly rejected.
    let another_token_oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    let result = t.contract.try_register_token_oracle(
        &OracleFeedType::Identity,
        &t.token.address,
        &another_token_oracle,
    );
    assert_eq!(
        result,
        Err(Ok(ContractError::OracleRegistryCooldownActive))
    );
}

#[test]
fn test_oracle_registry_cooldown_does_not_block_reads() {
    let t = setup();
    let oracle = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    // The channel is now on cooldown for further mutations — but every
    // read-only oracle registry operation must remain fully available,
    // completely unaffected.
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(oracle)
    );
    assert_eq!(
        t.contract.get_oracle_health(&OracleFeedType::Identity, &t.token.address),
        None // never queried yet — still a valid, non-erroring read
    );
    let health = t
        .contract
        .check_oracle_health(&OracleFeedType::Identity, &t.token.address, &t.payer)
        .unwrap();
    assert!(!health.is_stale);
    assert_eq!(
        t.contract.get_oracle_registry_cooldown_ledgers(),
        crate::oracle_registry::DEFAULT_ORACLE_REGISTRY_COOLDOWN_LEDGERS
    );
}

#[test]
fn test_set_oracle_registry_cooldown_ledgers_governs_the_wait() {
    let t = setup();
    // set_oracle_registry_cooldown_ledgers is itself rate-limited
    // (DEFAULT_RATE_LIMIT_LEDGERS); its last-call ledger defaults to 0
    // when never called, and setup() starts the ledger well below that
    // cooldown, so calling it immediately after setup() would incorrectly
    // trip the cooldown on its very first-ever call — same pre-existing
    // quirk `advance_past_rate_limit_cooldown` already works around
    // elsewhere in this file for set_price_oracle/set_max_oracle_age.
    advance_past_rate_limit_cooldown(&t.env);
    let oracle_a = deploy_mock_oracle(&t, true, t.env.ledger().sequence());
    let oracle_b = deploy_mock_oracle(&t, true, t.env.ledger().sequence());

    // Shorten the cooldown to 5 ledgers.
    t.contract.set_oracle_registry_cooldown_ledgers(&5);
    assert_eq!(t.contract.get_oracle_registry_cooldown_ledgers(), 5);

    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle_a);

    // Still too soon (0 ledgers elapsed).
    assert_eq!(
        t.contract
            .try_register_oracle(&OracleFeedType::Identity, &oracle_b),
        Err(Ok(ContractError::OracleRegistryCooldownActive))
    );

    // Advance just 5 ledgers — the shortened cooldown, not the 720-ledger
    // default — and the mutation now succeeds.
    let mut info = t.env.ledger().get();
    info.sequence_number += 5;
    info.timestamp += 5 * 5;
    t.env.ledger().set(info);

    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle_b);
    assert_eq!(
        t.contract
            .get_oracle_for_token(&OracleFeedType::Identity, &t.token.address),
        Some(oracle_b)
    );
}

#[test]
fn test_set_oracle_registry_cooldown_ledgers_rejects_zero() {
    let t = setup();
    // See test_set_oracle_registry_cooldown_ledgers_governs_the_wait: avoid
    // the pre-existing rate-limit quirk confounding this test with a
    // RateLimited error instead of genuinely exercising the zero-rejection
    // check (both are Err, so the bare .is_err() assertion below would
    // pass either way — advancing first makes sure it's testing the right
    // thing).
    advance_past_rate_limit_cooldown(&t.env);
    assert!(t.contract.try_set_oracle_registry_cooldown_ledgers(&0).is_err());
    assert_eq!(
        t.contract.get_oracle_registry_cooldown_ledgers(),
        crate::oracle_registry::DEFAULT_ORACLE_REGISTRY_COOLDOWN_LEDGERS,
        "a rejected update must leave the previously configured value in place"
    );
}

#[test]
fn test_set_oracle_registry_cooldown_ledgers_requires_admin() {
    let (env, _admin, _, client) = setup_env_no_mock_auths();
    let imposter = Address::generate(&env);

    env.mock_auths(&[MockAuth {
        address: &imposter,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "set_oracle_registry_cooldown_ledgers",
            args: (5_u64,).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let res = client.try_set_oracle_registry_cooldown_ledgers(&5);
    assert!(
        res.is_err(),
        "set_oracle_registry_cooldown_ledgers should fail for non-admin caller"
    );
}
