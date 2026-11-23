#![cfg(test)]

//! Event topic / payload stability audit for `events.rs`.
//!
//! Soroban events are an *external API*: indexers, the SDK and dashboards key
//! off the first topic symbol and decode the payload by shape. These tests pin
//! that surface by scanning the contract sources (no scenario setup, so they
//! are fast and deterministic):
//!
//! * every `env.events().publish(..)` site, the topic symbol it uses and the
//!   payload type it carries (a rename, a removed event or a topic silently
//!   re-pointed at a different payload fails here);
//! * a topic never carries two different payload types, and a payload type is
//!   never published under two different topics (topics uniquely identify a
//!   schema);
//! * the field list of every invoice-lifecycle payload, so a ledger field
//!   (`invoice_id`, amounts, parties, status, timestamps) cannot be dropped or
//!   renamed without updating this audit and `docs/event-topic-audit.md`;
//! * the set of event structs that are declared in `events.rs` but are never
//!   published (dead schema), so it cannot grow unnoticed.
//!
//! See `docs/event-topic-audit.md` for the verified findings and the residual
//! risks that these tests intentionally do not change.

use std::collections::{BTreeMap, BTreeSet};
use std::string::{String, ToString};
use std::vec::Vec;

const EVENTS_SRC: &str = include_str!("events.rs");

/// Every source file that may contain an event publish site (test files are
/// excluded on purpose).
const PUBLISHING_SOURCES: [(&str, &str); 9] = [
    ("lib.rs", include_str!("lib.rs")),
    ("oracle_registry.rs", include_str!("oracle_registry.rs")),
    ("nft.rs", include_str!("nft.rs")),
    ("token_safety.rs", include_str!("token_safety.rs")),
    ("config.rs", include_str!("config.rs")),
    ("invoice.rs", include_str!("invoice.rs")),
    ("multisig.rs", include_str!("multisig.rs")),
    ("access.rs", include_str!("access.rs")),
    ("storage.rs", include_str!("storage.rs")),
];

/// Payload label used when a publish site passes a bare tuple/scalar instead
/// of a named `#[contracttype]` struct.
const UNTYPED: &str = "(untyped)";

/// How many bytes after `.publish(` are inspected for the topic + payload.
const PUBLISH_WINDOW: usize = 700;

/// `(topic, payload type, number of publish sites)`.
///
/// Adding a publish site, renaming a topic, or pointing a topic at another
/// payload type requires updating this table (and the audit doc) on purpose.
const EXPECTED_PUBLISH_SITES: &[(&str, &str, u32)] = &[
    ("admin_changed", "AdminChanged", 1),
    ("appeal_resolved", "AppealResolved", 1),
    ("cancelled", "InvoiceCancelled", 1),
    ("default_appealed", "DefaultAppealed", 1),
    ("defaulted", "InvoiceDefaulted", 1),
    ("dispute_resolved", "DisputeResolved", 2),
    ("dispute_upheld_payer_refund", "DisputeUpheldPayerRefund", 1),
    ("disputed", "InvoiceDisputed", 1),
    (
        "distribution_contract_updated",
        "DistributionContractUpdated",
        1,
    ),
    ("expired", "InvoiceExpired", 2),
    ("fee_tiers_updated", "(untyped)", 1),
    ("fund_queue_displaced", "FundQueueEntryDisplaced", 1),
    ("fund_queue_recovered", "FundQueueRecovered", 2),
    ("fund_queue_resolved", "FundQueueResolved", 1),
    ("fund_queue_tie_broken", "FundQueueTieBroken", 1),
    ("fund_requested", "FundRequested", 1),
    ("funded", "InvoiceFunded", 1),
    ("identity_oracle_added", "IdentityOracleAdded", 1),
    ("identity_oracle_removed", "IdentityOracleRemoved", 1),
    ("initialized", "ContractInitialized", 1),
    ("insurance_claim_attempted", "InsuranceClaimAttempted", 1),
    ("invoice_nft_burned", "InvoiceNftBurned", 1),
    ("invoice_nft_minted", "InvoiceNftMinted", 1),
    ("invoice_nft_transferred", "InvoiceNftTransferred", 1),
    ("lp_position_transferred", "LPPositionTransferred", 1),
    ("migrated", "(untyped)", 1),
    ("oracle_circuit_recovered", "OracleCircuitRecovered", 1),
    ("oracle_circuit_reset", "OracleCircuitReset", 1),
    ("oracle_circuit_tripped", "OracleCircuitTripped", 1),
    ("oracle_feeder_disagreement", "OracleFeederDisagreement", 1),
    ("oracle_health_recorded", "OracleHealthRecorded", 1),
    ("oracle_registered", "OracleRegistered", 2),
    ("oracle_removed", "OracleUnregistered", 2),
    ("oracle_stale_data_rejected", "OracleDataStaleRejected", 1),
    ("paid", "InvoicePaid", 1),
    ("parameter_updated", "ParameterUpdated", 12),
    ("partially_paid", "InvoicePartiallyPaid", 1),
    ("paused", "ContractPaused", 2),
    ("payout_escrowed", "PayoutEscrowed", 1),
    ("pending_payout_claimed", "PendingPayoutClaimed", 1),
    ("price_oracle_updated", "PriceOracleUpdated", 1),
    ("price_outlier_rejected", "PriceOutlierRejected", 1),
    ("price_source_added", "PriceSourceAdded", 1),
    ("price_source_removed", "PriceSourceRemoved", 1),
    ("queue_resolve_attempt", "FundQueueResolutionAttempted", 3),
    ("reputation_updated", "ReputationUpdated", 1),
    ("rollback_rehearsal", "RollbackRehearsalCompleted", 1),
    ("signer_rotation_cancelled", "SignerRotationCancelled", 1),
    ("signer_rotation_finalized", "SignerRotationFinalized", 1),
    ("signer_rotation_scheduled", "SignerRotationScheduled", 1),
    ("submitted", "InvoiceSubmitted", 2),
    ("token_added", "TokenAdded", 1),
    ("token_changed", "InvoiceTokenChanged", 1),
    ("token_decimals_corrected", "TokenDecimalsCorrected", 1),
    ("token_removed", "TokenRemoved", 2),
    ("transferred", "InvoiceTransferred", 1),
    ("twap_enabled", "TwapEnabledForFeed", 1),
    ("twap_insufficient_data", "TwapInsufficientData", 1),
    ("twap_window_updated", "TwapWindowUpdated", 1),
    ("unpaused", "ContractUnpaused", 2),
    ("updated", "InvoiceUpdated", 1),
    ("upgraded", "ContractUpgraded", 1),
];

/// Event structs declared in `events.rs` that no code path constructs, i.e.
/// they are part of the declared schema but are never emitted. Verified
/// finding — see `docs/event-topic-audit.md` §"Declared but never published".
const EXPECTED_UNPUBLISHED: &[&str] = &[
    "EqualScoreManipulationSimulated",
    "EvidenceRejected",
    "EvidenceSubmitted",
    "EvidenceVerified",
    "InsuranceCompensationFailed",
    "QueueTieScoreMarginUpdated",
];

/// Field lists (sorted) of the invoice-scoped lifecycle payloads. Every one of
/// them must keep `invoice_id` so an indexer can correlate it to the ledger
/// record.
const INVOICE_SCOPED_FIELDS: &[(&str, &[&str])] = &[
    (
        "InvoiceSubmitted",
        &[
            "amount",
            "discount_rate",
            "due_date",
            "freelancer",
            "invoice_id",
            "payer",
            "referral_code",
            "status",
            "timestamp",
            "token",
        ],
    ),
    (
        "InvoiceUpdated",
        &[
            "amount",
            "discount_rate",
            "due_date",
            "freelancer",
            "invoice_id",
            "payer",
            "status",
            "token",
        ],
    ),
    (
        "InvoiceFunded",
        &[
            "amount_funded",
            "discount_rate",
            "due_date",
            "effective_yield_bps",
            "freelancer",
            "fund_amount",
            "funded_at",
            "funder",
            "invoice_amount",
            "invoice_id",
            "lp",
            "payer",
            "status",
            "timestamp",
            "token",
        ],
    ),
    (
        "InvoicePaid",
        &[
            "amount_paid",
            "freelancer",
            "invoice_id",
            "lp",
            "lp_earned",
            "lp_payout",
            "paid_on_time",
            "payer",
            "settlement_timestamp",
            "status",
            "token",
        ],
    ),
    (
        "InvoicePartiallyPaid",
        &[
            "amount_paid_now",
            "invoice_id",
            "payer",
            "remaining_amount",
            "total_amount_paid",
        ],
    ),
    (
        "InvoiceDefaulted",
        &[
            "amount",
            "defaulted_at",
            "discount_amount",
            "due_date",
            "freelancer",
            "funder",
            "invoice_id",
            "payer",
            "status",
            "token",
        ],
    ),
    (
        "InvoiceTransferred",
        &["invoice_id", "new_freelancer", "old_freelancer", "status"],
    ),
    ("InvoiceCancelled", &["freelancer", "invoice_id", "status"]),
    ("InvoiceExpired", &["freelancer", "invoice_id", "status"]),
    (
        "LPPositionTransferred",
        &["invoice_id", "new_lp", "old_lp", "status"],
    ),
    (
        "InvoiceTokenChanged",
        &["invoice_id", "new_token", "old_token"],
    ),
    (
        "DefaultAppealed",
        &["appealed_at", "evidence_hash", "invoice_id", "payer"],
    ),
    (
        "AppealResolved",
        &["invoice_id", "payer", "resolved_at", "upheld"],
    ),
    (
        "InvoiceDisputed",
        &["disputed_at", "invoice_id", "payer", "reason_hash"],
    ),
    (
        "DisputeResolved",
        &["invoice_id", "resolution", "resolution_hash", "resolved_at"],
    ),
    (
        "DisputeUpheldPayerRefund",
        &["amount", "invoice_id", "payer"],
    ),
    ("FundRequested", &["invoice_id", "lp", "score"]),
    ("FundQueueResolved", &["approved_lp", "invoice_id", "score"]),
    (
        "PayoutEscrowed",
        &[
            "amount",
            "invoice_id",
            "recipient",
            "token",
            "total_pending",
        ],
    ),
    (
        "InvoiceNftMinted",
        &["amount", "due_date", "invoice_id", "owner", "timestamp"],
    ),
    (
        "InvoiceNftTransferred",
        &["from", "invoice_id", "timestamp", "to"],
    ),
    ("InvoiceNftBurned", &["invoice_id", "owner", "timestamp"]),
];

/// Non-invoice-scoped payloads whose field lists are also pinned.
const OTHER_FIELDS: &[(&str, &[&str])] = &[
    (
        "ParameterUpdated",
        &["new_value", "old_value", "param_name", "updated_by"],
    ),
    ("AdminChanged", &["new_admin", "old_admin", "timestamp"]),
    ("TokenAdded", &["decimals", "token"]),
    ("TokenRemoved", &["token"]),
];

fn is_ident_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Scan one source file for `.publish(` sites; returns `(topic, payload)`.
fn scan_publish_sites(file: &str, src: &str) -> Vec<(String, String)> {
    let bytes = src.as_bytes();
    let needle = b".publish(";
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + needle.len() <= bytes.len() {
        if &bytes[i..i + needle.len()] != needle {
            i += 1;
            continue;
        }
        let end = core::cmp::min(bytes.len(), i + PUBLISH_WINDOW);
        let window = String::from_utf8_lossy(&bytes[i..end]).into_owned();
        let k = window
            .find("Symbol::new(")
            .unwrap_or_else(|| panic!("{file}: publish site at byte {i} has no Symbol::new topic"));
        let after = &window[k + "Symbol::new(".len()..];
        let q1 = after.find('"').expect("topic literal start");
        let rest = &after[q1 + 1..];
        let q2 = rest.find('"').expect("topic literal end");
        let topic = rest[..q2].to_string();
        let tail = &rest[q2 + 1..];
        let payload = match tail.find('{') {
            None => UNTYPED.to_string(),
            Some(b) => {
                let pre = tail[..b].trim_end();
                let ident: String = pre
                    .chars()
                    .rev()
                    .take_while(|c| is_ident_char(*c))
                    .collect::<Vec<char>>()
                    .into_iter()
                    .rev()
                    .collect();
                if ident.is_empty() {
                    UNTYPED.to_string()
                } else {
                    ident
                }
            }
        };
        out.push((topic, payload));
        i += needle.len();
    }
    out
}

fn all_publish_sites() -> BTreeMap<(String, String), u32> {
    let mut map: BTreeMap<(String, String), u32> = BTreeMap::new();
    for (file, src) in PUBLISHING_SOURCES.iter() {
        for site in scan_publish_sites(file, src) {
            *map.entry(site).or_insert(0) += 1;
        }
    }
    map
}

/// Names of every `pub struct` declared in `events.rs`.
fn declared_event_structs() -> Vec<String> {
    let mut names = Vec::new();
    for line in EVENTS_SRC.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("pub struct ") {
            let name: String = rest.chars().take_while(|c| is_ident_char(*c)).collect();
            if !name.is_empty() {
                names.push(name);
            }
        }
    }
    names
}

/// Sorted `pub` field names of a struct declared in `events.rs`.
fn struct_fields(name: &str) -> Vec<String> {
    let header = std::format!("pub struct {name} {{");
    let start = EVENTS_SRC
        .find(&header)
        .unwrap_or_else(|| panic!("struct {name} not found in events.rs"));
    let body = &EVENTS_SRC[start + header.len()..];
    let end = body.find('}').expect("struct body end");
    let mut fields: Vec<String> = body[..end]
        .lines()
        .map(|l| l.trim())
        .filter(|l| l.starts_with("pub "))
        .filter_map(|l| {
            let l = l.trim_start_matches("pub ");
            l.find(':').map(|c| l[..c].trim().to_string())
        })
        .collect();
    fields.sort();
    fields
}

#[test]
fn publish_sites_match_pinned_topic_registry() {
    let found = all_publish_sites();
    let expected: BTreeMap<(String, String), u32> = EXPECTED_PUBLISH_SITES
        .iter()
        .map(|(t, p, n)| ((t.to_string(), p.to_string()), *n))
        .collect();
    assert_eq!(
        found, expected,
        "event publish sites drifted from the pinned registry: update \
         EXPECTED_PUBLISH_SITES and docs/event-topic-audit.md deliberately"
    );
}

#[test]
fn a_topic_never_carries_two_payload_types() {
    let mut by_topic: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for ((topic, payload), _) in all_publish_sites() {
        by_topic.entry(topic).or_default().insert(payload);
    }
    for (topic, payloads) in by_topic {
        assert_eq!(
            payloads.len(),
            1,
            "topic `{topic}` is published with multiple payload types: {payloads:?}"
        );
    }
}

#[test]
fn a_typed_payload_is_never_published_under_two_topics() {
    let mut by_payload: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for ((topic, payload), _) in all_publish_sites() {
        if payload != UNTYPED {
            by_payload.entry(payload).or_default().insert(topic);
        }
    }
    for (payload, topics) in by_payload {
        assert_eq!(
            topics.len(),
            1,
            "payload `{payload}` is published under multiple topics: {topics:?}"
        );
    }
}

#[test]
fn every_published_payload_is_declared_in_events_rs_or_is_untyped() {
    let declared: BTreeSet<String> = declared_event_structs().into_iter().collect();
    for ((topic, payload), _) in all_publish_sites() {
        if payload == UNTYPED {
            continue;
        }
        assert!(
            declared.contains(&payload),
            "topic `{topic}` publishes `{payload}` which is not declared in events.rs"
        );
    }
}

#[test]
fn declared_but_unpublished_events_are_pinned() {
    let mut unpublished: Vec<String> = declared_event_structs()
        .into_iter()
        .filter(|name| {
            let ctor = std::format!("{name} {{");
            !PUBLISHING_SOURCES
                .iter()
                .any(|(_, src)| src.contains(&ctor))
        })
        .collect();
    unpublished.sort();
    let expected: Vec<String> = EXPECTED_UNPUBLISHED.iter().map(|s| s.to_string()).collect();
    assert_eq!(
        unpublished, expected,
        "the set of declared-but-never-emitted event structs changed: either wire \
         the new event up, remove it, or update EXPECTED_UNPUBLISHED and the audit doc"
    );
}

#[test]
fn lifecycle_payload_fields_are_stable_and_carry_invoice_id() {
    for (name, expected) in INVOICE_SCOPED_FIELDS {
        let fields = struct_fields(name);
        let expected: Vec<String> = expected.iter().map(|s| s.to_string()).collect();
        assert_eq!(fields, expected, "field list of `{name}` changed");
        assert!(
            fields.iter().any(|f| f == "invoice_id"),
            "invoice-scoped payload `{name}` must carry `invoice_id`"
        );
    }
}

#[test]
fn shared_topic_payload_fields_are_stable() {
    for (name, expected) in OTHER_FIELDS {
        let fields = struct_fields(name);
        let expected: Vec<String> = expected.iter().map(|s| s.to_string()).collect();
        assert_eq!(fields, expected, "field list of `{name}` changed");
    }
}

#[test]
fn parameter_updated_param_names_are_emitted_by_literal() {
    // `parameter_updated` is a shared topic (12 publish sites); the payload's
    // `param_name` is the discriminator, so each governance parameter must keep
    // its own stable literal name.
    let lib = PUBLISHING_SOURCES[0].1;
    for name in [
        "protocol_fee_rate_bps",
        "max_discount_rate_bps",
        "max_oracle_age_ledgers",
        "max_invoice_amount",
    ] {
        let literal = std::format!("Symbol::new(&env, \"{name}\")");
        assert!(
            lib.contains(&literal),
            "parameter name `{name}` is no longer emitted via ParameterUpdated"
        );
    }
}
