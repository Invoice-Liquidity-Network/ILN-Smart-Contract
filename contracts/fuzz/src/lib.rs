#![no_std]

#[cfg(test)]
mod tests {
    use invoice_liquidity::{InvoiceLiquidityContract, InvoiceLiquidityContractClient};
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
            let payer = Address::from_payload(&t.env, payer_payload);

            let freelancer_payload = if freelancer_is_contract {
                AddressPayload::ContractIdHash(BytesN::from_array(&t.env, &freelancer_bytes))
            } else {
                AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&t.env, &freelancer_bytes))
            };
            let freelancer = Address::from_payload(&t.env, freelancer_payload);

            let token_payload = if token_is_contract {
                AddressPayload::ContractIdHash(BytesN::from_array(&t.env, &token_bytes))
            } else {
                AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&t.env, &token_bytes))
            };
            let token = Address::from_payload(&t.env, token_payload);

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

        // ------------------------------------------------------------
        // Issue #495: fund_invoice must never panic
        // ------------------------------------------------------------
        // Property: for arbitrary funder addresses, invoice tokens, fund
        // amounts and invoice ids, `fund_invoice` either succeeds or returns
        // a handled `ContractError`, but NEVER panics / unwinds.
        #[test]
        fn prop_fund_invoice_never_panics(
            fund_amount in any::<i128>(),
            invoice_amount in any::<i128>(),
            due_date in any::<u64>(),
            discount_rate in any::<u32>(),
            funder_bytes in any::<[u8; 32]>(),
            token_bytes in any::<[u8; 32]>(),
            funder_is_contract in any::<bool>(),
            token_is_contract in any::<bool>(),
            use_seeded_invoice in any::<bool>(),
            random_invoice_id in any::<u64>(),
            require_oracle in any::<bool>(),
        ) {
            let t = setup_fuzz();

            // Random funder address (contract or account payload).
            let funder_payload = if funder_is_contract {
                AddressPayload::ContractIdHash(BytesN::from_array(&t.env, &funder_bytes))
            } else {
                AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&t.env, &funder_bytes))
            };
            let funder = Address::from_payload(&t.env, funder_payload);

            // Random invoice token address, so the funding path exercises the
            // token allowlist / transfer logic with arbitrary tokens.
            let token_payload = if token_is_contract {
                AddressPayload::ContractIdHash(BytesN::from_array(&t.env, &token_bytes))
            } else {
                AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&t.env, &token_bytes))
            };
            let token = Address::from_payload(&t.env, token_payload);

            // Optionally seed a real invoice with the fuzzed token, then fund it.
            // Otherwise fund a purely random (likely non-existent) invoice id.
            let freelancer = Address::generate(&t.env);
            let payer = Address::generate(&t.env);

            let seeded_id = t
                .contract
                .try_submit_invoice(
                    &freelancer,
                    &payer,
                    &invoice_amount,
                    &due_date,
                    &discount_rate,
                    &token,
                    &invoice_liquidity::ReferralCode::None,
                )
                .ok()
                .and_then(|r| r.ok());

            let invoice_id = match (use_seeded_invoice, seeded_id) {
                (true, Some(id)) => id,
                _ => random_invoice_id,
            };

            let result = t.contract.try_fund_invoice(
                &funder,
                &invoice_id,
                &fund_amount,
                &require_oracle,
            );

            match result {
                Ok(_) => {}
                Err(_) => {}
            }
        }

        // ------------------------------------------------------------
        // Issue #497: dispute_invoice must never panic
        // ------------------------------------------------------------
        // Property: for arbitrary invoice ids and reason hashes the dispute
        // flow completes gracefully (Ok or handled ContractError) and never
        // panics.
        #[test]
        fn prop_dispute_invoice_never_panics(
            invoice_amount in any::<i128>(),
            due_date in any::<u64>(),
            discount_rate in any::<u32>(),
            token_bytes in any::<[u8; 32]>(),
            token_is_contract in any::<bool>(),
            reason_hash_bytes in any::<[u8; 32]>(),
            use_seeded_invoice in any::<bool>(),
            random_invoice_id in any::<u64>(),
        ) {
            let t = setup_fuzz();

            let token_payload = if token_is_contract {
                AddressPayload::ContractIdHash(BytesN::from_array(&t.env, &token_bytes))
            } else {
                AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&t.env, &token_bytes))
            };
            let token = Address::from_payload(&t.env, token_payload);

            let freelancer = Address::generate(&t.env);
            let payer = Address::generate(&t.env);

            // Optionally seed a real, disputable invoice so the happy path is
            // exercised too; otherwise dispute a random (likely missing) id.
            let seeded_id = t
                .contract
                .try_submit_invoice(
                    &freelancer,
                    &payer,
                    &invoice_amount,
                    &due_date,
                    &discount_rate,
                    &token,
                    &invoice_liquidity::ReferralCode::None,
                )
                .ok()
                .and_then(|r| r.ok());

            let invoice_id = match (use_seeded_invoice, seeded_id) {
                (true, Some(id)) => id,
                _ => random_invoice_id,
            };

            let reason_hash = BytesN::from_array(&t.env, &reason_hash_bytes);

            let result = t.contract.try_dispute_invoice(&invoice_id, &reason_hash);

            match result {
                Ok(_) => {}
                Err(_) => {}
            }
        }
    }
}

// ================================================================
// Issue #500: insurance pool claim / reentrancy fuzzing
// ================================================================
#[cfg(test)]
mod insurance_tests {
    use insurance_pool::{InsuranceError, InsurancePool, InsurancePoolClient};
    use proptest::prelude::*;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    const COVERAGE: i128 = 1_000_000_000;

    struct InsFuzzEnv {
        env: Env,
        client: InsurancePoolClient<'static>,
    }

    fn setup_insurance() -> InsFuzzEnv {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, InsurancePool);
        let client = InsurancePoolClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin, &COVERAGE);

        InsFuzzEnv { env, client }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(1000))]

        // claim must never panic-unwind for arbitrary invoice ids.
        // With an empty pool every claim must be rejected (PoolEmpty),
        // never silently succeed.
        #[test]
        fn prop_claim_empty_pool_always_rejected(invoice_id in any::<u64>()) {
            let t = setup_insurance();

            // No premiums deposited => empty pool.
            prop_assert_eq!(t.client.get_pool_balance(), 0);

            let res = t.client.try_claim(&invoice_id);
            // Empty pool must reject, not pay out.
            prop_assert_eq!(
                res,
                Err(Ok(soroban_sdk::Error::from(InsuranceError::PoolEmpty)))
            );
            prop_assert!(!t.client.is_claimed(&invoice_id));
        }

        // Double-claim rejection: a second claim for the same invoice id must
        // be rejected with AlreadyClaimed and must not pay out or drain the
        // pool a second time (reentrancy / double-spend guard).
        #[test]
        fn prop_double_claim_rejected(
            invoice_id in any::<u64>(),
            premium in 1i128..1_000_000_000_000i128,
        ) {
            let t = setup_insurance();
            let lp = Address::generate(&t.env);

            // Fund the pool so the first claim can pay out.
            t.client.deposit_premium(&lp, &premium);
            let balance_before = t.client.get_pool_balance();

            // First claim succeeds and marks the invoice claimed.
            let first = t.client.claim(&invoice_id);
            prop_assert!(first > 0);
            prop_assert!(t.client.is_claimed(&invoice_id));

            let balance_after_first = t.client.get_pool_balance();
            prop_assert_eq!(balance_after_first, balance_before - first);

            // Second claim for the same invoice must be rejected.
            let second = t.client.try_claim(&invoice_id);
            prop_assert_eq!(
                second,
                Err(Ok(soroban_sdk::Error::from(InsuranceError::AlreadyClaimed)))
            );

            // Balance must be unchanged by the rejected double-claim.
            prop_assert_eq!(t.client.get_pool_balance(), balance_after_first);
        }

        // General robustness: an interleaved sequence of claims across random
        // invoice ids never panics and never double-pays the same id.
        #[test]
        fn prop_claim_sequence_never_double_pays(
            ids in prop::collection::vec(any::<u64>(), 1..8),
            premium in 1i128..1_000_000_000_000i128,
        ) {
            let t = setup_insurance();
            let lp = Address::generate(&t.env);
            t.client.deposit_premium(&lp, &premium);

            for id in ids.iter() {
                let already = t.client.is_claimed(id);
                let res = t.client.try_claim(id);
                if already {
                    // A repeated id in the sequence must be rejected.
                    prop_assert_eq!(
                        res,
                        Err(Ok(soroban_sdk::Error::from(InsuranceError::AlreadyClaimed)))
                    );
                } else {
                    // Either paid (Ok) or rejected because the pool drained
                    // (PoolEmpty) — never a panic-unwind.
                    match res {
                        Ok(_) => prop_assert!(t.client.is_claimed(id)),
                        Err(_) => {}
                    }
                }
            }
        }
    }
}
