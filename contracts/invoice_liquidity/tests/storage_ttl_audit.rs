//! Storage TTL audit (see docs/storage-ttl-audit.md).
//!
//! Pins which persistent records get an explicit `extend_ttl` and which rely on
//! the network default, using only the public contract API and `DataKey`.

use invoice_liquidity::{
    DataKey, InvoiceLiquidityContract, InvoiceLiquidityContractClient, ReferralCode,
};
use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Address, Env};

const AMOUNT: i128 = 1_000_000_000;
/// `save_invoice` extends to 2_000_000 when below 1_000_000 (storage.rs).
const INVOICE_TTL_THRESHOLD: u32 = 1_000_000;

struct Fixture {
    env: Env,
    contract_id: Address,
    client: InvoiceLiquidityContractClient<'static>,
    token: Address,
    freelancer: Address,
    payer: Address,
    lp: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let client = InvoiceLiquidityContractClient::new(&env, &contract_id);

    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let token = sac.address();
    let xlm = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    client.initialize(&Address::generate(&env), &token, &token, &xlm);

    let lp = Address::generate(&env);
    StellarAssetClient::new(&env, &token).mint(&lp, &(AMOUNT * 10));
    StellarAssetClient::new(&env, &token).mint(&contract_id, &(AMOUNT * 10));

    Fixture {
        client,
        contract_id,
        token,
        freelancer: Address::generate(&env),
        payer: Address::generate(&env),
        lp,
        env,
    }
}

fn submit(f: &Fixture) -> u64 {
    let due = f.env.ledger().timestamp() + 1_000;
    f.client.submit_invoice(
        &f.freelancer,
        &f.payer,
        &AMOUNT,
        &due,
        &300,
        &f.token,
        &ReferralCode::None,
    )
}

fn ttl(f: &Fixture, key: &DataKey) -> u32 {
    f.env
        .as_contract(&f.contract_id, || f.env.storage().persistent().get_ttl(key))
}

#[test]
fn invoice_core_and_metadata_ttl_are_extended_on_submit() {
    let f = setup();
    let id = submit(&f);
    assert!(ttl(&f, &DataKey::InvoiceCore(id)) >= INVOICE_TTL_THRESHOLD);
    assert!(ttl(&f, &DataKey::InvoiceMetadata(id)) >= INVOICE_TTL_THRESHOLD);
    // Lookup still resolves the reassembled invoice.
    assert_eq!(f.client.get_invoice(&id).id, id);
}

#[test]
fn invoice_ttl_is_extended_again_on_every_state_write() {
    let f = setup();
    let id = submit(&f);
    f.client.fund_invoice(&f.lp, &id, &AMOUNT, &false);
    assert!(ttl(&f, &DataKey::InvoiceCore(id)) >= INVOICE_TTL_THRESHOLD);
    assert!(ttl(&f, &DataKey::InvoiceMetadata(id)) >= INVOICE_TTL_THRESHOLD);
}

#[test]
fn missing_invoice_lookup_fails_cleanly_instead_of_trapping() {
    let f = setup();
    assert!(f.client.try_get_invoice(&9_999).is_err());
}

/// KNOWN GAP (docs/storage-ttl-audit.md F1): `save_invoice_funders` writes the
/// funder list without `extend_ttl`, so it keeps only the network default
/// while the invoice record it belongs to lives ~2M ledgers. When this
/// assertion starts failing because the funders TTL was fixed, flip it to
/// `>= INVOICE_TTL_THRESHOLD` and update the audit doc.
#[test]
fn invoice_funders_ttl_is_not_extended_known_gap() {
    let f = setup();
    let id = submit(&f);
    f.client.fund_invoice(&f.lp, &id, &AMOUNT, &false);
    assert!(ttl(&f, &DataKey::InvoiceFunders(id)) < INVOICE_TTL_THRESHOLD);
}
