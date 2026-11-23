//! Issue #1161 — governance-path rows (G1–G4) of `docs/authority-matrix.md`.
//!
//! The deployment model in `docs/multisig-admin-runbook.md` hands the
//! invoice-liquidity admin role to the governance contract. These tests run
//! that configuration and check that neither the old admin key nor a
//! governance proposal can get around the controls the matrix documents.

#![cfg(test)]

use iln_governance::{
    GovContract, GovContractClient, GovernanceError, ProposalAction, ProposalStatus,
};
use invoice_liquidity::{DataKey, InvoiceLiquidityContract, InvoiceLiquidityContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::StellarAssetClient,
    Address, BytesN, Env, IntoVal,
};

const VOTING_PERIOD_SECS: u64 = 259_200;
const EXECUTION_DELAY: u32 = 50;

struct Gov {
    env: Env,
    old_admin: Address,
    iln: InvoiceLiquidityContractClient<'static>,
    gov: GovContractClient<'static>,
}

fn advance(env: &Env, ledgers: u32, secs: u64) {
    let mut info = env.ledger().get();
    info.sequence_number += ledgers;
    info.timestamp += secs;
    env.ledger().set(info);
}

fn setup() -> Gov {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let mut info = env.ledger().get();
    info.timestamp = 1_700_000_000;
    env.ledger().set(info);

    let old_admin = Address::generate(&env);
    let usdc = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let xlm = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let iln_id = env.register_contract(None, InvoiceLiquidityContract);
    let iln = InvoiceLiquidityContractClient::new(&env, &iln_id);
    iln.initialize(&old_admin, &usdc, &Address::generate(&env), &xlm);

    let dist_id = env.register_contract(None, iln_distribution::IlnDistribution);
    let gov_token = env
        .register_stellar_asset_contract_v2(dist_id.clone())
        .address();
    iln_distribution::IlnDistributionClient::new(&env, &dist_id).initialize(&iln_id, &gov_token);
    StellarAssetClient::new(&env, &gov_token).mint(&old_admin, &10_000);

    let gov_id = env.register_contract(None, GovContract);
    let gov = GovContractClient::new(&env, &gov_id);
    gov.initialize(
        &iln_id,
        &dist_id,
        &Address::generate(&env),
        &gov_token,
        &old_admin,
        &20_000_i128,
    );
    gov.set_execution_delay(&old_admin, &EXECUTION_DELAY);
    gov.checkpoint_balance(&old_admin);
    advance(&env, 12, 100);

    // Hand the ILN admin role to governance.
    iln.set_admin(&gov_id);

    Gov {
        env,
        old_admin,
        iln,
        gov,
    }
}

impl Gov {
    fn fee_rate(&self) -> u32 {
        self.env.as_contract(&self.iln.address, || {
            self.env
                .storage()
                .instance()
                .get::<_, u32>(&DataKey::FeeRate)
                .unwrap_or(0)
        })
    }

    /// Create, vote and pass a fee proposal; returns `(id, eta_ledger)`.
    fn pass_fee_proposal(&self, rate: u32) -> (u64, u32) {
        let id = self.gov.create_proposal(
            &self.old_admin,
            &ProposalAction::UpdateFeeRate(rate),
            &BytesN::from_array(&self.env, &[1u8; 32]),
            &(rate as i128),
        );
        self.gov.cast_vote(&self.old_admin, &id, &true);
        advance(&self.env, 100, VOTING_PERIOD_SECS + 1);
        self.gov.execute_proposal(&id);
        let p = self.gov.get_proposal(&id);
        assert_eq!(p.status, ProposalStatus::Passed);
        (id, p.eta_ledger)
    }

    fn reach(&self, eta: u32) {
        let now = self.env.ledger().sequence();
        if now < eta {
            advance(&self.env, eta - now, 10);
        }
    }
}

#[test]
fn g1_old_admin_key_cannot_bypass_governance() {
    let g = setup();
    g.env.mock_auths(&[MockAuth {
        address: &g.old_admin,
        invoke: &MockAuthInvoke {
            contract: &g.iln.address,
            fn_name: "update_fee_rate",
            args: (999_u32,).into_val(&g.env),
            sub_invokes: &[],
        },
    }]);
    assert!(g.iln.try_update_fee_rate(&999).is_err());
    assert_eq!(g.fee_rate(), 0);
}

#[test]
fn g2_governance_applies_a_change_only_after_vote_and_timelock() {
    let g = setup();
    let (id, eta) = g.pass_fee_proposal(400);
    assert_eq!(g.fee_rate(), 0);

    g.reach(eta - 1);
    assert_eq!(
        g.gov.try_execute_proposal(&id),
        Err(Ok(GovernanceError::TimelockNotExpired))
    );
    g.reach(eta);
    g.gov.execute_proposal(&id);
    assert_eq!(g.fee_rate(), 400);
    assert_eq!(
        g.gov.try_execute_proposal(&id),
        Err(Ok(GovernanceError::ProposalAlreadyExecuted))
    );
}

#[test]
fn g3_governance_cannot_push_a_parameter_past_the_contract_bound() {
    // A proposal can pass its vote, but ILN still rejects an out-of-range fee
    // (finding F-01). The proposal stays `Passed` and nothing changes.
    let g = setup();
    let (id, eta) = g.pass_fee_proposal(10_001);
    g.reach(eta);
    g.gov.execute_proposal(&id);
    assert_eq!(g.gov.get_proposal(&id).status, ProposalStatus::Passed);
    assert_eq!(g.fee_rate(), 0);
}

#[test]
fn g4_emergency_pause_holds_execution_without_shortening_the_timelock() {
    let g = setup();
    let (id, eta) = g.pass_fee_proposal(400);

    // While the proposal is scheduled, the admin cannot shorten the timelock.
    assert_eq!(g.gov.get_max_scheduled_eta(), eta);
    assert_eq!(
        g.gov
            .try_set_execution_delay(&g.old_admin, &(EXECUTION_DELAY - 1)),
        Err(Ok(GovernanceError::DelayReductionBypassesScheduled))
    );

    let imposter = Address::generate(&g.env);
    assert_eq!(
        g.gov.try_pause(&imposter),
        Err(Ok(GovernanceError::Unauthorized))
    );

    g.gov.pause(&g.old_admin);
    g.reach(eta);
    assert_eq!(
        g.gov.try_execute_proposal(&id),
        Err(Ok(GovernanceError::ContractPaused))
    );
    assert_eq!(g.fee_rate(), 0);

    g.gov.unpause(&g.old_admin);
    g.gov.execute_proposal(&id);
    assert_eq!(g.fee_rate(), 400);
}
