// Event emission regression tests for every public `invoice_liquidity`
// mutation.
//
// Two layers:
//
// 1. A *coverage ledger* (`MUTATING` / `READ_ONLY`). The set of `pub fn`
//    entrypoints in `contracts/invoice_liquidity/src/lib.rs` must equal the
//    union of those two lists, so adding an entrypoint without classifying it
//    fails here. Every mutating entrypoint is `Here` (behavioural test in this
//    file named `<entrypoint>_emits_*`), `Gate` (emission is enforced by
//    `scripts/check-event-coverage.ts --check`, run in CI) or `Exempt`
//    (documented non-emitting mutator, mirrors docs/events.md "Known Gaps").
//
// 2. Behavioural tests that call the entrypoint and assert the *exact* topic
//    symbol (`topic[0]`) was published by the contract — not a substring of a
//    debug string, which would also match payload field names such as
//    `invoices_submitted`.
//
// Failure behaviour is pinned too: a rejected call must not leave an event
// behind (Soroban discards the events of a failed invocation).
//
// Previously this file was never registered as a cargo test target and used
// `events().all()` without the `Events` trait in scope, so it neither compiled
// nor ran. It is now declared in contracts/invoice_liquidity/Cargo.toml.

#![cfg(test)]

mod test_context;

use invoice_liquidity::ReferralCode;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    xdr::{ContractEventBody, ScVal},
    Address, BytesN,
};
use test_context::TestContext;

const AMOUNT: i128 = 1_000_000_000;
const RATE: u32 = 300;
const DUE_IN: u64 = 1_000;

const LIB_SRC: &str = include_str!("../invoice_liquidity/src/lib.rs");
const SELF_SRC: &str = include_str!("event_emission_test.rs");

// ───────────────────────── coverage ledger ─────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Coverage {
    /// Behavioural test in this file named `<entrypoint>_emits_*`.
    Here,
    /// Emission enforced by `scripts/check-event-coverage.ts --check`.
    Gate,
    /// Documented non-emitting mutator (docs/events.md "Known Gaps").
    Exempt,
}

const MUTATING: &[(&str, Coverage)] = &[
    ("add_identity_oracle", Coverage::Gate),
    ("add_price_source", Coverage::Gate),
    ("add_token", Coverage::Gate),
    ("appeal_default", Coverage::Gate),
    ("auto_resolve_dispute", Coverage::Gate),
    ("cancel_invoice", Coverage::Here),
    ("cancel_signer_rotation", Coverage::Gate),
    ("check_oracle_health", Coverage::Gate),
    ("check_oracle_verification", Coverage::Gate),
    ("claim_default", Coverage::Here),
    ("claim_pending_payout", Coverage::Gate),
    ("convert_invoice_token", Coverage::Here),
    ("correct_token_decimals", Coverage::Gate),
    ("dispute_invoice", Coverage::Here),
    ("execute_proposal", Coverage::Gate),
    ("expire_invoice", Coverage::Here),
    ("finalize_signer_rotation", Coverage::Gate),
    ("fund_invoice", Coverage::Here),
    ("get_verified_price", Coverage::Gate),
    ("initialize", Coverage::Here),
    ("initialize_multisig_admin", Coverage::Exempt),
    ("join_fund_queue", Coverage::Here),
    ("mark_paid", Coverage::Here),
    ("migrate", Coverage::Gate),
    ("pause", Coverage::Here),
    ("payer_score", Coverage::Gate),
    ("propose_pause", Coverage::Exempt),
    ("propose_remove_token", Coverage::Exempt),
    ("propose_rotate_signer", Coverage::Exempt),
    ("propose_set_fee_rate", Coverage::Exempt),
    ("propose_set_max_discount", Coverage::Exempt),
    ("propose_unpause", Coverage::Exempt),
    ("propose_update_multisig", Coverage::Exempt),
    ("record_twap_sample", Coverage::Exempt),
    ("recover_fund_queue", Coverage::Gate),
    ("register_oracle", Coverage::Gate),
    ("register_token_oracle", Coverage::Gate),
    ("rehearse_rollback", Coverage::Gate),
    ("remove_identity_oracle", Coverage::Gate),
    ("remove_oracle", Coverage::Gate),
    ("remove_price_source", Coverage::Gate),
    ("remove_token", Coverage::Gate),
    ("remove_token_oracle", Coverage::Gate),
    ("reset_oracle_circuit", Coverage::Gate),
    ("resolve_appeal", Coverage::Gate),
    ("resolve_dispute", Coverage::Here),
    ("resolve_fund_queue", Coverage::Here),
    ("set_admin", Coverage::Here),
    ("set_distribution_contract", Coverage::Gate),
    ("set_identity_quorum", Coverage::Here),
    ("set_insurance_pool", Coverage::Exempt),
    ("set_max_invoice_amount", Coverage::Gate),
    ("set_max_oracle_age", Coverage::Gate),
    ("set_max_price_deviation_bps", Coverage::Exempt),
    ("set_min_payer_reputation", Coverage::Here),
    ("set_price_oracle", Coverage::Gate),
    ("set_token_volume_cap", Coverage::Gate),
    ("set_twap_enabled", Coverage::Gate),
    ("set_twap_window", Coverage::Gate),
    ("sign_proposal", Coverage::Exempt),
    ("submit_invoice", Coverage::Here),
    ("submit_invoices_batch", Coverage::Gate),
    ("suggested_discount_rate", Coverage::Gate),
    ("transfer_invoice", Coverage::Here),
    ("transfer_lp_position", Coverage::Here),
    ("unpause", Coverage::Here),
    ("update_config", Coverage::Gate),
    ("update_decay_params", Coverage::Gate),
    ("update_fee_rate", Coverage::Here),
    ("update_fee_tiers", Coverage::Gate),
    ("update_invoice", Coverage::Here),
    ("update_max_discount", Coverage::Gate),
    ("upgrade", Coverage::Gate),
];

const READ_ONLY: &[&str] = &[
    "audit_token_decimals",
    "check_identity_quorum_health",
    "claim_yield",
    "get_circuit_recovery_state",
    "get_config",
    "get_contract_stats",
    "get_fee_tiers",
    "get_identity_oracles",
    "get_identity_quorum",
    "get_initialization_state",
    "get_insurance_pool",
    "get_invoice",
    "get_invoice_count",
    "get_max_oracle_age",
    "get_max_price_deviation_bps",
    "get_multisig_admin",
    "get_multisig_proposal",
    "get_oracle_for_token",
    "get_oracle_health",
    "get_oracle_status",
    "get_pending_payout",
    "get_pending_signer_rotation",
    "get_price_oracle",
    "get_price_sources",
    "get_protocol_status",
    "get_recent_admin_actions",
    "get_referral_stats",
    "get_reputation",
    "get_storage_version",
    "get_token_decimals",
    "get_top_payers",
    "get_twap_price",
    "get_twap_window",
    "get_version",
    "is_oracle_circuit_tripped",
    "is_paused",
    "is_twap_enabled",
    "list_invoices_by_lp",
    "list_invoices_by_submitter",
    "lp_score",
    "max_invoice_amount",
    "min_payer_reputation",
    "query_nft_metadata",
    "query_nft_owner",
    "token_volume_cap",
];

// ───────────────────────── helpers ─────────────────────────

/// `topic[0]` symbols of the events the invoice contract published.
fn emitted_topics(ctx: &TestContext) -> Vec<String> {
    ctx.env
        .events()
        .all()
        .filter_by_contract(&ctx.contract.address)
        .events()
        .iter()
        .filter_map(|e| match &e.body {
            ContractEventBody::V0(body) => body.topics.first().and_then(|t| match t {
                ScVal::Symbol(s) => Some(s.0.to_utf8_string_lossy()),
                _ => None,
            }),
        })
        .collect()
}

fn count(topics: &[String], topic: &str) -> usize {
    topics.iter().filter(|t| t.as_str() == topic).count()
}

/// Assert `topic` is present after the call under test, and that the setup did
/// not already emit it (otherwise the assertion would be vacuous).
fn assert_emits(ctx: &TestContext, before: &[String], topic: &str, entrypoint: &str) {
    assert_eq!(
        count(before, topic),
        0,
        "test setup already emitted `{topic}`; the `{entrypoint}` assertion would be vacuous"
    );
    let after = emitted_topics(ctx);
    assert!(
        count(&after, topic) >= 1,
        "`{entrypoint}` must emit `{topic}`; observed topics: {after:?}"
    );
}

/// Assert a *failed* call left no new `topic` event behind.
fn assert_no_new(ctx: &TestContext, before: &[String], topic: &str, what: &str) {
    let after = emitted_topics(ctx);
    assert!(
        count(&after, topic) <= count(before, topic),
        "{what} must not leave a `{topic}` event behind; observed topics: {after:?}"
    );
}

fn digest(byte: u8, ctx: &TestContext) -> BytesN<32> {
    BytesN::from_array(&ctx.env, &[byte; 32])
}

fn set_timestamp(ctx: &TestContext, timestamp: u64) {
    let mut info = ctx.env.ledger().get();
    info.timestamp = timestamp;
    ctx.env.ledger().set(info);
}

fn funded_invoice(ctx: &TestContext) -> u64 {
    let id = ctx.submit_invoice(AMOUNT, RATE, DUE_IN);
    ctx.fund_invoice(id);
    id
}

// ───────────────────────── ledger tests ─────────────────────────

#[test]
fn every_public_entrypoint_is_classified() {
    let start = LIB_SRC
        .find("impl InvoiceLiquidityContract {")
        .expect("contract impl block");
    let end = LIB_SRC.find("// TEST MODULES").expect("test module marker");
    let mut found: Vec<&str> = LIB_SRC[start..end]
        .lines()
        .filter_map(|l| l.trim_start().strip_prefix("pub fn "))
        .filter_map(|rest| {
            rest.split(|c: char| !(c.is_alphanumeric() || c == '_'))
                .next()
        })
        .collect();
    found.sort_unstable();
    found.dedup();

    let mut classified: Vec<&str> = MUTATING
        .iter()
        .map(|(n, _)| *n)
        .chain(READ_ONLY.iter().copied())
        .collect();
    classified.sort_unstable();
    let before_dedup = classified.len();
    classified.dedup();
    assert_eq!(
        before_dedup,
        classified.len(),
        "an entrypoint is listed as both mutating and read-only (or twice)"
    );

    let unclassified: Vec<&&str> = found.iter().filter(|n| !classified.contains(n)).collect();
    let stale: Vec<&&str> = classified.iter().filter(|n| !found.contains(n)).collect();
    assert!(
        unclassified.is_empty(),
        "new public entrypoint(s) {unclassified:?} must be added to MUTATING (with an event \
         test, a Gate or an Exempt reason) or READ_ONLY"
    );
    assert!(
        stale.is_empty(),
        "classified entrypoint(s) {stale:?} no longer exist in lib.rs"
    );
}

#[test]
fn every_here_entrypoint_has_a_behavioural_test() {
    for (name, coverage) in MUTATING {
        if *coverage == Coverage::Here {
            let needle = format!("fn {name}_emits");
            assert!(
                SELF_SRC.contains(&needle),
                "`{name}` is marked Coverage::Here but this file has no `{needle}*` test"
            );
        }
    }
}

#[test]
fn exempt_entrypoints_stay_documented() {
    let docs = include_str!("../../docs/events.md");
    for (name, coverage) in MUTATING {
        if *coverage == Coverage::Exempt {
            assert!(
                docs.contains(&format!("invoice_liquidity::{name}")),
                "exempt mutator `{name}` must keep its row in docs/events.md \"Known Gaps\""
            );
        }
    }
}

// ───────────────────────── behavioural tests ─────────────────────────

#[test]
fn initialize_emits_initialized() {
    // `TestContext::new()` initializes the contract and makes no later
    // contract call, so its events are the latest ones.
    let ctx = TestContext::new();
    let topics = emitted_topics(&ctx);
    assert_eq!(count(&topics, "initialized"), 1, "observed: {topics:?}");
}

#[test]
fn submit_invoice_emits_submitted_exactly() {
    let ctx = TestContext::new();
    let before = emitted_topics(&ctx);
    let id = ctx.submit_invoice(AMOUNT, RATE, DUE_IN);
    assert_emits(&ctx, &before, "submitted", "submit_invoice");

    // The exact-topic match must be precise: the reputation payload field
    // `invoices_submitted` must not be mistaken for the topic.
    let after = emitted_topics(&ctx);
    assert_eq!(count(&after, "submitted"), 1, "observed: {after:?}");
    assert!(ctx.contract.get_invoice(&id).id == id);
}

#[test]
fn update_invoice_emits_updated() {
    let ctx = TestContext::new();
    let id = ctx.submit_invoice(AMOUNT, RATE, DUE_IN);
    let before = emitted_topics(&ctx);
    let due = ctx.env.ledger().timestamp() + DUE_IN * 2;
    ctx.contract
        .update_invoice(&ctx.submitter, &id, &AMOUNT, &due, &200);
    assert_emits(&ctx, &before, "updated", "update_invoice");
}

#[test]
fn convert_invoice_token_emits_token_changed() {
    let ctx = TestContext::new();
    let id = ctx.submit_invoice(AMOUNT, RATE, DUE_IN);
    let before = emitted_topics(&ctx);
    ctx.contract
        .convert_invoice_token(&ctx.submitter, &id, &ctx.eurc.address);
    assert_emits(&ctx, &before, "token_changed", "convert_invoice_token");
}

#[test]
fn transfer_invoice_emits_transferred() {
    let ctx = TestContext::new();
    let id = ctx.submit_invoice(AMOUNT, RATE, DUE_IN);
    let before = emitted_topics(&ctx);
    let new_freelancer = Address::generate(&ctx.env);
    ctx.contract.transfer_invoice(&id, &new_freelancer);
    assert_emits(&ctx, &before, "transferred", "transfer_invoice");
}

#[test]
fn join_fund_queue_emits_fund_requested() {
    let ctx = TestContext::new();
    let id = ctx.submit_invoice(AMOUNT, RATE, DUE_IN);
    let before = emitted_topics(&ctx);
    ctx.contract.join_fund_queue(&ctx.lp, &id);
    assert_emits(&ctx, &before, "fund_requested", "join_fund_queue");
}

#[test]
fn resolve_fund_queue_emits_resolved_and_attempt() {
    let ctx = TestContext::new();
    let id = ctx.submit_invoice(AMOUNT, RATE, DUE_IN);
    ctx.contract.join_fund_queue(&ctx.lp, &id);

    let mut info = ctx.env.ledger().get();
    info.sequence_number += invoice_liquidity::constants::QUEUE_DELAY_LEDGERS + 1;
    ctx.env.ledger().set(info);

    let before = emitted_topics(&ctx);
    let winner = ctx.contract.resolve_fund_queue(&id);
    assert_eq!(winner, ctx.lp);
    assert_emits(&ctx, &before, "fund_queue_resolved", "resolve_fund_queue");
    let after = emitted_topics(&ctx);
    assert_eq!(
        count(&after, "queue_resolve_attempt"),
        1,
        "observed: {after:?}"
    );
}

#[test]
fn resolve_fund_queue_rejection_leaves_no_attempt_event() {
    // Failure behaviour: resolving before the maturity delay returns
    // `QueueNotMature`; the `success = false` attempt event published just
    // before the `Err` is discarded with the failed invocation (see
    // docs/event-topic-audit.md F3).
    let ctx = TestContext::new();
    let id = ctx.submit_invoice(AMOUNT, RATE, DUE_IN);
    ctx.contract.join_fund_queue(&ctx.lp, &id);
    let before = emitted_topics(&ctx);
    assert!(ctx.contract.try_resolve_fund_queue(&id).is_err());
    assert_no_new(
        &ctx,
        &before,
        "queue_resolve_attempt",
        "a premature resolve",
    );
    assert_no_new(&ctx, &before, "fund_queue_resolved", "a premature resolve");
}

#[test]
fn fund_invoice_emits_funded() {
    let ctx = TestContext::new();
    let id = ctx.submit_invoice(AMOUNT, RATE, DUE_IN);
    let before = emitted_topics(&ctx);
    ctx.fund_invoice(id);
    assert_emits(&ctx, &before, "funded", "fund_invoice");
    let after = emitted_topics(&ctx);
    assert_eq!(count(&after, "funded"), 1, "observed: {after:?}");
}

#[test]
fn transfer_lp_position_emits_lp_position_transferred() {
    let ctx = TestContext::new();
    let id = funded_invoice(&ctx);
    let before = emitted_topics(&ctx);
    let new_lp = Address::generate(&ctx.env);
    ctx.contract.transfer_lp_position(&id, &new_lp);
    assert_emits(
        &ctx,
        &before,
        "lp_position_transferred",
        "transfer_lp_position",
    );
}

#[test]
fn cancel_invoice_emits_cancelled_once_and_repeat_is_silent() {
    let ctx = TestContext::new();
    let id = ctx.submit_invoice(AMOUNT, RATE, DUE_IN);
    let before = emitted_topics(&ctx);
    ctx.contract.cancel_invoice(&id);
    assert_emits(&ctx, &before, "cancelled", "cancel_invoice");

    // Repeated call: rejected, and no second `cancelled` event.
    let mid = emitted_topics(&ctx);
    assert!(ctx.contract.try_cancel_invoice(&id).is_err());
    assert_no_new(&ctx, &mid, "cancelled", "a repeated cancel");
}

#[test]
fn expire_invoice_emits_expired() {
    let ctx = TestContext::new();
    let id = ctx.submit_invoice(AMOUNT, RATE, DUE_IN);
    let before = emitted_topics(&ctx);
    set_timestamp(&ctx, ctx.env.ledger().timestamp() + DUE_IN + 1);
    ctx.contract.expire_invoice(&id);
    assert_emits(&ctx, &before, "expired", "expire_invoice");
}

#[test]
fn expire_invoice_before_due_date_is_silent() {
    // Stale/early case: expiring a not-yet-due invoice is rejected, no event.
    let ctx = TestContext::new();
    let id = ctx.submit_invoice(AMOUNT, RATE, DUE_IN);
    let before = emitted_topics(&ctx);
    assert!(ctx.contract.try_expire_invoice(&id).is_err());
    assert_no_new(&ctx, &before, "expired", "an early expire");
}

#[test]
fn mark_paid_emits_partially_paid_then_paid() {
    let ctx = TestContext::new();
    let id = funded_invoice(&ctx);

    let before = emitted_topics(&ctx);
    ctx.contract.mark_paid(&id, &(AMOUNT / 2));
    assert_emits(&ctx, &before, "partially_paid", "mark_paid (partial)");

    let mid = emitted_topics(&ctx);
    ctx.contract.mark_paid(&id, &(AMOUNT - AMOUNT / 2));
    assert_emits(&ctx, &mid, "paid", "mark_paid (final)");
}

#[test]
fn claim_default_emits_defaulted() {
    let ctx = TestContext::new();
    let id = funded_invoice(&ctx);
    let before = emitted_topics(&ctx);
    set_timestamp(&ctx, ctx.env.ledger().timestamp() + DUE_IN + 1);
    ctx.contract.claim_default(&ctx.lp, &id);
    assert_emits(&ctx, &before, "defaulted", "claim_default");
}

#[test]
fn dispute_invoice_and_resolve_dispute_emit() {
    let ctx = TestContext::new();
    let id = funded_invoice(&ctx);

    let before = emitted_topics(&ctx);
    ctx.contract.dispute_invoice(&id, &digest(1, &ctx));
    assert_emits(&ctx, &before, "disputed", "dispute_invoice");

    let mid = emitted_topics(&ctx);
    ctx.contract.resolve_dispute(&id, &digest(2, &ctx), &2);
    assert_emits(&ctx, &mid, "dispute_resolved", "resolve_dispute");
}

#[test]
fn dispute_invoice_repeat_is_silent() {
    let ctx = TestContext::new();
    let id = funded_invoice(&ctx);
    ctx.contract.dispute_invoice(&id, &digest(1, &ctx));
    let before = emitted_topics(&ctx);
    assert!(ctx
        .contract
        .try_dispute_invoice(&id, &digest(3, &ctx))
        .is_err());
    assert_no_new(&ctx, &before, "disputed", "a repeated dispute");
}

#[test]
fn pause_and_unpause_emit() {
    let ctx = TestContext::new();
    let before = emitted_topics(&ctx);
    ctx.contract.pause();
    assert_emits(&ctx, &before, "paused", "pause");

    let mid = emitted_topics(&ctx);
    ctx.contract.unpause();
    assert_emits(&ctx, &mid, "unpaused", "unpause");
}

#[test]
fn paused_contract_rejects_submit_without_event() {
    let ctx = TestContext::new();
    ctx.contract.pause();
    let before = emitted_topics(&ctx);
    let due = ctx.env.ledger().timestamp() + DUE_IN;
    let res = ctx.contract.try_submit_invoice(
        &ctx.submitter,
        &ctx.payer,
        &AMOUNT,
        &due,
        &RATE,
        &ctx.usdc.address,
        &ReferralCode::None,
    );
    assert!(res.is_err());
    assert_no_new(&ctx, &before, "submitted", "a paused submit");
}

#[test]
fn set_admin_emits_admin_changed() {
    let ctx = TestContext::new();
    let before = emitted_topics(&ctx);
    ctx.contract.set_admin(&Address::generate(&ctx.env));
    assert_emits(&ctx, &before, "admin_changed", "set_admin");
}

#[test]
fn update_fee_rate_emits_parameter_updated() {
    let ctx = TestContext::new();
    let before = emitted_topics(&ctx);
    ctx.contract.update_fee_rate(&250);
    assert_emits(&ctx, &before, "parameter_updated", "update_fee_rate");
}

#[test]
fn set_min_payer_reputation_emits_parameter_updated() {
    let ctx = TestContext::new();
    let before = emitted_topics(&ctx);
    ctx.contract.set_min_payer_reputation(&10);
    assert_emits(
        &ctx,
        &before,
        "parameter_updated",
        "set_min_payer_reputation",
    );
}

#[test]
fn set_identity_quorum_emits_parameter_updated() {
    // Regression: this admin mutator used to change state silently
    // (docs/event-topic-audit.md F6).
    let ctx = TestContext::new();
    let before = emitted_topics(&ctx);
    ctx.contract.set_identity_quorum(&1);
    assert_emits(&ctx, &before, "parameter_updated", "set_identity_quorum");
}

#[test]
fn set_identity_quorum_rejection_is_silent() {
    // Failure behaviour: an out-of-range quorum is rejected and emits nothing.
    let ctx = TestContext::new();
    let before = emitted_topics(&ctx);
    assert!(ctx.contract.try_set_identity_quorum(&0).is_err());
    assert_no_new(&ctx, &before, "parameter_updated", "an invalid quorum");
}
