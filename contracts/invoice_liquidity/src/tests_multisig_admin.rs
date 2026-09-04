/// Comprehensive tests for Multi-sig Admin feature (Issue #124, #638)
///
/// Tests cover:
/// - 2-of-3 threshold scenarios
/// - Proposal expiration
/// - Duplicate signature prevention
/// - Threshold validation
/// - Various admin actions
/// - Production threshold flow (2-of-3) mirroring docs/multisig-admin-runbook.md
#[cfg(test)]
// The generated `try_*` contract clients return `Result<Result<.., _>, _>`;
// asserting success with `.unwrap()` triggers unused_must_use under -D warnings.
#[allow(unused_must_use)]
mod tests {
    use crate::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{Address, Env, Vec};

    #[allow(dead_code)]
    struct TestEnv {
        env: Env,
        contract: InvoiceLiquidityContractClient<'static>,
        admin1: Address,
        admin2: Address,
        admin3: Address,
        other: Address,
    }

    fn setup_multisig() -> TestEnv {
        let env = Env::default();
        // Multisig entry points call require_auth() on the proposer/signer/
        // executor; mock auth so the generated client calls pass.
        env.mock_all_auths();

        // Generate test addresses
        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let admin3 = Address::generate(&env);
        let other = Address::generate(&env);

        // Register token contracts
        let usdc_admin = Address::generate(&env);
        let usdc_token = env.register_stellar_asset_contract_v2(usdc_admin);
        let usdc_token_addr = usdc_token.address();

        let eurc_admin = Address::generate(&env);
        let eurc_token = env.register_stellar_asset_contract_v2(eurc_admin);
        let eurc_token_addr = eurc_token.address();

        let xlm_admin = Address::generate(&env);
        let xlm_token = env.register_stellar_asset_contract_v2(xlm_admin);
        let xlm_token_addr = xlm_token.address();

        // Deploy the main contract
        let contract_id = env.register_contract(None, InvoiceLiquidityContract);
        let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);

        // Initialize the contract
        contract.initialize(&admin1, &usdc_token_addr, &eurc_token_addr, &xlm_token_addr);

        TestEnv {
            env,
            contract,
            admin1,
            admin2,
            admin3,
            other,
        }
    }

    // ────────────────────────────────────────────────────────────
    // Test 1: Initialize multisig admin with 2-of-3 threshold
    // ────────────────────────────────────────────────────────────
    #[test]
    fn test_initialize_multisig_admin_2of3() {
        let t = setup_multisig();

        // Create signer list
        let mut signers = Vec::new(&t.env);
        signers.push_back(t.admin1.clone());
        signers.push_back(t.admin2.clone());
        signers.push_back(t.admin3.clone());

        // Initialize multisig admin with 2-of-3 threshold
        let result = t.contract.try_initialize_multisig_admin(&signers, &2);
        assert!(result.is_ok());
    }

    // ────────────────────────────────────────────────────────────
    // Test 2: Propose pause action
    // ────────────────────────────────────────────────────────────
    #[test]
    fn test_propose_pause_action() {
        let t = setup_multisig();

        let mut signers = Vec::new(&t.env);
        signers.push_back(t.admin1.clone());
        signers.push_back(t.admin2.clone());
        signers.push_back(t.admin3.clone());
        t.contract
            .try_initialize_multisig_admin(&signers, &2)
            .unwrap();

        // Propose pause action
        let result = t.contract.try_propose_pause(&t.admin1).unwrap();
        let proposal_id = result.unwrap();
        assert!(proposal_id > 0);
    }

    // ────────────────────────────────────────────────────────────
    // Test 3: Sign proposal - threshold not met
    // ────────────────────────────────────────────────────────────
    #[test]
    fn test_sign_proposal_threshold_not_met() {
        let t = setup_multisig();

        let mut signers = Vec::new(&t.env);
        signers.push_back(t.admin1.clone());
        signers.push_back(t.admin2.clone());
        signers.push_back(t.admin3.clone());
        t.contract
            .try_initialize_multisig_admin(&signers, &2)
            .unwrap();

        let proposal_id = t.contract.try_propose_pause(&t.admin1).unwrap().unwrap();

        // Only admin1 has signed (needs 2)
        let result = t.contract.try_sign_proposal(&t.admin1, &proposal_id);
        assert!(result.is_ok());

        // Threshold not reached yet
        let result = t.contract.try_execute_proposal(&t.admin1, &proposal_id);
        assert_eq!(result, Err(Ok(ContractError::ThresholdNotReached)));
    }

    // ────────────────────────────────────────────────────────────
    // Test 4: Sign proposal and execute when threshold met
    // ────────────────────────────────────────────────────────────
    #[test]
    fn test_sign_and_execute_threshold_met() {
        let t = setup_multisig();

        let mut signers = Vec::new(&t.env);
        signers.push_back(t.admin1.clone());
        signers.push_back(t.admin2.clone());
        signers.push_back(t.admin3.clone());
        t.contract
            .try_initialize_multisig_admin(&signers, &2)
            .unwrap();

        let proposal_id = t.contract.try_propose_pause(&t.admin1).unwrap().unwrap();

        // First signature
        t.contract
            .try_sign_proposal(&t.admin1, &proposal_id)
            .unwrap();

        // Second signature - threshold reached
        t.contract
            .try_sign_proposal(&t.admin2, &proposal_id)
            .unwrap();

        // Execute proposal
        t.contract
            .try_execute_proposal(&t.admin1, &proposal_id)
            .unwrap();

        // Verify contract is paused
        assert!(t.contract.is_paused());
    }

    // ────────────────────────────────────────────────────────────
    // Test 5: Cannot sign with non-authorized address
    // ────────────────────────────────────────────────────────────
    #[test]
    fn test_unauthorized_signer() {
        let t = setup_multisig();

        let mut signers = Vec::new(&t.env);
        signers.push_back(t.admin1.clone());
        signers.push_back(t.admin2.clone());
        signers.push_back(t.admin3.clone());
        t.contract
            .try_initialize_multisig_admin(&signers, &2)
            .unwrap();

        let proposal_id = t.contract.try_propose_pause(&t.admin1).unwrap().unwrap();

        // Non-authorized address tries to sign
        let result = t.contract.try_sign_proposal(&t.other, &proposal_id);
        assert_eq!(result, Err(Ok(ContractError::NotAuthorizedSigner)));
    }

    // ────────────────────────────────────────────────────────────
    // Test 6: Prevent duplicate signature
    // ────────────────────────────────────────────────────────────
    #[test]
    fn test_prevent_duplicate_signature() {
        let t = setup_multisig();

        let mut signers = Vec::new(&t.env);
        signers.push_back(t.admin1.clone());
        signers.push_back(t.admin2.clone());
        signers.push_back(t.admin3.clone());
        t.contract
            .try_initialize_multisig_admin(&signers, &2)
            .unwrap();

        let proposal_id = t.contract.try_propose_pause(&t.admin1).unwrap().unwrap();

        // First signature
        t.contract
            .try_sign_proposal(&t.admin1, &proposal_id)
            .unwrap();

        // Same address tries to sign again
        let result = t.contract.try_sign_proposal(&t.admin1, &proposal_id);
        assert_eq!(result, Err(Ok(ContractError::AlreadySigned)));
    }

    // ────────────────────────────────────────────────────────────
    // Test 7: Cannot propose with non-signer
    // ────────────────────────────────────────────────────────────
    #[test]
    fn test_non_signer_cannot_propose() {
        let t = setup_multisig();

        let mut signers = Vec::new(&t.env);
        signers.push_back(t.admin1.clone());
        signers.push_back(t.admin2.clone());
        signers.push_back(t.admin3.clone());
        t.contract
            .try_initialize_multisig_admin(&signers, &2)
            .unwrap();

        // Non-signer tries to propose
        let result = t.contract.try_propose_pause(&t.other);
        assert_eq!(result, Err(Ok(ContractError::NotAuthorizedSigner)));
    }

    // ────────────────────────────────────────────────────────────
    // Test 8: Single signature not sufficient for 2-of-3
    // ────────────────────────────────────────────────────────────
    #[test]
    fn test_single_signature_insufficient() {
        let t = setup_multisig();

        let mut signers = Vec::new(&t.env);
        signers.push_back(t.admin1.clone());
        signers.push_back(t.admin2.clone());
        signers.push_back(t.admin3.clone());
        t.contract
            .try_initialize_multisig_admin(&signers, &2)
            .unwrap();

        let proposal_id = t.contract.try_propose_pause(&t.admin1).unwrap().unwrap();
        t.contract
            .try_sign_proposal(&t.admin1, &proposal_id)
            .unwrap();

        // Try to execute with only 1 signature (need 2)
        let result = t.contract.try_execute_proposal(&t.admin1, &proposal_id);
        assert_eq!(result, Err(Ok(ContractError::ThresholdNotReached)));
    }

    // ────────────────────────────────────────────────────────────
    // Test 9: Cannot execute non-existent proposal
    // ────────────────────────────────────────────────────────────
    #[test]
    fn test_execute_non_existent_proposal() {
        let t = setup_multisig();

        let mut signers = Vec::new(&t.env);
        signers.push_back(t.admin1.clone());
        signers.push_back(t.admin2.clone());
        signers.push_back(t.admin3.clone());
        t.contract
            .try_initialize_multisig_admin(&signers, &2)
            .unwrap();

        // Try to execute non-existent proposal
        let result = t.contract.try_execute_proposal(&t.admin1, &999);
        assert_eq!(result, Err(Ok(ContractError::ProposalNotFound)));
    }

    // ────────────────────────────────────────────────────────────
    // Test 10: Cannot execute already executed proposal
    // ────────────────────────────────────────────────────────────
    #[test]
    fn test_cannot_re_execute_proposal() {
        let t = setup_multisig();

        let mut signers = Vec::new(&t.env);
        signers.push_back(t.admin1.clone());
        signers.push_back(t.admin2.clone());
        signers.push_back(t.admin3.clone());
        t.contract
            .try_initialize_multisig_admin(&signers, &2)
            .unwrap();

        let proposal_id = t.contract.try_propose_pause(&t.admin1).unwrap().unwrap();
        t.contract
            .try_sign_proposal(&t.admin1, &proposal_id)
            .unwrap();
        t.contract
            .try_sign_proposal(&t.admin2, &proposal_id)
            .unwrap();

        // Execute once
        t.contract
            .try_execute_proposal(&t.admin1, &proposal_id)
            .unwrap();

        // Try to execute again
        let result = t.contract.try_execute_proposal(&t.admin1, &proposal_id);
        assert_eq!(result, Err(Ok(ContractError::ProposalAlreadyExecuted)));
    }

    // ────────────────────────────────────────────────────────────
    // Test 11: Invalid multisig config (threshold > signers)
    // ────────────────────────────────────────────────────────────
    #[test]
    fn test_invalid_multisig_config() {
        let t = setup_multisig();

        let mut signers = Vec::new(&t.env);
        signers.push_back(t.admin1.clone());
        signers.push_back(t.admin2.clone());

        // Threshold (3) > signer count (2)
        let result = t.contract.try_initialize_multisig_admin(&signers, &3);
        assert_eq!(result, Err(Ok(ContractError::InvalidMultisigConfig)));
    }

    // ────────────────────────────────────────────────────────────
    // Test 12: Propose unpause action
    // ────────────────────────────────────────────────────────────
    #[test]
    fn test_propose_unpause_action() {
        let t = setup_multisig();

        let mut signers = Vec::new(&t.env);
        signers.push_back(t.admin1.clone());
        signers.push_back(t.admin2.clone());
        signers.push_back(t.admin3.clone());
        t.contract
            .try_initialize_multisig_admin(&signers, &2)
            .unwrap();

        // First pause
        let pause_id = t.contract.try_propose_pause(&t.admin1).unwrap().unwrap();
        t.contract.try_sign_proposal(&t.admin1, &pause_id).unwrap();
        t.contract.try_sign_proposal(&t.admin2, &pause_id).unwrap();
        t.contract
            .try_execute_proposal(&t.admin1, &pause_id)
            .unwrap();

        // Then unpause
        let unpause_id = t.contract.try_propose_unpause(&t.admin1).unwrap().unwrap();
        t.contract
            .try_sign_proposal(&t.admin1, &unpause_id)
            .unwrap();
        t.contract
            .try_sign_proposal(&t.admin2, &unpause_id)
            .unwrap();
        t.contract
            .try_execute_proposal(&t.admin1, &unpause_id)
            .unwrap();

        // Verify contract is unpaused
        assert!(!t.contract.is_paused());
    }

    // ────────────────────────────────────────────────────────────
    // Test 13: 3-of-3 threshold requires all signers
    // ────────────────────────────────────────────────────────────
    #[test]
    fn test_3of3_threshold_all_signers_required() {
        let t = setup_multisig();

        let mut signers = Vec::new(&t.env);
        signers.push_back(t.admin1.clone());
        signers.push_back(t.admin2.clone());
        signers.push_back(t.admin3.clone());
        t.contract
            .try_initialize_multisig_admin(&signers, &3)
            .unwrap();

        let proposal_id = t.contract.try_propose_pause(&t.admin1).unwrap().unwrap();

        // Get all three to sign
        t.contract
            .try_sign_proposal(&t.admin1, &proposal_id)
            .unwrap();
        t.contract
            .try_sign_proposal(&t.admin2, &proposal_id)
            .unwrap();

        // Should fail with only 2 signatures
        let result = t.contract.try_execute_proposal(&t.admin1, &proposal_id);
        assert_eq!(result, Err(Ok(ContractError::ThresholdNotReached)));

        // Third signature makes it succeed
        t.contract
            .try_sign_proposal(&t.admin3, &proposal_id)
            .unwrap();
        t.contract
            .try_execute_proposal(&t.admin1, &proposal_id)
            .unwrap();
    }

    // ────────────────────────────────────────────────────────────
    // Test 14: Signature order doesn't matter
    // ────────────────────────────────────────────────────────────
    #[test]
    fn test_signature_order_doesnt_matter() {
        let t = setup_multisig();

        let mut signers = Vec::new(&t.env);
        signers.push_back(t.admin1.clone());
        signers.push_back(t.admin2.clone());
        signers.push_back(t.admin3.clone());
        t.contract
            .try_initialize_multisig_admin(&signers, &2)
            .unwrap();

        let proposal_id = t.contract.try_propose_pause(&t.admin1).unwrap().unwrap();

        // Sign in reverse order
        t.contract
            .try_sign_proposal(&t.admin3, &proposal_id)
            .unwrap();
        t.contract
            .try_sign_proposal(&t.admin1, &proposal_id)
            .unwrap();

        // Should still execute successfully
        t.contract
            .try_execute_proposal(&t.admin2, &proposal_id)
            .unwrap();
    }

    // ────────────────────────────────────────────────────────────
    // Test 15: Proposal expires after window (Issue #483)
    // ────────────────────────────────────────────────────────────
    #[test]
    fn test_proposal_expires_after_window() {
        let t = setup_multisig();

        let mut signers = Vec::new(&t.env);
        signers.push_back(t.admin1.clone());
        signers.push_back(t.admin2.clone());
        signers.push_back(t.admin3.clone());
        t.contract
            .try_initialize_multisig_admin(&signers, &2)
            .unwrap();

        let proposal_id = t.contract.try_propose_pause(&t.admin1).unwrap().unwrap();

        // First signer signs
        t.contract
            .try_sign_proposal(&t.admin1, &proposal_id)
            .unwrap();

        // Advance ledger past the multisig window (17_280 ledgers)
        let mut ledger = t.env.ledger().get();
        ledger.sequence_number += 17_281;
        t.env.ledger().set(ledger);

        // Second signer tries to sign after expiration
        let result = t.contract.try_sign_proposal(&t.admin2, &proposal_id);

        // Should fail because proposal has expired
        assert!(result.is_err());

        // Execution should also fail
        let result = t.contract.try_execute_proposal(&t.admin1, &proposal_id);
        assert!(result.is_err());
    }

    // ────────────────────────────────────────────────────────────
    // Test 16: Production threshold flow (2-of-3) (Issue #638)
    //
    // Mirrors the production multi-sig configuration documented in
    // docs/multisig-admin-runbook.md: 3 independent signer keys and a
    // threshold of 2 (minimum 2-of-3). Verifies the exact propose →
    // sign → execute lifecycle operators will run at launch, including
    // that a single compromised key is never sufficient.
    // ────────────────────────────────────────────────────────────
    #[test]
    fn test_production_threshold_multisig_flow() {
        let t = setup_multisig();

        // Production signer set: 3 independent keys, threshold 2-of-3.
        let mut signers = Vec::new(&t.env);
        signers.push_back(t.admin1.clone());
        signers.push_back(t.admin2.clone());
        signers.push_back(t.admin3.clone());
        t.contract
            .try_initialize_multisig_admin(&signers, &2)
            .unwrap();

        // 1. An authorized signer proposes a pause.
        let proposal_id = t.contract.try_propose_pause(&t.admin1).unwrap().unwrap();
        assert!(proposal_id > 0);

        // 2. A single signature must NOT be sufficient — one compromised key
        //    cannot pause the contract.
        t.contract
            .try_sign_proposal(&t.admin1, &proposal_id)
            .unwrap();
        let exec = t.contract.try_execute_proposal(&t.admin1, &proposal_id);
        assert_eq!(exec, Err(Ok(ContractError::ThresholdNotReached)));
        assert!(!t.contract.is_paused());

        // 3. Second independent key reaches the 2-of-3 threshold.
        t.contract
            .try_sign_proposal(&t.admin2, &proposal_id)
            .unwrap();
        t.contract
            .try_execute_proposal(&t.admin1, &proposal_id)
            .unwrap();

        // 4. The action is applied — contract is now paused.
        assert!(t.contract.is_paused());

        // 5. The same threshold governs recovery: two signatures unpause.
        let unpause_id = t.contract.try_propose_unpause(&t.admin2).unwrap().unwrap();
        t.contract
            .try_sign_proposal(&t.admin2, &unpause_id)
            .unwrap();
        t.contract
            .try_sign_proposal(&t.admin3, &unpause_id)
            .unwrap();
        t.contract
            .try_execute_proposal(&t.admin2, &unpause_id)
            .unwrap();
        assert!(!t.contract.is_paused());

        // 6. A non-signer can never propose or sign.
        let result = t.contract.try_propose_pause(&t.other);
        assert_eq!(result, Err(Ok(ContractError::NotAuthorizedSigner)));
    }
}
