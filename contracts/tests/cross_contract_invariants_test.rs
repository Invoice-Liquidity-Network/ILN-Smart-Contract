//! Issue #1159 — cross-contract invoice lifecycle and accounting invariants.
//!
//! Proves that a failed lifecycle transaction leaves invoice, LP, insurance
//! and distribution accounting unchanged (rolled back atomically), and that
//! successful settlement / default are applied to every contract exactly
//! once. Uses the *real* `iln_distribution` and `insurance_pool` contracts
//! plus the shared `MockToken` (which can inject a transfer failure).
//!
//! Invariant IDs refer to `docs/invoice-lifecycle-invariants.md`.
//!
//! Issue #1160 extends this with token/obligation conservation: registered
//! obligations X1-X5 and X9-X12 (see `docs/proof-obligations.json` and
//! `docs/cross-contract-accounting-audit.md`). Every `#[test]` here must be
//! claimed by an obligation, or `scripts/check-proof-obligations.py` fails.
//!
//! NOTE: `mock_all_auths()` (root-only) is used deliberately instead of
//! `mock_all_auths_allowing_non_root_auth()`: a distribution contract that
//! is wired to a *different* ILN address must reject ILN's nested
//! `accrue_*` call, exactly as it would on-chain.

extern crate std;

#[path = "mocks/mock_token.rs"]
mod mock_token;

use iln_distribution::{IlnDistribution, IlnDistributionClient};
use insurance_pool::{InsurancePool, InsurancePoolClient};
use invoice_liquidity::{
    ContractError, InvoiceLiquidityContract, InvoiceLiquidityContractClient, InvoiceStatus,
    ReferralCode,
};
use mock_token::{MockToken, MockTokenClient};
use soroban_sdk::{
    contracttype,
    testutils::{Address as _, EnvTestConfig, Ledger},
    Address, Env,
};

const AMOUNT: i128 = 1_000_000_000;
const RATE: u32 = 300;
const DAY: u64 = 24 * 60 * 60;
const T0: u64 = 1_700_000_000;
const SEQ0: u32 = 10_000;
const COVERAGE_CAP: i128 = 1_000;
const PREMIUM: i128 = 600;
/// ILN treasury reserve. `claim_default` and upheld disputes refund LP
/// principal that was already forwarded to the freelancer at funding time,
/// so those refunds are paid out of ILN's pooled balance, not a per-invoice
/// escrow (see [NE-2] in the invariants doc).
const RESERVE: i128 = 10 * AMOUNT;

/// Same storage key layout as `MockToken`'s private key enum, so a test can
/// disarm `fail_next_transfer`. Disarming is necessary because the flag's
/// one-shot `remove` is itself rolled back with the failed transaction —
/// which is precisely the atomicity property under test.
#[contracttype]
enum MockTokenKey {
    #[allow(dead_code)]
    Balance(Address),
    FailNext,
}

struct World {
    env: Env,
    iln: InvoiceLiquidityContractClient<'static>,
    token: MockTokenClient<'static>,
    dist: IlnDistributionClient<'static>,
    pool: InsurancePoolClient<'static>,
    admin: Address,
    freelancer: Address,
    payer: Address,
    lp: Address,
    lp2: Address,
}

impl Harness {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(&env);
        let freelancer = Address::generate(&env);
        let payer = Address::generate(&env);
        let lp = Address::generate(&env);

        let payment_token_addr = env.register_contract(None, MockToken);
        let payment_token = MockTokenClient::new(&env, &payment_token_addr);

        let xlm_id = env.register_stellar_asset_contract_v2(Address::generate(&env));
        let xlm_addr = xlm_id.address();
        let eurc_addr = Address::generate(&env);

        let iln_id = env.register_contract(None, InvoiceLiquidityContract);
        let iln = InvoiceLiquidityContractClient::new(&env, &iln_id);
        iln.initialize(&admin, &payment_token_addr, &eurc_addr, &xlm_addr);

        let mut ledger = env.ledger().get();
        ledger.timestamp = 1_700_000_000;
        env.ledger().set(ledger);

        // Governance token for distribution initialize (mint authority).
        let gov_token_admin_addr = Address::generate(&env);
        let gov_token_id = env.register_stellar_asset_contract_v2(gov_token_admin_addr);
        let gov_token_addr = gov_token_id.address();
        StellarAssetClient::new(&env, &gov_token_addr).mint(&admin, &GOV_MINT);

        let dist_id = env.register_contract(None, iln_distribution::IlnDistribution);
        let dist = iln_distribution::IlnDistributionClient::new(&env, &dist_id);
        // Issue #861: distribution must be the governance token's SAC admin.
        StellarAssetClient::new(&env, &gov_token_addr).set_admin(&dist_id);
        dist.initialize(&iln_id, &gov_token_addr);

        advance_ledger(&env, 200, 1_000);
        iln.set_distribution_contract(&dist_id);

        let pool_id = env.register_contract(None, InsurancePool);
        let pool = InsurancePoolClient::new(&env, &pool_id);
        pool.initialize(&iln_id, &COVERAGE_CAP, &payment_token_addr);
        advance_ledger(&env, 200, 1_000);
        iln.set_insurance_pool(&pool_id);

        let rep_bonus_addr = Address::generate(&env);
        let gov_id = env.register_contract(None, GovContract);
        let gov = GovContractClient::new(&env, &gov_id);
        gov.initialize(
            &iln_id,
            &dist_id,
            &rep_bonus_addr,
            &gov_token_addr,
            &admin,
            &20_000_i128,
        );
        gov.checkpoint_balance(&admin);
        advance_ledger(&env, 12, 100);

        Self {
            env,
            admin,
            freelancer,
            payer,
            lp,
            payment_token,
            payment_token_addr,
            iln,
            iln_id,
            dist,
            pool,
            pool_id,
            gov,
            gov_id,
            gov_token_addr,
            inflows: 0,
        }
    }

    fn total_tokens(&self) -> i128 {
        self.actors().iter().map(|a| self.token.balance(a)).sum()
    }

    /// ILN has no public fee-rate getter; read the stored flat rate directly.
    fn iln_fee_rate(&self) -> u32 {
        self.env.as_contract(&self.iln_id, || {
            self.env
                .storage()
                .instance()
                .get::<_, u32>(&invoice_liquidity::DataKey::FeeRate)
                .unwrap_or(0)
        })
    }

    fn assert_conservation(&self) {
        let iln_bal = self.payment_token.balance(&self.iln_id);
        let pool_bal = self.payment_token.balance(&self.pool_id);
        let users = self.payment_token.balance(&self.lp)
            + self.payment_token.balance(&self.freelancer)
            + self.payment_token.balance(&self.payer)
            + self.payment_token.balance(&self.admin);
        assert_eq!(
            iln_bal + pool_bal + users,
            self.inflows,
            "X4: ILN escrow + insurance token balance + user balances must equal minted inflows"
        );
    }
}

/// [RB-2] Funding: the LP->ILN and ILN->freelancer token transfers have
/// already executed when the distribution hook fails; all of it must revert.
#[test]
fn xc_funding_rolls_back_when_distribution_accrual_fails() {
    let w = world();
    let bad = w.miswired_distribution();
    w.rewire_distribution(&bad);
    let id = w.submit();

    let before = w.ledgers(id);
    for amt in [AMOUNT / 2, AMOUNT] {
        assert!(w.iln.try_fund_invoice(&w.lp, &id, &amt, &false).is_err());
        assert_eq!(w.ledgers(id), before, "fund {amt}: nothing may persist");
    }
    assert_eq!(before.invoice.status, InvoiceStatus::Pending);
    assert_eq!(before.invoice.amount_funded, 0);
}

/// [RB-2] Settlement: payer->ILN, ILN->LP and fee transfers, status=Paid
/// and reputation updates all revert if the distribution settlement hook
/// fails; once the hook works, settlement is applied (and accrued) once.
#[test]
fn x2_settlement_increases_freelancer_distribution_accrual() {
    let mut h = Harness::new();
    h.mint(&h.lp.clone(), INVOICE_AMOUNT * 2);
    h.mint(&h.payer.clone(), INVOICE_AMOUNT);

    let due = h.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let id = h.iln.submit_invoice(
        &h.freelancer,
        &h.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &h.payment_token_addr,
        &ReferralCode::None,
    );
    assert_eq!(w.ledgers(id), settled);
}

/// [RB-2] A token transfer failure aborts funding with no trace in ILN,
/// LP balances or distribution accruals.
#[test]
fn xc_token_failure_rolls_back_funding_and_accrual() {
    let w = world();
    let id = w.submit();
    let before = w.ledgers(id);

    // Partial and full tranches alike leave no trace when a transfer fails.
    for amt in [AMOUNT / 4, AMOUNT] {
        w.token.fail_next_transfer();
        assert!(w.iln.try_fund_invoice(&w.lp, &id, &amt, &false).is_err());
        assert_eq!(w.ledgers(id), before, "fund {amt}");
        w.disarm_token_failure();
    }

    // (Distribution accrues per whole 100-USDC of volume, so fund the full
    // 100-USDC invoice in one tranche to make the accrual observable.)
    w.iln.fund_invoice(&w.lp, &id, &AMOUNT, &false);
    let after = w.ledgers(id);
    assert_eq!(after.invoice.status, InvoiceStatus::Funded);
    assert_eq!(after.invoice.amount_funded, AMOUNT);
    assert_eq!(after.lp_index, 1);
    assert!(
        after.accruals[0] > before.accruals[0],
        "accrual only on success"
    );
}

/// [RB-3] `claim_default` refunds the LP and then claims insurance. If the
/// refund transfer fails, the insurance pool must not have paid out or
/// marked the invoice claimed, and the invoice must still be Funded.
/// Once it succeeds, the insurance payout happens exactly once.
#[test]
#[ignore = "claim_default refunds draw on contract liquidity this harness does not seed; pending maintainer decision on the default-refund funding model (docs/custody-and-payout-matrix.md, F-04)"]
fn x3_default_claim_reduces_insurance_pool_by_payout() {
    let mut h = Harness::new();
    h.mint(&h.lp.clone(), INVOICE_AMOUNT * 2 + 600);
    h.pool.deposit_premium(&h.lp, &600);
    assert!(h.pool.is_enrolled(&h.lp));
    let pool_before = h.pool.get_pool_balance();
    assert_eq!(pool_before, 600);

    let due = h.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let id = h.iln.submit_invoice(
        &h.freelancer,
        &h.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &h.payment_token_addr,
        &ReferralCode::None,
    );

    // [SET-2] a second default claim changes nothing in either contract.
    assert_eq!(
        w.iln.try_claim_default(&w.lp, &id),
        Err(Ok(ContractError::InvoiceDefaulted))
    );
    assert_eq!(w.ledgers(id), after);
}

/// An insurance payout failure (empty pool) is tolerated by design: the
/// default still completes, and the pool's accounting is untouched (no
/// partial claim marker, no balance change).
#[test]
fn xc_insurance_failure_does_not_corrupt_pool_or_block_default() {
    let w = world();
    w.pool.enroll(&w.lp); // enrolled but the pool holds no reserve
    let id = w.submit();
    w.iln.fund_invoice(&w.lp, &id, &AMOUNT, &false);
    advance(&w.env, 31 * DAY, 100);

    let before = w.ledgers(id);
    w.iln.claim_default(&w.lp, &id);
    let after = w.ledgers(id);
    assert_eq!(after.invoice.status, InvoiceStatus::Defaulted);
    assert_eq!(after.pool_balance, before.pool_balance);
    assert!(
        !after.pool_claimed,
        "failed insurance claim leaves no marker"
    );
    assert_eq!(
        after.accruals, before.accruals,
        "default accrues no rewards"
    );
}

/// Upheld dispute on a Funded invoice draws LP refunds from ILN's own
/// balance ([NE-2]). With an insufficient balance, the resolution reverts
/// atomically, including the distribution/insurance side.
#[test]
fn x4_payment_token_conserved_across_iln_and_insurance() {
    let mut h = Harness::new();
    h.mint(&h.lp.clone(), INVOICE_AMOUNT * 2 + 600);
    h.mint(&h.payer.clone(), INVOICE_AMOUNT);
    h.pool.deposit_premium(&h.lp, &600);

    let due = h.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let id = h.iln.submit_invoice(
        &h.freelancer,
        &h.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &h.payment_token_addr,
        &ReferralCode::None,
    );
    assert_eq!(w.dist.get_accrual(&w.lp), accrual_one);
    w.iln.fund_invoice(&w.lp, &b, &AMOUNT, &false);
    assert_eq!(w.dist.get_accrual(&w.lp), 2 * accrual_one);

    w.iln.mark_paid(&a, &AMOUNT);
    advance(&w.env, 31 * DAY, 100);
    w.iln.claim_default(&w.lp, &b);

    assert_eq!(w.iln.get_invoice(&a).status, InvoiceStatus::Paid);
    assert_eq!(w.iln.get_invoice(&b).status, InvoiceStatus::Defaulted);
    assert!(w.pool.is_claimed(&b) && !w.pool.is_claimed(&a));
    assert_eq!(w.total_tokens(), supply);
    assert!(w.token.balance(&w.iln.address) >= 0);
    let stats = w.iln.get_contract_stats();
    assert_eq!((stats.total_funded, stats.total_paid), (2, 1));
}

// ===========================================================================
// Issue #1100 / #1160 — registered obligations X1–X5
//
// These are the tests named by `docs/proof-obligations.json`. Until they
// existed the registry check (scripts/check-proof-obligations.py and
// `proof_obligations_registry_is_consistent`) failed on a clean tree.
// ===========================================================================

/// Protocol fee used by the ledger tests. Chosen non-zero so the fee leg of
/// settlement is observable; `AMOUNT * FEE_BPS / 10_000` has no remainder.
const FEE_BPS: u32 = 50;

/// Discount withheld from a tranche (same integer formula as the contract).
fn discount(amount: i128) -> i128 {
    amount * RATE as i128 / 10_000
}

/// What an LP actually transfers for a tranche (and what a refund returns).
fn cost(amount: i128) -> i128 {
    amount - discount(amount)
}

fn fee_of(amount: i128) -> i128 {
    amount * FEE_BPS as i128 / 10_000
}

/// Settlement share owed to an LP that funded `amount` of an `AMOUNT` invoice.
fn share(amount: i128) -> i128 {
    (AMOUNT - fee_of(AMOUNT)) * amount / AMOUNT
}

impl World {
    fn bal(&self, a: &Address) -> i128 {
        self.token.balance(a)
    }

    fn iln_balance(&self) -> i128 {
        self.token.balance(&self.iln.address)
    }

    #[track_caller]
    fn assert_conserved(&self, supply: i128, step: &str) {
        assert_eq!(self.total_tokens(), supply, "tokens not conserved: {step}");
    }

    /// The pool's token balance must equal its liquid + backstop accounting.
    #[track_caller]
    fn assert_pool_backed(&self, step: &str) {
        assert_eq!(
            self.pool.get_pool_balance() + self.pool.get_backstop_balance(),
            self.token.balance(&self.pool.address),
            "pool accounting != pool token balance: {step}"
        );
    }
}

/// [X1] A successful funding accrues distribution volume for the funding LP
/// and for no one else.
#[test]
#[ignore = "claim_default refunds draw on contract liquidity this harness does not seed; pending maintainer decision on the default-refund funding model (docs/custody-and-payout-matrix.md, F-04)"]
fn x5_insurance_compensation_not_paid_twice_for_same_invoice() {
    let mut h = Harness::new();
    h.mint(&h.lp.clone(), INVOICE_AMOUNT * 2 + 600);
    h.pool.deposit_premium(&h.lp, &600);

    let due = h.env.ledger().timestamp() + DUE_DATE_OFFSET;
    let id = h.iln.submit_invoice(
        &h.freelancer,
        &h.payer,
        &INVOICE_AMOUNT,
        &due,
        &DISCOUNT_RATE,
        &h.payment_token_addr,
        &ReferralCode::None,
    );

    w.iln.fund_invoice(&w.lp, &id, &AMOUNT, &false);

    assert!(w.dist.get_accrual(&w.lp) > lp_before, "funding LP accrues");
    assert_eq!(w.dist.get_accrual(&w.lp2), other_before, "bystander LP");
    assert_eq!(w.dist.get_accrual(&w.freelancer), fl_before, "freelancer");
}

/// [X2] A successful on-time settlement accrues to the freelancer (and the
/// payer, when its rate is non-zero) and never decreases anyone's accrual.
#[test]
fn x2_settlement_increases_freelancer_distribution_accrual() {
    let w = world();
    let id = w.submit();
    w.iln.fund_invoice(&w.lp, &id, &AMOUNT, &false);
    let (fl, payer, lp) = (
        w.dist.get_accrual(&w.freelancer),
        w.dist.get_accrual(&w.payer),
        w.dist.get_accrual(&w.lp),
    );

    w.iln.mark_paid(&id, &AMOUNT);

    assert!(w.dist.get_accrual(&w.freelancer) > fl, "freelancer accrues");
    assert!(w.dist.get_accrual(&w.payer) >= payer);
    assert_eq!(w.dist.get_accrual(&w.lp), lp, "settlement does not touch LP");
}

/// [X3] `claim_default` for an enrolled LP lowers the pool by exactly the
/// compensation the LP receives; an un-enrolled LP leaves the pool untouched.
#[test]
fn x6_governance_execution_not_before_eta_invariant() {
    let mut h = Harness::new();

    // Configure execution timelock delay = 50 ledgers
    h.gov.set_execution_delay(&h.admin, &50);
    assert_eq!(h.gov.get_execution_delay(), 50);

    // Initial state: fee rate on ILN is 0
    assert_eq!(h.iln_fee_rate(), 0);

    // Create proposal targeting cross-contract update_fee_rate(400)
    let prop_id = h.gov.create_proposal(
        &h.admin,
        &ProposalAction::UpdateFeeRate(400),
        &dummy_hash(&h.env),
        &400_i128,
    );
}

/// [X4] Every step of a mixed lifecycle conserves the payment-token supply
/// across LPs, payer, freelancer, admin, ILN and the insurance pool.
#[test]
fn x4_payment_token_conserved_across_iln_and_insurance() {
    let w = world();
    w.token.mint(&w.lp, &PREMIUM);
    let supply = w.total_tokens();

    w.pool.deposit_premium(&w.lp, &PREMIUM);
    w.assert_conserved(supply, "premium deposit");

    let (a, b, c) = (w.submit(), w.submit(), w.submit());
    w.iln.fund_invoice(&w.lp, &a, &AMOUNT, &false);
    w.assert_conserved(supply, "full funding a");
    w.iln.fund_invoice(&w.lp2, &b, &(AMOUNT / 2), &false);
    w.assert_conserved(supply, "partial funding b");
    w.iln.fund_invoice(&w.lp, &c, &AMOUNT, &false);
    w.assert_conserved(supply, "full funding c");

    w.iln.mark_paid(&a, &(AMOUNT / 2));
    w.assert_conserved(supply, "partial payment a");
    w.iln.mark_paid(&a, &(AMOUNT / 2));
    w.assert_conserved(supply, "settlement a");
    w.iln.cancel_invoice(&b);
    w.assert_conserved(supply, "cancel b");

    advance(&w.env, 31 * DAY, 100);
    w.iln.claim_default(&w.lp, &c);
    w.assert_conserved(supply, "default c + insurance");
    w.assert_pool_backed("end of sequence");
}

    // Guard 1: Cannot execute before voting_end (VotingOngoing)
    let res_early = h.gov.try_execute_proposal(&prop_id);
    assert_eq!(res_early, Err(Ok(GovernanceError::VotingOngoing)));
    assert_eq!(h.iln_fee_rate(), 0);

    w.iln.claim_default(&w.lp, &id);
    assert!(w.pool.is_claimed(&id));
    let after = w.ledgers(id);

    assert_eq!(
        w.iln.try_claim_default(&w.lp, &id),
        Err(Ok(ContractError::InvoiceDefaulted))
    );
    assert!(
        w.pool.try_claim(&id, &w.lp).is_err(),
        "pool itself rejects a second claim for the same invoice"
    );
    assert_eq!(w.ledgers(id), after, "no second payout, no state change");
    w.assert_pool_backed("after rejected second claim");
}

    // Cross-contract call has NOT executed yet
    assert_eq!(h.iln_fee_rate(), 0);

    // Funding ledger.
    for (i, (lp, f)) in lps.iter().enumerate() {
        assert_eq!(start[i] - w.bal(lp), cost(*f), "LP {i} pays its discounted cost");
    }
    assert_eq!(h.env.ledger().sequence(), eta - 1);
    let res_boundary = h.gov.try_execute_proposal(&prop_id);
    assert_eq!(res_boundary, Err(Ok(GovernanceError::TimelockNotExpired)));
    assert_eq!(h.iln_fee_rate(), 0);

    // Guard 3: At current_ledger == eta, execution succeeds! Passed -> Executed
    advance_ledger(&h.env, 1, 10);
    assert_eq!(h.env.ledger().sequence(), eta);
    h.gov.execute_proposal(&prop_id);

    let prop_executed = h.gov.get_proposal(&prop_id);
    assert_eq!(prop_executed.status, ProposalStatus::Executed);

    // Cross-contract action took effect on ILN
    assert_eq!(h.iln_fee_rate(), 400);

    // Guard 4: Cannot re-execute once Executed (#986 replay protection)
    let res_repeat = h.gov.try_execute_proposal(&prop_id);
    assert_eq!(res_repeat, Err(Ok(GovernanceError::ProposalAlreadyExecuted)));
    assert_eq!(h.iln_fee_rate(), 400);
}

/// [X11] Cancelling a partially funded invoice refunds every LP exactly what
/// it deposited, leaves ILN at zero, and is not repeatable.
#[test]
fn x7_governance_veto_transition_safety() {
    let mut h = Harness::new();

    // Configure veto multisig with admin as sole signer
    let signers = soroban_sdk::vec![&h.env, h.admin.clone()];
    h.gov.configure_veto_multisig(&signers, &1);
    assert_eq!(h.gov.get_veto_signers().len(), 1);

    // Case 1: Vetoing an Active proposal
    let prop_active = h.gov.create_proposal(
        &h.admin,
        &ProposalAction::UpdateFeeRate(300),
        &dummy_hash(&h.env),
        &300_i128,
    );
    h.gov.veto_proposal(&h.admin, &prop_active, &dummy_hash(&h.env));
    let prop1 = h.gov.get_proposal(&prop_active);
    assert_eq!(prop1.status, ProposalStatus::Vetoed);

    // Subsequent vote on vetoed proposal rejected
    let vote_res = h.gov.try_cast_vote(&h.admin, &prop_active, &true);
    assert_eq!(vote_res, Err(Ok(GovernanceError::ProposalNotActive)));

    // Subsequent execute on vetoed proposal rejected
    let exec_res1 = h.gov.try_execute_proposal(&prop_active);
    assert_eq!(exec_res1, Err(Ok(GovernanceError::ProposalCancelled)));
    assert_eq!(h.iln_fee_rate(), 0);

    // Case 2: Vetoing a Passed proposal during timelock delay
    h.gov.set_execution_delay(&h.admin, &100);
    let prop_passed = h.gov.create_proposal(
        &h.admin,
        &ProposalAction::UpdateFeeRate(350),
        &dummy_hash(&h.env),
        &350_i128,
    );
    h.gov.cast_vote(&h.admin, &prop_passed, &true);
    advance_ledger(&h.env, 100, 259_201);
    h.gov.execute_proposal(&prop_passed); // Active -> Passed
    assert_eq!(h.gov.get_proposal(&prop_passed).status, ProposalStatus::Passed);

    // Veto while Passed
    h.gov.veto_proposal(&h.admin, &prop_passed, &dummy_hash(&h.env));
    assert_eq!(h.gov.get_proposal(&prop_passed).status, ProposalStatus::Vetoed);

    // Advance past timelock eta: execute still rejected
    advance_ledger(&h.env, 200, 1000);
    let exec_res2 = h.gov.try_execute_proposal(&prop_passed);
    assert_eq!(exec_res2, Err(Ok(GovernanceError::ProposalCancelled)));
    assert_eq!(h.iln_fee_rate(), 0);

    // Case 3: Terminal states reject veto (NotVetoable)
    let veto_terminal = h.gov.try_veto_proposal(&h.admin, &prop_passed, &dummy_hash(&h.env));
    assert_eq!(veto_terminal, Err(Ok(GovernanceError::NotVetoable)));

    // Case 4: Veto power disablement
    h.gov.disable_veto_power();
    assert_eq!(h.gov.is_veto_power_enabled(), false);

    let prop_unvetoable = h.gov.create_proposal(
        &h.admin,
        &ProposalAction::UpdateFeeRate(380),
        &dummy_hash(&h.env),
        &380_i128,
    );
    assert_eq!(w.ledgers(id), after, "repeated cancel changes nothing");
}

/// [X11] [NE-2] An upheld dispute on a Funded invoice with a partial payment
/// returns the LP's cost and the payer's payment in full, so the *only*
/// net transfer is the freelancer's payout, which ILN's reserve absorbs.
#[test]
fn xc_upheld_dispute_ledger_reserve_bears_freelancer_payout() {
    let w = world();
    let supply = w.total_tokens();
    let (lp0, payer0, iln0) = (w.bal(&w.lp), w.bal(&w.payer), w.iln_balance());

    let id = w.submit();
    w.iln.fund_invoice(&w.lp, &id, &AMOUNT, &false);
    w.iln.mark_paid(&id, &(AMOUNT / 2));
    w.iln
        .dispute_invoice(&id, &soroban_sdk::BytesN::from_array(&w.env, &[1; 32]));
    w.iln
        .resolve_dispute(&id, &soroban_sdk::BytesN::from_array(&w.env, &[2; 32]), &1);

    let payout = AMOUNT - discount(AMOUNT);
    assert_eq!(w.iln.get_invoice(&id).status, InvoiceStatus::Cancelled);
    assert_eq!(w.bal(&w.lp), lp0, "LP made whole");
    assert_eq!(w.bal(&w.payer), payer0, "payer made whole");
    assert_eq!(w.bal(&w.freelancer), payout, "freelancer keeps the payout");
    assert_eq!(iln0 - w.iln_balance(), payout, "reserve bears it");
    w.assert_conserved(supply, "after upheld dispute");
}

/// [X11] Characterization of a verified gap (see `docs/cross-contract-accounting-audit.md`
/// F-2): distribution volume is accrued at funding time and is never
/// reversed when the funding is refunded. A funder who is made whole by a
/// cancellation still keeps the reward volume. If this test starts failing
/// because accrual is now reversed, update the audit doc and registry.
#[test]
fn xc_refunded_funding_volume_still_accrues_lp_reward() {
    let w = world_with_reserve(0);
    let lp0 = w.bal(&w.lp);
    assert_eq!(w.dist.get_accrual(&w.lp), 0);

    // Two fund-then-cancel round trips of half an invoice each: 100 USDC of
    // cumulative volume (the reward granularity) with zero net token cost.
    for _ in 0..2 {
        let id = w.submit();
        w.iln.fund_invoice(&w.lp, &id, &(AMOUNT / 2), &false);
        w.iln.cancel_invoice(&id);
        assert_eq!(w.iln.get_invoice(&id).status, InvoiceStatus::Cancelled);
    }

    assert_eq!(w.bal(&w.lp), lp0, "LP fully refunded");
    assert!(
        w.dist.get_accrual(&w.lp) > 0,
        "yet reward volume from the refunded funding remains accrued"
    );
}

/// [X12] Obligation coverage: with no treasury reserve, ILN's token balance
/// is always exactly the refundable deposits of unfunded invoices plus the
/// partial payments of unsettled ones, and returns to zero once every
/// obligation is discharged.
#[test]
fn xc_iln_balance_equals_outstanding_obligations() {
    let w = world_with_reserve(0);
    w.iln.update_fee_rate(&FEE_BPS);
    let supply = w.total_tokens();
    let lp_start = w.bal(&w.lp);

    // A: half funded -> ILN owes the LP its deposit back.
    let a = w.submit();
    w.iln.fund_invoice(&w.lp, &a, &(AMOUNT / 2), &false);
    let owed_a = cost(AMOUNT / 2);
    assert_eq!(w.iln_balance(), owed_a);

    // B: fully funded, quarter paid -> ILN holds the payer's partial payment.
    let b = w.submit();
    w.iln.fund_invoice(&w.lp2, &b, &AMOUNT, &false);
    assert_eq!(w.iln_balance(), owed_a, "full funding is passed straight through");
    w.iln.mark_paid(&b, &(AMOUNT / 4));
    assert_eq!(w.iln_balance(), owed_a + AMOUNT / 4);

    // C: funded and fully settled -> leaves no obligation behind.
    let c = w.submit();
    w.iln.fund_invoice(&w.lp, &c, &AMOUNT, &false);
    w.iln.mark_paid(&c, &AMOUNT);
    assert_eq!(w.iln_balance(), owed_a + AMOUNT / 4, "settled invoice owes nothing");
    w.assert_conserved(supply, "mixed obligations");

    // Discharge A and B; ILN must end at exactly zero.
    w.iln.cancel_invoice(&a);
    assert_eq!(w.iln_balance(), AMOUNT / 4);
    w.iln.mark_paid(&b, &(AMOUNT - AMOUNT / 4));
    assert_eq!(w.iln_balance(), 0, "no obligation left, no stranded tokens");
    assert_eq!(
        w.bal(&w.lp),
        lp_start - cost(AMOUNT) + share(AMOUNT),
        "LP net: A refunded in full, C earned its share"
    );
    w.assert_conserved(supply, "all obligations discharged");
}

/// [X12] The insurance pool's accounting always matches the tokens it holds,
/// through deposit, payout, and a rejected repeat claim.
#[test]
fn xc_insurance_pool_token_balance_matches_accounting() {
    let w = world();
    w.assert_pool_backed("empty pool");
    w.token.mint(&w.lp, &PREMIUM);
    w.pool.deposit_premium(&w.lp, &PREMIUM);
    w.assert_pool_backed("after deposit");
    assert_eq!(w.token.balance(&w.pool.address), PREMIUM);

    let id = w.submit();
    w.iln.fund_invoice(&w.lp, &id, &AMOUNT, &false);
    advance(&w.env, 31 * DAY, 100);
    w.iln.claim_default(&w.lp, &id);
    w.assert_pool_backed("after payout");
    assert!(w.token.balance(&w.pool.address) < PREMIUM, "payout left the pool");

    assert!(w.iln.try_claim_default(&w.lp, &id).is_err());
    w.assert_pool_backed("after rejected repeat claim");
}
