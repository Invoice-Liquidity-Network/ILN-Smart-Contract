#![cfg(test)]

//! Issue #1160 — custody, payout and refund accounting regressions.
//!
//! Every test here maps to a row of `docs/custody-and-payout-matrix.md`.
//! Unlike `test::setup()`, the contract is **not** pre-funded: every token it
//! holds arrived through one of its own entry points, so a balance delta is
//! an exact statement about what an entry point moved.

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::{Client as TokenClient, StellarAssetClient},
    Address, BytesN, Env, IntoVal, Val,
};

const AMOUNT: i128 = 1_000_000_000;
const DISCOUNT: u32 = 300;
const DUE_OFFSET: u64 = 60 * 60 * 24 * 30;
const FEE_BPS: u32 = 200;

struct Custody {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: TokenClient<'static>,
    admin: Address,
    freelancer: Address,
    payer: Address,
    lp: Address,
    lp2: Address,
}

fn setup() -> Custody {
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

    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let lp = Address::generate(&env);
    let lp2 = Address::generate(&env);
    let sac = StellarAssetClient::new(&env, &usdc);
    for who in [&payer, &lp, &lp2] {
        sac.mint(who, &(AMOUNT * 10));
    }

    let mut ledger = env.ledger().get();
    ledger.timestamp = 1_700_000_000;
    ledger.sequence_number = 100;
    env.ledger().set(ledger);

    Custody {
        token: TokenClient::new(&env, &usdc),
        env,
        contract,
        admin,
        freelancer,
        payer,
        lp,
        lp2,
    }
}

impl Custody {
    fn bal(&self, who: &Address) -> i128 {
        self.token.balance(who)
    }

    fn escrow(&self) -> i128 {
        self.token.balance(&self.contract.address)
    }

    fn submit_for(&self, payer: &Address) -> u64 {
        let due = self.env.ledger().timestamp() + DUE_OFFSET;
        self.contract.submit_invoice(
            &self.freelancer,
            payer,
            &AMOUNT,
            &due,
            &DISCOUNT,
            &self.token.address,
            &ReferralCode::None,
        )
    }

    fn submit(&self) -> u64 {
        self.submit_for(&self.payer)
    }

    /// Make only `who` able to sign the next call to `fn_name`.
    fn only_signer(&self, who: &Address, fn_name: &'static str, args: soroban_sdk::Vec<Val>) {
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
}

fn cost_of(amount: i128) -> i128 {
    amount - amount * DISCOUNT as i128 / 10_000
}

// ----------------------------------------------------------------
// Failed token transfers never leave a successful state (row C1/C2/C5)
// ----------------------------------------------------------------

#[test]
fn failed_lp_transfer_leaves_invoice_unfunded_and_freelancer_unpaid() {
    let t = setup();
    let id = t.submit();
    let broke_lp = Address::generate(&t.env);

    assert!(t
        .contract
        .try_fund_invoice(&broke_lp, &id, &AMOUNT, &false)
        .is_err());

    let invoice = t.contract.get_invoice(&id);
    assert_eq!(invoice.status, InvoiceStatus::Pending);
    assert_eq!(invoice.amount_funded, 0);
    assert_eq!(invoice.funder, None);
    assert_eq!(t.escrow(), 0);
    assert_eq!(t.bal(&t.freelancer), 0);
}

#[test]
fn failed_payer_transfer_leaves_invoice_funded_and_lp_unpaid() {
    let t = setup();
    let broke_payer = Address::generate(&t.env);
    let id = t.submit_for(&broke_payer);
    t.contract.fund_invoice(&t.lp, &id, &AMOUNT, &false);
    let lp_before = t.bal(&t.lp);

    assert!(t.contract.try_mark_paid(&id, &AMOUNT).is_err());

    let invoice = t.contract.get_invoice(&id);
    assert_eq!(invoice.status, InvoiceStatus::Funded);
    assert_eq!(invoice.amount_paid, 0);
    assert_eq!(t.bal(&t.lp), lp_before);
    assert_eq!(t.escrow(), 0);
}

// ----------------------------------------------------------------
// Repeated payout / refund calls pay at most once (rows C2/C3/C4/C6)
// ----------------------------------------------------------------

#[test]
fn settlement_pays_exactly_once_and_leaves_no_escrow() {
    let t = setup();
    t.contract.update_fee_rate(&FEE_BPS);
    let id = t.submit();
    t.contract.fund_invoice(&t.lp, &id, &AMOUNT, &false);
    assert_eq!(
        t.escrow(),
        0,
        "full funding forwards the LP's cost to the freelancer"
    );

    let lp_before = t.bal(&t.lp);
    let admin_before = t.bal(&t.admin);
    t.contract.mark_paid(&id, &AMOUNT);

    let fee = AMOUNT * FEE_BPS as i128 / 10_000;
    assert_eq!(t.bal(&t.admin) - admin_before, fee);
    assert_eq!(t.bal(&t.lp) - lp_before, AMOUNT - fee);
    assert_eq!(
        t.escrow(),
        0,
        "fee + LP shares equal exactly what the payer paid in"
    );

    assert_eq!(
        t.contract.try_mark_paid(&id, &AMOUNT),
        Err(Ok(ContractError::AlreadyPaid))
    );
    assert_eq!(t.bal(&t.lp) - lp_before, AMOUNT - fee);
    assert_eq!(t.bal(&t.admin) - admin_before, fee);
}

#[test]
fn split_settlement_never_distributes_more_than_collected() {
    let t = setup();
    t.contract.update_fee_rate(&FEE_BPS);
    let id = t.submit();
    // Odd split so per-funder integer division truncates.
    t.contract.fund_invoice(&t.lp, &id, &333_333_333, &false);
    t.contract
        .fund_invoice(&t.lp2, &id, &(AMOUNT - 333_333_333), &false);
    let escrow_before = t.escrow();

    t.contract.mark_paid(&id, &(AMOUNT / 2));
    assert_eq!(
        t.escrow() - escrow_before,
        AMOUNT / 2,
        "partial payment is held"
    );
    t.contract.mark_paid(&id, &(AMOUNT - AMOUNT / 2));

    // Whatever truncation leaves behind stays in the contract; nothing is
    // paid out beyond the payer's AMOUNT.
    let dust = t.escrow() - escrow_before;
    assert!(dust >= 0, "settlement paid out more than it collected");
    assert!(dust < 2, "truncation dust is at most one unit per funder");
}

#[test]
fn cancel_refunds_partial_funders_exactly_once() {
    let t = setup();
    let id = t.submit();
    let half = AMOUNT / 2;
    let lp_start = t.bal(&t.lp);
    t.contract.fund_invoice(&t.lp, &id, &half, &false);
    assert_eq!(t.escrow(), cost_of(half));

    t.contract.cancel_invoice(&id);
    assert_eq!(t.bal(&t.lp), lp_start, "LP gets back exactly what it paid");
    assert_eq!(t.escrow(), 0);

    assert_eq!(
        t.contract.try_cancel_invoice(&id),
        Err(Ok(ContractError::AlreadyCancelled))
    );
    assert_eq!(t.bal(&t.lp), lp_start);
}

#[test]
fn upheld_dispute_on_partial_funding_refunds_exactly_once() {
    let t = setup();
    let id = t.submit();
    let half = AMOUNT / 2;
    let lp_start = t.bal(&t.lp);
    t.contract.fund_invoice(&t.lp, &id, &half, &false);
    t.contract
        .dispute_invoice(&id, &BytesN::from_array(&t.env, &[7u8; 32]));

    let resolution = BytesN::from_array(&t.env, &[8u8; 32]);
    t.contract.resolve_dispute(&id, &resolution, &1);
    assert_eq!(t.bal(&t.lp), lp_start);
    assert_eq!(t.escrow(), 0);

    assert_eq!(
        t.contract.try_resolve_dispute(&id, &resolution, &1),
        Err(Ok(ContractError::NotDisputed))
    );
    assert_eq!(t.bal(&t.lp), lp_start);
}

#[test]
fn claim_yield_is_a_read_only_quote() {
    let t = setup();
    let id = t.submit();
    t.contract.fund_invoice(&t.lp, &id, &AMOUNT, &false);
    t.contract.mark_paid(&id, &AMOUNT);
    let lp_before = t.bal(&t.lp);
    let escrow_before = t.escrow();

    let first = t.contract.claim_yield(&id);
    let second = t.contract.claim_yield(&id);
    assert_eq!(first, second);
    assert_eq!(t.bal(&t.lp), lp_before, "claim_yield moves no tokens");
    assert_eq!(t.escrow(), escrow_before);
}

// ----------------------------------------------------------------
// Unauthorized payout / refund calls fail (rows C3/C4/C5/C7/C8)
// ----------------------------------------------------------------

#[test]
fn imposter_cannot_cancel_and_trigger_refunds() {
    let t = setup();
    let id = t.submit();
    t.contract.fund_invoice(&t.lp, &id, &(AMOUNT / 2), &false);
    let escrow_before = t.escrow();

    let imposter = Address::generate(&t.env);
    t.only_signer(&imposter, "cancel_invoice", (id,).into_val(&t.env));
    assert!(t.contract.try_cancel_invoice(&id).is_err());

    assert_eq!(
        t.contract.get_invoice(&id).status,
        InvoiceStatus::PartiallyFunded
    );
    assert_eq!(t.escrow(), escrow_before);
}

#[test]
fn imposter_cannot_settle_on_behalf_of_payer() {
    let t = setup();
    let id = t.submit();
    t.contract.fund_invoice(&t.lp, &id, &AMOUNT, &false);

    let imposter = Address::generate(&t.env);
    t.only_signer(&imposter, "mark_paid", (id, AMOUNT).into_val(&t.env));
    assert!(t.contract.try_mark_paid(&id, &AMOUNT).is_err());
    assert_eq!(t.contract.get_invoice(&id).status, InvoiceStatus::Funded);
}

#[test]
fn non_funder_cannot_claim_default() {
    let t = setup();
    let id = t.submit();
    t.contract.fund_invoice(&t.lp, &id, &AMOUNT, &false);
    let mut ledger = t.env.ledger().get();
    ledger.timestamp += DUE_OFFSET + 1;
    t.env.ledger().set(ledger);

    let outsider = Address::generate(&t.env);
    assert_eq!(
        t.contract.try_claim_default(&outsider, &id),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(t.contract.get_invoice(&id).status, InvoiceStatus::Funded);
    assert_eq!(t.bal(&outsider), 0);
}

#[test]
fn imposter_cannot_resolve_dispute_into_a_refund() {
    let t = setup();
    let id = t.submit();
    t.contract.fund_invoice(&t.lp, &id, &(AMOUNT / 2), &false);
    t.contract
        .dispute_invoice(&id, &BytesN::from_array(&t.env, &[7u8; 32]));
    let escrow_before = t.escrow();

    let imposter = Address::generate(&t.env);
    let resolution = BytesN::from_array(&t.env, &[8u8; 32]);
    t.only_signer(
        &imposter,
        "resolve_dispute",
        (id, resolution.clone(), 1_u32).into_val(&t.env),
    );
    assert!(t
        .contract
        .try_resolve_dispute(&id, &resolution, &1)
        .is_err());
    assert_eq!(t.contract.get_invoice(&id).status, InvoiceStatus::Disputed);
    assert_eq!(t.escrow(), escrow_before);
}

#[test]
fn imposter_cannot_redirect_an_lp_position() {
    let t = setup();
    let id = t.submit();
    t.contract.fund_invoice(&t.lp, &id, &AMOUNT, &false);

    let imposter = Address::generate(&t.env);
    t.only_signer(
        &imposter,
        "transfer_lp_position",
        (id, imposter.clone()).into_val(&t.env),
    );
    assert!(t.contract.try_transfer_lp_position(&id, &imposter).is_err());
    assert_eq!(t.contract.get_invoice(&id).funder, Some(t.lp.clone()));
}

// ----------------------------------------------------------------
// Pause blocks every path that moves tokens (row C10)
// ----------------------------------------------------------------

#[test]
fn pause_blocks_every_token_moving_entrypoint() {
    let t = setup();
    let pending = t.submit();
    let funded = t.submit();
    t.contract.fund_invoice(&t.lp, &funded, &AMOUNT, &false);
    let partial = t.submit();
    t.contract
        .fund_invoice(&t.lp, &partial, &(AMOUNT / 2), &false);

    t.contract.pause();
    let paused = Err(Ok(ContractError::ContractPaused));
    assert_eq!(
        t.contract
            .try_fund_invoice(&t.lp, &pending, &AMOUNT, &false),
        paused
    );
    assert_eq!(t.contract.try_mark_paid(&funded, &AMOUNT), paused);
    assert_eq!(t.contract.try_cancel_invoice(&partial), paused);
    assert_eq!(t.contract.try_claim_default(&t.lp, &funded), paused);
    assert_eq!(
        t.contract.try_claim_pending_payout(&t.lp, &t.token.address),
        Err(Ok(ContractError::ContractPaused))
    );

    t.contract.unpause();
    t.contract.fund_invoice(&t.lp, &pending, &AMOUNT, &false);
    assert_eq!(
        t.contract.get_invoice(&pending).status,
        InvoiceStatus::Funded
    );
}

// ----------------------------------------------------------------
// Protocol fee cannot exceed what settlement collects (finding F-01)
// ----------------------------------------------------------------

#[test]
fn fee_rate_above_one_hundred_percent_is_rejected_on_every_path() {
    let t = setup();
    let too_high = crate::constants::MAX_PROTOCOL_FEE_BPS + 1;

    assert_eq!(
        t.contract.try_update_fee_rate(&too_high),
        Err(Ok(ContractError::InvalidFeeRate))
    );

    let tiers = soroban_sdk::vec![&t.env, (0_i128, 100_u32), (AMOUNT, too_high)];
    assert_eq!(
        t.contract.try_update_fee_tiers(&tiers),
        Err(Ok(ContractError::InvalidFeeRate))
    );

    let signers = soroban_sdk::vec![&t.env, t.lp.clone(), t.lp2.clone()];
    t.contract.initialize_multisig_admin(&signers, &1);
    assert_eq!(
        t.contract.try_propose_set_fee_rate(&t.lp, &too_high),
        Err(Ok(ContractError::InvalidFeeRate))
    );

    assert_eq!(t.contract.get_fee_tiers().len(), 0);
}

#[test]
fn maximum_fee_settlement_pays_out_exactly_the_payment() {
    let t = setup();
    t.contract
        .update_fee_rate(&crate::constants::MAX_PROTOCOL_FEE_BPS);
    let id = t.submit();
    t.contract.fund_invoice(&t.lp, &id, &AMOUNT, &false);
    let admin_before = t.bal(&t.admin);
    let lp_before = t.bal(&t.lp);

    t.contract.mark_paid(&id, &AMOUNT);

    assert_eq!(t.bal(&t.admin) - admin_before, AMOUNT);
    assert_eq!(t.bal(&t.lp), lp_before);
    assert_eq!(
        t.escrow(),
        0,
        "a 100% fee still cannot reach other invoices' funds"
    );
}

#[test]
fn max_discount_cannot_exceed_the_submit_hard_cap() {
    let t = setup();
    let too_high = crate::constants::MAX_DISCOUNT_RATE + 1;
    assert_eq!(
        t.contract.try_update_max_discount(&too_high),
        Err(Ok(ContractError::InvalidDiscountRate))
    );

    let signers = soroban_sdk::vec![&t.env, t.lp.clone()];
    t.contract.initialize_multisig_admin(&signers, &1);
    assert_eq!(
        t.contract.try_propose_set_max_discount(&t.lp, &too_high),
        Err(Ok(ContractError::InvalidDiscountRate))
    );
}
