#![cfg(test)]

//! Tests for Issue #dispute-oracle-snapshot — freezing oracle-sourced state
//! into the dispute record at filing time.
//!
//! Disputes carry an off-chain `reason_hash`; if oracle-sourced data (payer
//! verification, price) is later cited as evidence in governance's dispute
//! resolution discussion, there was previously no on-chain binding between
//! "what the oracle said when the dispute was filed" and "what governance
//! reviews" — the oracle could have moved by resolution time.
//! `dispute_invoice()` now calls
//! `oracle_registry::snapshot_oracle_state_for_dispute` and stores the
//! result on `DisputeRecord`, exposed via `get_dispute_details`.
//!
//! Covers:
//! 1. The snapshot correctly captures live oracle state at filing time.
//! 2. The snapshot is frozen — a live oracle value change after filing does
//!    not retroactively change what `get_dispute_details` returns.
//! 3. The no-oracle-registered case (`identity_oracle_gated: false`) is
//!    captured explicitly, not silently defaulted.
//! 4. Price-feed data is included when Price sources are registered, and is
//!    equally frozen.

use super::*;
use crate::oracle_registry::OracleFeedType;
use crate::test::setup;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env,
};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30;

/// Same shape as tests_oracle_registry.rs's MockRegistryOracle: a
/// payer-verification oracle with a settable `is_verified`/`timestamp`
/// response. Redeclared locally — test modules in this codebase each
/// define their own mocks rather than sharing across sibling `mod` files.
#[contract]
struct MockIdentityOracle;

#[contractimpl]
impl MockIdentityOracle {
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
        let timestamp: u32 = env
            .storage()
            .instance()
            .get(&soroban_sdk::symbol_short!("ts"))
            .unwrap_or(env.ledger().sequence());
        OracleVerificationResponse {
            is_verified,
            timestamp,
        }
    }
}

/// A minimal price-reporting oracle, matching tests_price_deviation.rs's
/// MockPriceOracle: `get_price(token)` returns whatever was last set.
#[contract]
struct MockPriceOracle;

#[contractimpl]
impl MockPriceOracle {
    pub fn set_price(env: Env, price: i128) {
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("price"), &price);
    }

    pub fn get_price(env: Env, _token: Address) -> i128 {
        env.storage()
            .instance()
            .get(&soroban_sdk::symbol_short!("price"))
            .unwrap_or(0)
    }
}

fn deploy_identity_oracle(t: &crate::test::TestEnv, verified: bool, ts: u32) -> Address {
    let id = t.env.register_contract(None, MockIdentityOracle);
    MockIdentityOracleClient::new(&t.env, &id).set_response(&verified, &ts);
    id
}

fn deploy_price_oracle(t: &crate::test::TestEnv, price: i128) -> Address {
    let id = t.env.register_contract(None, MockPriceOracle);
    MockPriceOracleClient::new(&t.env, &id).set_price(&price);
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

fn dummy_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[7u8; 32])
}

#[test]
fn test_get_dispute_details_returns_none_when_no_dispute_filed() {
    let t = setup();
    let invoice_id = make_invoice(&t);
    assert_eq!(t.contract.get_dispute_details(&invoice_id), None);
}

#[test]
fn test_dispute_snapshots_identity_oracle_state_at_filing_time() {
    let t = setup();
    let oracle = deploy_identity_oracle(&t, true, t.env.ledger().sequence());
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    let invoice_id = make_invoice(&t);
    t.contract.dispute_invoice(&invoice_id, &dummy_hash(&t.env));

    let dispute = t.contract.get_dispute_details(&invoice_id).unwrap();
    let snapshot = dispute.oracle_snapshot;

    assert!(snapshot.identity_oracle_gated);
    assert_eq!(snapshot.identity_oracle, Some(oracle));
    assert_eq!(snapshot.payer_verified, Some(true));
    assert_eq!(snapshot.identity_data_stale, Some(false));
    assert!(snapshot.identity_data_timestamp.is_some());
}

#[test]
fn test_dispute_snapshot_no_oracle_registered_is_explicit() {
    let t = setup();
    let invoice_id = make_invoice(&t);
    t.contract.dispute_invoice(&invoice_id, &dummy_hash(&t.env));

    let dispute = t.contract.get_dispute_details(&invoice_id).unwrap();
    let snapshot = dispute.oracle_snapshot;

    assert!(
        !snapshot.identity_oracle_gated,
        "no Identity oracle was ever registered — this must be recorded explicitly, \
         not left ambiguous with a genuine unverified/absent-data case"
    );
    assert_eq!(snapshot.identity_oracle, None);
    assert_eq!(snapshot.payer_verified, None);
    assert_eq!(snapshot.identity_data_timestamp, None);
    assert_eq!(snapshot.identity_data_stale, None);
    assert_eq!(snapshot.price, None);
}

#[test]
fn test_dispute_snapshot_frozen_after_live_oracle_value_changes() {
    let t = setup();
    let oracle = deploy_identity_oracle(&t, true, t.env.ledger().sequence());
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    let invoice_id = make_invoice(&t);
    t.contract.dispute_invoice(&invoice_id, &dummy_hash(&t.env));

    let snapshot_at_filing = t
        .contract
        .get_dispute_details(&invoice_id)
        .unwrap()
        .oracle_snapshot;
    assert_eq!(snapshot_at_filing.payer_verified, Some(true));

    // The live oracle now flips to reporting the payer as unverified —
    // simulating exactly the scenario this feature exists to guard
    // against: the oracle moving between dispute filing and governance
    // review.
    let oracle_client = MockIdentityOracleClient::new(&t.env, &oracle);
    oracle_client.set_response(&false, &t.env.ledger().sequence());

    // A fresh, independent query against the live oracle does reflect the
    // change (sanity-checking that the mock itself actually moved)...
    assert_eq!(
        MockIdentityOracleClient::new(&t.env, &oracle)
            .get_payer_data(&t.payer)
            .is_verified,
        false
    );

    // ...but the dispute's stored snapshot must be completely unaffected —
    // governance reviewing this dispute later sees `Some(true)`, the state
    // as of filing, not the oracle's current answer.
    let snapshot_after_move = t
        .contract
        .get_dispute_details(&invoice_id)
        .unwrap()
        .oracle_snapshot;
    assert_eq!(
        snapshot_after_move, snapshot_at_filing,
        "the dispute's oracle snapshot must not change after filing, even though \
         the live oracle's value has moved"
    );
    assert_eq!(snapshot_after_move.payer_verified, Some(true));
}

#[test]
fn test_dispute_snapshot_includes_and_freezes_price_feed_reading() {
    let t = setup();
    let price_oracle = deploy_price_oracle(&t, 100);
    t.contract
        .add_price_source(&OracleFeedType::Price, &price_oracle);

    let invoice_id = make_invoice(&t);
    t.contract.dispute_invoice(&invoice_id, &dummy_hash(&t.env));

    let snapshot_at_filing = t
        .contract
        .get_dispute_details(&invoice_id)
        .unwrap()
        .oracle_snapshot;
    assert_eq!(snapshot_at_filing.price, Some(100));

    // The price source moves after the dispute was filed.
    MockPriceOracleClient::new(&t.env, &price_oracle).set_price(&500);
    assert_eq!(
        t.contract
            .get_verified_price(&OracleFeedType::Price, &t.token.address),
        500,
        "sanity check: the live price genuinely moved"
    );

    // The dispute's frozen snapshot is unaffected.
    let snapshot_after_move = t
        .contract
        .get_dispute_details(&invoice_id)
        .unwrap()
        .oracle_snapshot;
    assert_eq!(snapshot_after_move.price, Some(100));
}

#[test]
fn test_dispute_snapshot_captured_even_when_funding_never_required_verification() {
    // The oracle snapshot is computed unconditionally at dispute time,
    // independent of whether require_oracle_verification was ever actually
    // used while funding this specific invoice — an oracle can be
    // registered for a token without every funder having opted into
    // checking it.
    let t = setup();
    let oracle = deploy_identity_oracle(&t, true, t.env.ledger().sequence());
    t.contract
        .register_oracle(&OracleFeedType::Identity, &oracle);

    let invoice_id = make_invoice(&t);
    // Fund without oracle verification.
    t.contract
        .fund_invoice(&t.funder, &invoice_id, &INVOICE_AMOUNT, &false);
    assert_eq!(
        t.contract.get_invoice(&invoice_id).status,
        InvoiceStatus::Funded
    );

    t.contract.dispute_invoice(&invoice_id, &dummy_hash(&t.env));
    let snapshot = t
        .contract
        .get_dispute_details(&invoice_id)
        .unwrap()
        .oracle_snapshot;
    assert!(
        snapshot.identity_oracle_gated,
        "the snapshot reflects the oracle registered for this token, regardless of \
         whether the specific funding call that happened opted into checking it"
    );
    assert_eq!(snapshot.payer_verified, Some(true));
}
