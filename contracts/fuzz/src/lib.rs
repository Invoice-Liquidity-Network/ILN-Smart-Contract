#![no_std]

#[cfg(test)]
mod tests {
    use iln_distribution::{IlnDistribution, IlnDistributionClient};
    use iln_governance::{GovContract, GovContractClient, ProposalAction};
    use insurance_pool::{InsurancePool, InsurancePoolClient};
    use invoice_liquidity::{
        InvoiceLiquidityContract, InvoiceLiquidityContractClient, ReferralCode,
    };
    use proptest::prelude::*;
    use reputation_bonus::{ReputationBonusContract, ReputationBonusContractClient};
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

        let eurc_address = Address::generate(&env);

        contract.initialize(&usdc_admin, &usdc_address, &eurc_address, &xlm_address);

        // Fix ledger timestamp to a known baseline
        let mut ledger_info = env.ledger().get();
        ledger_info.timestamp = LEDGER_TIMESTAMP;
        env.ledger().set(ledger_info);

        FuzzEnv { env, contract }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]

        // ============================================================
        // 1. invoice_liquidity fuzz targets
        // ============================================================

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

            let payer_payload = if payer_is_contract {
                AddressPayload::ContractIdHash(BytesN::from_array(&t.env, &payer_bytes))
            } else {
                AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&t.env, &payer_bytes))
            };
            let payer = payer_payload.to_address(&t.env);

            let freelancer_payload = if freelancer_is_contract {
                AddressPayload::ContractIdHash(BytesN::from_array(&t.env, &freelancer_bytes))
            } else {
                AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&t.env, &freelancer_bytes))
            };
            let freelancer = freelancer_payload.to_address(&t.env);

            let token_payload = if token_is_contract {
                AddressPayload::ContractIdHash(BytesN::from_array(&t.env, &token_bytes))
            } else {
                AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&t.env, &token_bytes))
            };
            let token = token_payload.to_address(&t.env);

            let _ = t.contract.try_submit_invoice(
                &freelancer,
                &payer,
                &amount,
                &due_date,
                &discount_rate,
                &token,
                &ReferralCode::None,
            );
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

            let funder_payload = if funder_is_contract {
                AddressPayload::ContractIdHash(BytesN::from_array(&t.env, &funder_bytes))
            } else {
                AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&t.env, &funder_bytes))
            };
            let funder = funder_payload.to_address(&t.env);

            let token_payload = if token_is_contract {
                AddressPayload::ContractIdHash(BytesN::from_array(&t.env, &token_bytes))
            } else {
                AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&t.env, &token_bytes))
            };
            let token = token_payload.to_address(&t.env);

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

            let _ = t.contract.try_fund_invoice(
                &funder,
                &invoice_id,
                &fund_amount,
                &require_oracle,
            );
        }

        #[test]
        fn prop_mark_paid_never_panics(
            invoice_id in any::<u64>(),
            amount in any::<i128>(),
        ) {
            let t = setup_fuzz();
            let _ = t.contract.try_mark_paid(&invoice_id, &amount);
        }

        // ============================================================
        // 2. iln_governance fuzz targets
        // ============================================================

        #[test]
        fn prop_cast_vote_never_panics(
            proposal_id in any::<u64>(),
            support in any::<bool>(),
            voter_bytes in any::<[u8; 32]>(),
            voter_is_contract in any::<bool>(),
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let contract_id = env.register_contract(None, GovContract);
            let gov = GovContractClient::new(&env, &contract_id);

            let iln_contract = Address::generate(&env);
            let dist_contract = Address::generate(&env);
            let admin = Address::generate(&env);
            let token = Address::generate(&env);
            let _ = gov.try_initialize(&iln_contract, &dist_contract, &token, &admin, &10_000);

            let voter_payload = if voter_is_contract {
                AddressPayload::ContractIdHash(BytesN::from_array(&env, &voter_bytes))
            } else {
                AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&env, &voter_bytes))
            };
            let voter = voter_payload.to_address(&env);

            let _ = gov.try_cast_vote(&voter, &proposal_id, &support);
        }

        #[test]
        fn prop_create_proposal_never_panics(
            proposer_bytes in any::<[u8; 32]>(),
            desc_bytes in any::<[u8; 32]>(),
            rate in any::<i128>(),
            insurance_rate in any::<u32>(),
            action_choice in 0..4u32,
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let contract_id = env.register_contract(None, GovContract);
            let gov = GovContractClient::new(&env, &contract_id);

            let iln_contract = Address::generate(&env);
            let dist_contract = Address::generate(&env);
            let admin = Address::generate(&env);
            let token = Address::generate(&env);
            let _ = gov.try_initialize(&iln_contract, &dist_contract, &token, &admin, &10_000);

            let proposer = AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&env, &proposer_bytes)).to_address(&env);
            let desc_hash = BytesN::from_array(&env, &desc_bytes);

            let action = match action_choice {
                0 => ProposalAction::UpdateFreelancerRewardRate(rate),
                1 => ProposalAction::UpdateLpRewardRate(rate),
                2 => ProposalAction::UpdatePayerRewardRate(rate),
                _ => ProposalAction::UpdateInsurancePremiumRate(insurance_rate),
            };

            let _ = gov.try_create_proposal(&proposer, &action, &desc_hash, &0);
        }

        #[test]
        fn prop_delegate_votes_never_panics(
            delegator_bytes in any::<[u8; 32]>(),
            delegate_bytes in any::<[u8; 32]>(),
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let contract_id = env.register_contract(None, GovContract);
            let gov = GovContractClient::new(&env, &contract_id);

            let iln_contract = Address::generate(&env);
            let dist_contract = Address::generate(&env);
            let admin = Address::generate(&env);
            let token = Address::generate(&env);
            let _ = gov.try_initialize(&iln_contract, &dist_contract, &token, &admin, &10_000);

            let delegator = AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&env, &delegator_bytes)).to_address(&env);
            let delegate = AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&env, &delegate_bytes)).to_address(&env);

            let _ = gov.try_delegate_votes(&delegator, &delegate);
        }

        // ============================================================
        // 3. insurance_pool fuzz targets
        // ============================================================

        #[test]
        fn prop_insurance_deposit_premium_never_panics(
            amount in any::<i128>(),
            lp_bytes in any::<[u8; 32]>(),
            balance_cap in any::<i128>(),
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let contract_id = env.register_contract(None, InsurancePool);
            let pool = InsurancePoolClient::new(&env, &contract_id);

            let admin = Address::generate(&env);
            let usdc_admin = Address::generate(&env);
            let usdc = env.register_stellar_asset_contract_v2(usdc_admin).address();

            let _ = pool.try_initialize(&admin, &100_000, &usdc);
            let _ = pool.try_set_balance_cap(&balance_cap);

            let lp = AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&env, &lp_bytes)).to_address(&env);
            let _ = pool.try_deposit_premium(&lp, &amount);
        }

        #[test]
        fn prop_insurance_claim_never_panics(
            invoice_id in any::<u64>(),
            lp_bytes in any::<[u8; 32]>(),
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let contract_id = env.register_contract(None, InsurancePool);
            let pool = InsurancePoolClient::new(&env, &contract_id);

            let admin = Address::generate(&env);
            let usdc_admin = Address::generate(&env);
            let usdc = env.register_stellar_asset_contract_v2(usdc_admin).address();

            let _ = pool.try_initialize(&admin, &100_000, &usdc);
            let lp = AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&env, &lp_bytes)).to_address(&env);
            let _ = pool.try_claim(&invoice_id, &lp);
        }

        // ============================================================
        // 4. iln_distribution fuzz targets
        // ============================================================

        #[test]
        fn prop_distribution_reward_rate_updates_never_panics(
            new_lp_rate in any::<i128>(),
            new_freelancer_rate in any::<i128>(),
            new_payer_rate in any::<i128>(),
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let contract_id = env.register_contract(None, IlnDistribution);
            let dist = IlnDistributionClient::new(&env, &contract_id);

            let iln_contract = Address::generate(&env);
            let gov_token = Address::generate(&env);
            let _ = dist.try_initialize(&iln_contract, &gov_token);

            let _ = dist.try_set_lp_reward_rate(&new_lp_rate);
            let _ = dist.try_set_freelancer_reward_rate(&new_freelancer_rate);
            let _ = dist.try_set_payer_reward_rate(&new_payer_rate);
        }

        #[test]
        fn prop_distribution_accrual_and_claim_never_panics(
            volume in any::<i128>(),
            settled_on_time in any::<bool>(),
            user_bytes in any::<[u8; 32]>(),
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let contract_id = env.register_contract(None, IlnDistribution);
            let dist = IlnDistributionClient::new(&env, &contract_id);

            let iln_contract = Address::generate(&env);
            let gov_token_admin = Address::generate(&env);
            let gov_token = env.register_stellar_asset_contract_v2(gov_token_admin).address();
            let _ = dist.try_initialize(&iln_contract, &gov_token);

            let user = AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&env, &user_bytes)).to_address(&env);
            let payer = Address::generate(&env);

            let _ = dist.try_accrue_lp(&user, &volume);
            let _ = dist.try_accrue_settlement(&user, &payer, &settled_on_time);
            let _ = dist.try_claim_tokens(&user);
        }

        // ============================================================
        // 5. reputation_bonus fuzz targets
        // ============================================================

        #[test]
        fn prop_reputation_calculate_bonus_never_panics(
            score in any::<u32>(),
            base_discount_rate in any::<u32>(),
            high_rep_threshold in any::<u32>(),
            bonus_bps in any::<u32>(),
            min_discount_rate_bps in any::<u32>(),
        ) {
            let _ = reputation_bonus::rate_logic::calculate_effective_rate(
                base_discount_rate,
                score,
                high_rep_threshold,
                bonus_bps,
                min_discount_rate_bps,
            );
        }

        #[test]
        fn prop_reputation_submit_invoice_never_panics(
            amount in any::<i128>(),
            due_date in any::<u64>(),
            base_discount_rate_bps in any::<u32>(),
            freelancer_bytes in any::<[u8; 32]>(),
            payer_bytes in any::<[u8; 32]>(),
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let contract_id = env.register_contract(None, ReputationBonusContract);
            let rep_contract = ReputationBonusContractClient::new(&env, &contract_id);

            let admin = Address::generate(&env);
            let _ = rep_contract.try_init(&admin);

            let freelancer = AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&env, &freelancer_bytes)).to_address(&env);
            let payer = AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(&env, &payer_bytes)).to_address(&env);

            let _ = rep_contract.try_submit_invoice(
                &freelancer,
                &payer,
                &amount,
                &due_date,
                &base_discount_rate_bps,
            );
        }

        #[test]
        fn prop_reputation_mark_paid_and_default_never_panics(
            invoice_id in any::<u64>(),
        ) {
            let env = Env::default();
            env.mock_all_auths();
            let contract_id = env.register_contract(None, ReputationBonusContract);
            let rep_contract = ReputationBonusContractClient::new(&env, &contract_id);

            let admin = Address::generate(&env);
            let _ = rep_contract.try_init(&admin);

            let _ = rep_contract.try_mark_paid(&invoice_id);
            let _ = rep_contract.try_handle_default(&invoice_id);
        }
    }
}
