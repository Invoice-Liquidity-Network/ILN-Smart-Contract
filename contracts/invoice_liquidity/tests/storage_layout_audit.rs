//! Storage layout audit (see STORAGE_LAYOUT_OPTIMIZATION.md "Layout audit").
//!
//! Keeps the documented hot/cold split, storage version and rollback
//! assumptions consistent with the code.

use invoice_liquidity::{
    constants::CURRENT_STORAGE_VERSION, DataKey, InvoiceLiquidityContract,
    InvoiceLiquidityContractClient, ReferralCode,
};
use soroban_sdk::{testutils::Address as _, Address, Env};

const INVOICE_SRC: &str = include_str!("../src/invoice.rs");
const LAYOUT_DOC: &str = include_str!("../STORAGE_LAYOUT_OPTIMIZATION.md");

fn fields(name: &str) -> Vec<String> {
    let header = format!("pub struct {name} {{");
    let start = INVOICE_SRC.find(&header).expect("struct present");
    let body = &INVOICE_SRC[start + header.len()..];
    let body = &body[..body.find('}').expect("struct end")];
    let mut out: Vec<String> = body
        .lines()
        .map(str::trim)
        .filter_map(|l| l.strip_prefix("pub "))
        .filter_map(|l| l.find(':').map(|i| l[..i].trim().to_string()))
        .collect();
    out.sort();
    out
}

#[test]
fn invoice_is_exactly_core_plus_metadata() {
    let mut union = fields("InvoiceCore");
    union.extend(fields("InvoiceMetadata"));
    union.sort();
    let before = union.len();
    union.dedup();
    assert_eq!(before, union.len(), "a field is in both core and metadata");
    assert_eq!(union, fields("Invoice"));
}

#[test]
fn layout_doc_lists_every_field_with_its_tier() {
    for (name, tier) in [("InvoiceCore", "hot"), ("InvoiceMetadata", "cold")] {
        for f in fields(name) {
            let row = format!("| `{f}` | {tier} | `{name}(id)` |");
            assert!(LAYOUT_DOC.contains(&row), "doc is missing row: {row}");
        }
    }
}

#[test]
fn layout_doc_states_current_storage_version() {
    assert!(
        LAYOUT_DOC.contains(&format!("**Storage version: {CURRENT_STORAGE_VERSION}**")),
        "update STORAGE_LAYOUT_OPTIMIZATION.md when CURRENT_STORAGE_VERSION changes"
    );
}

#[test]
fn new_invoices_use_only_the_split_keys() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let client = InvoiceLiquidityContractClient::new(&env, &contract_id);
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let xlm = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    client.initialize(&Address::generate(&env), &token, &token, &xlm);

    let due = env.ledger().timestamp() + 1_000;
    let id = client.submit_invoice(
        &Address::generate(&env),
        &Address::generate(&env),
        &1_000_000_000,
        &due,
        &300,
        &token,
        &ReferralCode::None,
    );

    env.as_contract(&contract_id, || {
        let s = env.storage().persistent();
        assert!(s.has(&DataKey::InvoiceCore(id)));
        assert!(s.has(&DataKey::InvoiceMetadata(id)));
        // Rollback assumption (audit item 3): no legacy copy is written.
        assert!(!s.has(&DataKey::Invoice(id)));
    });
}
