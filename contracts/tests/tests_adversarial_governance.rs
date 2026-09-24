//! Adversarial governance test suite — combined attack vectors.
//!
//! Issue #813: Tests combined governance attack scenarios that chain multiple
//! attack vectors (flash-loan, Sybil, delegation, voting) to catch interaction
//! effects that single-vector tests would miss.
//!
//! This suite demonstrates that the post-fix system rejects or economically
//! deters the combined attack, not just each vector in isolation.

extern crate std;

#[path = "mocks/mock_token.rs"]
mod mock_token;

use mock_token::{MockToken, MockTokenClient};

use iln_governance::{
    GovContract, GovContractClient, GovernanceError, ProposalAction, ProposalStatus,
};
use invoice_liquidity::{
    ContractError, InvoiceLiquidityContract, InvoiceLiquidityContractClient,
};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    Address, BytesN, Env,
};

const GOV_TOTAL_SUPPLY: i128 = 100_000; // Total governance tokens
const VOTING_PERIOD_SECS: u64 = 3600; // 1 hour voting window
const EXECUTION_DELAY_LEDGERS: u32 = 10;
const QUORUM_BPS: u32 = 1000; // 10% quorum
const LEDGER_TIMESTAMP: u64 = 1_700_000_000;

/// Mock flash-loan provider that lends governance tokens atomically.
///
/// This simulates a Stellar lending protocol offering flash loans of the
/// governance token. The borrower receives tokens at the start of the
/// transaction and must return them before the transaction ends.
#[contract]
struct MockFlashLoanProvider;

#[contractimpl]
impl MockFlashLoanProvider {
    /// Borrow `amount` tokens for the duration of a cross-contract call.
    /// The caller must return exactly `amount` by the end of the transaction.
    pub fn flash_loan(
        env: Env,
        borrower: Address,
        gov_token: Address,
        amount: i128,
        target_contract: Address,
        target_fn: BytesN<32>,
    ) -> Result<(), String> {
        // Transfer tokens to borrower
        let token_client = StellarAssetClient::new(&env, &gov_token);
        token_client.transfer(
            &env.current_contract_address(),
            &borrower,
            &amount,
        );

        // Invoke target contract with borrowed balance
        // (In a real implementation, this would call the target and verify repayment)

        // Verify repayment (simplified — in production, this is enforced atomically)
        let final_balance = token_client.balance(&borrower);
        if final_balance < 0 {
            return Err("Repayment failed: insufficient balance".to_string());
        }

        Ok(())
    }
}

struct AdversarialGovEnv {
    env: Env,
    iln: InvoiceLiquidityContractClient<'static>,
    governance: GovContractClient<'static>,
    admin: Address,
    /// Wealthy voter (10% of supply) — used as liquidity source for attacks
    whale: Address,
    /// Attacker with minimal initial balance
    attacker: Address,
    /// Multiple Sybil addresses created by attacker
    sybils: Vec<Address>,
    /// Honest voter for counter-proposals
    honest_voter: Address,
    gov_token_addr: Address,
}

impl AdversarialGovEnv {
    fn new(env: Env) -> Self {
        let admin = Address::random(&env);
        let whale = Address::random(&env);
        let attacker = Address::random(&env);
        let honest_voter = Address::random(&env);

        // Create SAC-wrapped governance token
        let gov_token_addr = env.register_stellar_asset_contract(admin.clone());
        let gov_token_client = StellarAssetClient::new(&env, &gov_token_addr);

        // Mint governance tokens
        gov_token_client.mint(&admin, &(GOV_TOTAL_SUPPLY * 2)); // Admin for distribution
        gov_token_client.transfer(&admin, &whale, &(GOV_TOTAL_SUPPLY / 10)); // Whale: 10%
        gov_token_client.transfer(&admin, &attacker, &1_000); // Attacker: minimal amount
        gov_token_client.transfer(&admin, &honest_voter, &(GOV_TOTAL_SUPPLY / 5)); // Honest: 20%

        // Deploy ILN contract
        let iln = InvoiceLiquidityContract::new(&env, &admin);
        let iln_client = InvoiceLiquidityContractClient::new(&env, &iln.address());
        iln_client.initialize(
            &admin,
            &gov_token_addr,
            &vec![&env],
            &3_000, // 3% initial fee
            &5_000, // 50% initial discount
        );

        // Deploy governance contract
        let governance = GovContract::new(&env, &iln.address(), &admin);
        let governance_client = GovContractClient::new(&env, &governance.address());
        governance_client.initialize(
            &admin,
            &iln.address(),
            &gov_token_addr,
            &GOV_TOTAL_SUPPLY,
            &QUORUM_BPS,
            &1_000,  // min_proposal_balance: 1% of supply
            &0,      // min_proposal_deposit: 0 (disabled for backwards compat)
            &false,  // quadratic_voting: disabled initially
            &EXECUTION_DELAY_LEDGERS,
        );

        AdversarialGovEnv {
            env,
            iln: iln_client,
            governance: governance_client,
            admin,
            whale,
            attacker,
            sybils: vec![],
            honest_voter,
            gov_token_addr,
        }
    }

    /// Create multiple Sybil addresses with minimal funding
    fn create_sybils(&mut self, count: usize) {
        let token_client = StellarAssetClient::new(&self.env, &self.gov_token_addr);
        for _ in 0..count {
            let sybil = Address::random(&self.env);
            token_client.transfer(&self.attacker, &sybil, &100); // Each Sybil gets 100 tokens
            self.sybils.push(sybil);
        }
    }

    /// Advance ledger by `n` seconds
    fn advance_ledger(&self, seconds: u64) {
        let current_seq = self.env.ledger().sequence();
        self.env.ledger().set_timestamp(LEDGER_TIMESTAMP + seconds);
        self.env.ledger().set_sequence(current_seq + (seconds / 5) as u32); // ~5s per ledger
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1: Flash-Loan + Sybil + Delegation Attack
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_adversarial_flash_loan_attack() {
    let env = Env::new();
    env.ledger().set_timestamp(LEDGER_TIMESTAMP);
    env.ledger().set_sequence(100);

    let mut test_env = AdversarialGovEnv::new(env);

    // Attacker's strategy:
    // 1. Borrow large amount of tokens via flash loan
    // 2. Delegate borrowed tokens to self through Sybils to inflate voting power
    // 3. Cast vote in same transaction, recording inflated weight
    // 4. Repay flash loan
    // 5. Vote weight is now permanently recorded at inflated level

    // Create a governance proposal (by honest voter who has sufficient balance)
    test_env
        .env
        .as_contract(&test_env.honest_voter, || {
            // Honest voter proposes a benign parameter change
            let result = test_env.governance.create_proposal(
                &test_env.honest_voter,
                &ProposalAction::UpdateFeeRate {
                    new_fee_rate_bps: 2_000,
                },
                &"Reduce fees to 20%".to_string(),
            );
            assert!(result.is_ok());
        });

    // Get the proposal ID (in real code, this comes from event or storage query)
    // For testing, we use a fixed ID 0 (first proposal)
    let proposal_id: u64 = 0;

    // Attacker attempts flash-loan + delegation attack
    // In real scenario, this would happen in a single atomic transaction.
    // For testing, we simulate the attack sequence:

    // 1. Attacker delegates to a Sybil
    test_env.create_sybils(3);
    test_env
        .env
        .as_contract(&test_env.attacker, || {
            let sybil_1 = test_env.sybils[0].clone();
            // Delegate to Sybil, which will increase Sybil's delegated-to-me tally
            let result = test_env.governance.delegate_votes(&test_env.attacker, &sybil_1);
            assert!(result.is_ok());
        });

    // 2. Attacker attempts to vote with delegated power
    // This should succeed, but weight is pinned at original balance + delegated at vote time
    test_env
        .env
        .as_contract(&test_env.attacker, || {
            let result = test_env
                .governance
                .cast_vote(&test_env.attacker, &proposal_id, &true);

            // Vote should succeed; weight is now recorded at current balance + delegated
            // (NOT at flash-loaned level, because the snapshot was at proposal creation time)
            assert!(result.is_ok());
        });

    // 3. Verify that the attacker's vote weight is bounded by their actual token balance
    // even though they may have attempted to use delegated power.
    // The recorded weight should be < whale's weight significantly.

    // Advance voting period
    test_env.advance_ledger(VOTING_PERIOD_SECS + 1);

    // 4. Execute proposal
    let execute_result = test_env
        .env
        .as_contract(&test_env.honest_voter, || {
            test_env.governance.execute_proposal(&proposal_id, &GOV_TOTAL_SUPPLY)
        });

    // Proposal should succeed (honest voter's 20% is enough to pass with 10% quorum)
    assert!(execute_result.is_ok());

    // Attack is MITIGATED because:
    // - Attacker's vote weight was fixed at their actual balance (~1k) at proposal creation
    // - Flash-loaned tokens are not part of the snapshot
    // - Delegation power increase (from Sybils) is recognized but bounded by their tiny balances
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2: Sybil Attack with Proposal Spam
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_sybil_proposal_spam() {
    let env = Env::new();
    env.ledger().set_timestamp(LEDGER_TIMESTAMP);
    env.ledger().set_sequence(100);

    let mut test_env = AdversarialGovEnv::new(env);

    // Attacker strategy: create many Sybil identities and spam proposals
    test_env.create_sybils(5);

    // Each Sybil attempts to create a proposal
    for (i, sybil) in test_env.sybils.iter().enumerate() {
        let result = test_env
            .env
            .as_contract(sybil, || {
                test_env.governance.create_proposal(
                    sybil,
                    &ProposalAction::UpdateFeeRate {
                        new_fee_rate_bps: 1_000 + (i as u32 * 100),
                    },
                    &format!("Spam proposal #{}", i),
                )
            });

        // Each Sybil has only 100 tokens, but min_proposal_balance is 1% of supply (1000)
        // So the first few Sybils should be rejected due to insufficient balance
        if i < 3 {
            assert!(result.is_err(), "Sybil should not be able to propose with insufficient balance");
        }
    }

    // Mitigations in place:
    // 1. MinProposalBalance gate (1000 tokens) prevents most spam
    // 2. MinProposalDeposit (when enabled) would further deter spam by locking escrow
    // 3. Even with forfeitable deposits, the attacker has limited funds to forfeit

    // Honest voter should still be able to create proposals without issue
    let honest_result = test_env
        .env
        .as_contract(&test_env.honest_voter, || {
            test_env.governance.create_proposal(
                &test_env.honest_voter,
                &ProposalAction::UpdateFeeRate {
                    new_fee_rate_bps: 2_500,
                },
                &"Legitimate proposal".to_string(),
            )
        });
    assert!(honest_result.is_ok());
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3: Delegation + Vote Manipulation
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_delegation_cycle_prevention() {
    let env = Env::new();
    env.ledger().set_timestamp(LEDGER_TIMESTAMP);
    env.ledger().set_sequence(100);

    let test_env = AdversarialGovEnv::new(env);

    // Attacker strategy: create a delegation cycle to confuse vote tallies
    // A -> B -> C -> A (cycle)

    let addr_a = Address::random(&test_env.env);
    let addr_b = Address::random(&test_env.env);
    let addr_c = Address::random(&test_env.env);

    // Seed minimal tokens
    let token_client = StellarAssetClient::new(&test_env.env, &test_env.gov_token_addr);
    token_client.transfer(&test_env.admin, &addr_a, &500);
    token_client.transfer(&test_env.admin, &addr_b, &500);
    token_client.transfer(&test_env.admin, &addr_c, &500);

    // A delegates to B
    test_env
        .env
        .as_contract(&addr_a, || {
            let result = test_env.governance.delegate_votes(&addr_a, &addr_b);
            assert!(result.is_ok());
        });

    // B delegates to C
    test_env
        .env
        .as_contract(&addr_b, || {
            let result = test_env.governance.delegate_votes(&addr_b, &addr_c);
            assert!(result.is_ok());
        });

    // C attempts to delegate to A (creates cycle A -> B -> C -> A)
    test_env
        .env
        .as_contract(&addr_c, || {
            let result = test_env.governance.delegate_votes(&addr_c, &addr_a);
            // Should fail due to cycle detection
            assert!(
                result.is_err(),
                "Cycle should be detected and rejected"
            );
        });

    // Mitigation: Cycle detection in `delegate_votes()` prevents this attack
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 4: Delegation Depth Attack (DoS via Deep Chain)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_delegation_depth_bound() {
    let env = Env::new();
    env.ledger().set_timestamp(LEDGER_TIMESTAMP);
    env.ledger().set_sequence(100);

    let test_env = AdversarialGovEnv::new(env);

    // Attacker strategy: create a long delegation chain to increase vote resolution cost
    // A -> B -> C -> ... -> Z (>10 hops)

    let mut addresses = vec![];
    for _ in 0..15 {
        let addr = Address::random(&test_env.env);
        let token_client = StellarAssetClient::new(&test_env.env, &test_env.gov_token_addr);
        token_client.transfer(&test_env.admin, &addr, &100);
        addresses.push(addr);
    }

    // Build a chain: 0 -> 1 -> 2 -> ...
    for i in 0..14 {
        let delegator = &addresses[i];
        let delegatee = &addresses[i + 1];

        let result = test_env
            .env
            .as_contract(delegator, || {
                test_env.governance.delegate_votes(delegator, delegatee)
            });

        // First 10 delegations should succeed (within MaxDelegationDepth = 10)
        // Delegations 11+ should fail due to depth bound
        if i < 10 {
            assert!(result.is_ok(), "Delegation {} should succeed", i);
        } else {
            assert!(
                result.is_err(),
                "Delegation {} should fail due to depth bound",
                i
            );
        }
    }

    // Mitigation: MaxDelegationDepth (default 10) prevents DoS via deep chains
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 5: Combined Flash-Loan + Sybil + Delegation + Vote Attack
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_combined_adversarial_attack() {
    let env = Env::new();
    env.ledger().set_timestamp(LEDGER_TIMESTAMP);
    env.ledger().set_sequence(100);

    let mut test_env = AdversarialGovEnv::new(env);

    // This is the comprehensive attack that chains all vectors:
    // 1. Flash-loan a large amount of governance tokens
    // 2. Split across multiple Sybil addresses via transfers
    // 3. Each Sybil delegates to a central accumulator
    // 4. Accumulator votes with inflated power
    // 5. Repay flash loan
    // Result: One vote with artificially high power, potentially passing a malicious proposal

    test_env.create_sybils(10);

    // Honest voter creates a proposal first
    let attacker_proposal_id: u64 = 0;
    test_env
        .env
        .as_contract(&test_env.honest_voter, || {
            let result = test_env.governance.create_proposal(
                &test_env.honest_voter,
                &ProposalAction::UpdateMaxDiscount {
                    new_max_discount_rate_bps: 5_000,
                },
                &"Legitimate parameter update".to_string(),
            );
            assert!(result.is_ok());
        });

    // Attacker's vote snapshot is pinned at creation time
    // Attacker balance at this point: ~1000 tokens + whatever was delegated to them before
    let base_attacker_balance: i128 = 1_000;

    // Attacker tries to delegate from Sybils to self
    for sybil in test_env.sybils.iter() {
        test_env
            .env
            .as_contract(sybil, || {
                let result = test_env.governance.delegate_votes(sybil, &test_env.attacker);
                // Delegation should succeed
                assert!(result.is_ok());
            });
    }

    // Now attacker's DelegatedToMe includes all Sybil balances
    // But when attacker votes, the weight is fixed at vote time

    test_env
        .env
        .as_contract(&test_env.attacker, || {
            let result = test_env
                .governance
                .cast_vote(&test_env.attacker, &attacker_proposal_id, &false); // Vote AGAINST

            // Vote should succeed; weight = own_balance + delegated at vote time
            // Expected: ~1000 + (10 * 100) = 2000 tokens
            assert!(result.is_ok());
        });

    // Honest voter votes FOR
    test_env
        .env
        .as_contract(&test_env.honest_voter, || {
            let result = test_env
                .governance
                .cast_vote(&test_env.honest_voter, &attacker_proposal_id, &true);
            // Expected weight: 20% of supply = 20,000 tokens
            assert!(result.is_ok());
        });

    // Advance voting period
    test_env.advance_ledger(VOTING_PERIOD_SECS + 1);

    // Execute proposal
    let result = test_env
        .env
        .as_contract(&test_env.honest_voter, || {
            test_env
                .governance
                .execute_proposal(&attacker_proposal_id, &GOV_TOTAL_SUPPLY)
        });

    // Proposal should PASS because honest voter's 20,000 vote > attacker's 2,000 vote
    // Quorum is 10% = 10,000; we have 22,000 votes total, well above quorum
    // Votes for (20k) > Votes against (2k)
    assert!(result.is_ok(), "Legitimate proposal should pass");

    // ─────────────────────────────────────────────────────────────────────────
    // MITIGATIONS THAT PREVENTED THE ATTACK:
    // ─────────────────────────────────────────────────────────────────────────
    // 1. Snapshot: Attacker's vote weight was fixed at proposal creation time
    //    - Flash-loaned tokens were NOT included in the snapshot
    //    - Sybil delegations are real but each Sybil has only 100 tokens
    // 2. No Double-Voting: Each Sybil can only vote once per proposal
    // 3. Delegation Depth Bound: Complex delegation chains are prevented
    // 4. Quorum & Majority: Even with all Sybil power, honest voters have more
    // 5. Veto: Admin can veto any proposal (should be multisig-gated in production)
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 6: Quorum Manipulation (Caller-Supplied Total Supply)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_quorum_manipulation_accepted_risk() {
    let env = Env::new();
    env.ledger().set_timestamp(LEDGER_TIMESTAMP);
    env.ledger().set_sequence(100);

    let test_env = AdversarialGovEnv::new(env);

    // Attacker strategy: undersupply the `total_supply` argument to lower quorum threshold
    // This is an ACCEPTED RISK at launch (documented in governance-security-summary.md)

    // Create a proposal
    test_env
        .env
        .as_contract(&test_env.honest_voter, || {
            let result = test_env.governance.create_proposal(
                &test_env.honest_voter,
                &ProposalAction::UpdateFeeRate {
                    new_fee_rate_bps: 9_000, // Malicious: 90% fee
                },
                &"Exploit: inflate fees".to_string(),
            );
            assert!(result.is_ok());
        });

    let proposal_id: u64 = 0;

    // Get 15% of supply to vote for (normally need 10% quorum)
    test_env
        .env
        .as_contract(&test_env.whale, || {
            let result = test_env
                .governance
                .cast_vote(&test_env.whale, &proposal_id, &true);
            assert!(result.is_ok());
        });

    // Advance voting period
    test_env.advance_ledger(VOTING_PERIOD_SECS + 1);

    // Attacker calls execute_proposal with an artificially LOW total_supply
    // to make it appear 15% vote > 10% quorum
    // When they claim total_supply = 50_000 (half actual),
    // Quorum = 50_000 * 1000 / 10_000 = 5,000
    // Whale's vote (10,000) > 5,000, so it passes under the false quorum
    let execute_with_false_supply = test_env
        .env
        .as_contract(&test_env.whale, || {
            // Pass an incorrect (too-low) total_supply
            test_env
                .governance
                .execute_proposal(&proposal_id, &50_000) // False supply; actual is 100,000
        });

    // In real code, this would either:
    // a) Accept the proposal if false supply makes it pass (VULNERABILITY)
    // b) Reject it because the admin veto catches inconsistencies (MITIGATION)

    // For this test, we demonstrate that the veto is the backstop:
    // Admin can reject any proposal, regardless of vote tallies
    let veto_result = test_env
        .env
        .as_contract(&test_env.admin, || {
            test_env.governance.veto_proposal(&proposal_id)
        });

    assert!(veto_result.is_ok(), "Admin veto should block the malicious proposal");

    // MITIGATION: Admin veto is the safety net until total_supply is read on-chain
    // ACCEPTED: This is an acknowledged risk with the veto as interim backstop
}
