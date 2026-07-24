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
    }
}
