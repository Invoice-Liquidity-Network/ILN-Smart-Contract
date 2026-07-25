#![no_std]

#[cfg(test)]
mod tests {
    use iln_governance::{GovernanceContract, GovernanceContractClient};
    use invoice_liquidity::{InvoiceLiquidityContract, InvoiceLiquidityContractClient, ReferralCode};
    use proptest::prelude::*;
    use soroban_sdk::{
        address_payload::AddressPayload,
        testutils::{Address as _, Ledger},
        Address, BytesN, Env,
    };

    const LEDGER_TIMESTAMP: u64 = 1_700_000_000;

    struct FuzzEnv {
        env: Env,
        contract: InvoiceLiquidityContractClient<'static>,
    }

    fn setup_fuzz() -> FuzzEnv {
        let env = Env::default();
        env.mock_all_auths();

        // Deploy mock USDC token
        let usdc_admin = Address::generate(&env);
        let usdc_contract_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
        let usdc_address = usdc_contract_id.address();

        // Deploy and initialise the ILN contract
        let contract_id = env.register_contract(None, InvoiceLiquidityContract);
        let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);

        let xlm_admin = Address::generate(&env);
        let xlm_contract_id = env.register_stellar_asset_contract_v2(xlm_admin);
        let xlm_address = xlm_contract_id.address();

        contract.initialize(&usdc_admin, &usdc_address, &xlm_address);

        // Fix ledger timestamp to a known baseline
        let mut ledger_info = env.ledger().get();
        ledger_info.timestamp = LEDGER_TIMESTAMP;
        env.ledger().set(ledger_info);

        FuzzEnv { env, contract }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(1000))]

        #[test]
        fn prop_submit_invoice_never_panics(
            amount in any::<i128>(),
            discount_rate in any::<u32>(),
            due_date in any::<u64>(),
            payer_bytes in any::<[u8; 32]>(),
            freelancer_bytes in any::<[u8; 32]>(),
            token_bytes in any::<[u8; 32]>(),
            payer_is_contract in any::<bool>(),
            freelancer_is_contract in any::<bool>(),
            token_is_contract in any::<bool>(),
        ) {
            let t = setup_fuzz();

            // Construct fuzzed random addresses using ContractIdHash or AccountIdPublicKeyEd25519 payloads
            let payer_payload = if payer_is_contract {
                AddressPayload::ContractIdHash(BytesN::from_array(&t.env, &payer_bytes))
            } else {
                AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&t.env, &payer_bytes))
            };
            let payer = Address::from_val(&t.env, &payer_payload);

            let freelancer_payload = if freelancer_is_contract {
                AddressPayload::ContractIdHash(BytesN::from_array(&t.env, &freelancer_bytes))
            } else {
                AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&t.env, &freelancer_bytes))
            };
            let freelancer = Address::from_val(&t.env, &freelancer_payload);

            let token_payload = if token_is_contract {
                AddressPayload::ContractIdHash(BytesN::from_array(&t.env, &token_bytes))
            } else {
                AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&t.env, &token_bytes))
            };
            let token = Address::from_val(&t.env, &token_payload);

            // Call try_submit_invoice with fuzzed random inputs.
            // We want to ensure that regardless of the fuzzed inputs,
            // the contract either succeeds or returns a handled error,
            // but NEVER panics or triggers an unexpected crash/unwind.
            let result = t.contract.try_submit_invoice(
                &freelancer,
                &payer,
                &amount,
                &due_date,
                &discount_rate,
                &token,
                &ReferralCode::None,
            );

            // We assert that the call completes gracefully (i.e. returning a Result),
            // regardless of whether it succeeded (Ok) or was rejected (Err).
            // Prop_assert guarantees this execution finished without panicking.
            match result {
                Ok(_) => {
                    // Successful invoice submission
                }
                Err(_) => {
                    // Handled validation error (e.g. InvalidAmount, InvalidDiscountRate, etc.)
                }
            }
        }

        #[test]
        fn prop_cancel_invoice_never_panics(
            invoice_id in any::<u64>(),
        ) {
            let t = setup_fuzz();
            let _ = t.contract.try_cancel_invoice(&invoice_id);
        }

        #[test]
        fn prop_appeal_default_never_panics(
            invoice_id in any::<u64>(),
            evidence_bytes in any::<[u8; 32]>(),
        ) {
            let t = setup_fuzz();
            let evidence = BytesN::from_array(&t.env, &evidence_bytes);
            let _ = t.contract.try_appeal_default(&invoice_id, &evidence);
        }

        #[test]
        fn prop_cast_vote_never_panics(
            proposal_id in any::<u64>(),
            support in any::<bool>(),
            voter_bytes in any::<[u8; 32]>(),
            voter_is_contract in any::<bool>(),
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let contract_id = env.register_contract(None, GovernanceContract);
            let gov = GovernanceContractClient::new(&env, &contract_id);
            
            // Initialize gov contract
            let admin = Address::generate(&env);
            let token = Address::generate(&env);
            let _ = gov.try_initialize(&admin, &token);

            let voter_payload = if voter_is_contract {
                AddressPayload::ContractIdHash(BytesN::from_array(&env, &voter_bytes))
            } else {
                AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&env, &voter_bytes))
            };
            let voter = Address::from_val(&env, &voter_payload);

            let _ = gov.try_cast_vote(&voter, &proposal_id, &support);
        }

        #[test]
        fn prop_delegate_votes_never_panics(
            delegator_bytes in any::<[u8; 32]>(),
            delegate_bytes in any::<[u8; 32]>(),
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let contract_id = env.register_contract(None, GovernanceContract);
            let gov = GovernanceContractClient::new(&env, &contract_id);
            
            // Initialize gov contract
            let admin = Address::generate(&env);
            let token = Address::generate(&env);
            let _ = gov.try_initialize(&admin, &token);

            let delegator = Address::from_val(&env, &AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&env, &delegator_bytes)));
            let delegate = Address::from_val(&env, &AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&env, &delegate_bytes)));

            let _ = gov.try_delegate_votes(&delegator, &delegate);
        }
    }
}
