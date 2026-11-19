#![cfg(test)]

use super::*;
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, BytesN, Symbol,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NftOp {
    Submit,
    FundPartially(usize, i128), // funder index (0, 1, 2), fund amount
    TransferLp(usize), // transfer to new LP (0, 1, 2)
    MarkPaid(i128), // pay amount
    ClaimDefault,
    AppealDefault,
    ResolveAppeal(bool), // upheld
    Dispute,
    ResolveDispute(u32), // resolution (1 or 2)
}

fn nft_op_strategy() -> impl Strategy<Value = NftOp> {
    prop_oneof![
        Just(NftOp::Submit),
        (0usize..3usize, 1i128..=1_000_000_000i128).prop_map(|(idx, amt)| NftOp::FundPartially(idx, amt)),
        (0usize..3usize).prop_map(NftOp::TransferLp),
        (1i128..=1_000_000_000i128).prop_map(NftOp::MarkPaid),
        Just(NftOp::ClaimDefault),
        Just(NftOp::AppealDefault),
        prop::bool::ANY.prop_map(NftOp::ResolveAppeal),
        Just(NftOp::Dispute),
        (1u32..=2u32).prop_map(NftOp::ResolveDispute),
    ]
}

fn setup_nft_proptest_env(
    env: &Env,
) -> (
    InvoiceLiquidityContractClient<'static>,
    TokenClient<'static>,
    Address,
    Address,
    std::vec::Vec<Address>,
) {
    env.mock_all_auths();

    let usdc_admin = Address::generate(env);
    let usdc_contract_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_address = usdc_contract_id.address();

    let eurc_admin = Address::generate(env);
    let eurc_contract_id = env.register_stellar_asset_contract_v2(eurc_admin.clone());
    let eurc_address = eurc_contract_id.address();

    let token = TokenClient::new(env, &usdc_address);
    let token_admin = StellarAssetClient::new(env, &usdc_address);

    let freelancer = Address::generate(env);
    let payer = Address::generate(env);
    
    let mut lp_pool = std::vec::Vec::new();
    for _ in 0..3 {
        lp_pool.push(Address::generate(env));
    }

    // Mint USDC to the actors
    let massive_amount = 1_000_000_000_000_000_000i128;
    for lp in &lp_pool {
        token_admin.mint(lp, &massive_amount);
    }
    token_admin.mint(&payer, &massive_amount);

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(env, &contract_id);

    // Fund contract treasury
    token_admin.mint(&contract.address, &massive_amount);

    let xlm_admin = Address::generate(env);
    let xlm_contract_id = env.register_stellar_asset_contract_v2(xlm_admin);
    let xlm_address = xlm_contract_id.address();

    contract.initialize(&usdc_admin, &usdc_address, &eurc_address, &xlm_address);

    let mut ledger_info = env.ledger().get();
    ledger_info.timestamp = 1_700_000_000;
    ledger_info.sequence_number = 100;
    env.ledger().set(ledger_info);

    (contract, token, freelancer, payer, lp_pool)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(50))]

    #[test]
    fn test_nft_lifecycle_invariants(
        events in prop::collection::vec(nft_op_strategy(), 1..50),
    ) {
        let env = Env::default();
        let (contract, token, freelancer, payer, lp_pool) = setup_nft_proptest_env(&env);

        let mut invoice_submitted = false;
        let mut invoice_id = 0u64;
        let mut due_date = 0u64;
        let invoice_amount = 1_000_000_000i128;

        for event in events {
            match event {
                NftOp::Submit => {
                    if !invoice_submitted {
                        due_date = env.ledger().timestamp() + 30 * 24 * 3600;
                        invoice_id = contract.submit_invoice(
                            &freelancer,
                            &payer,
                            &invoice_amount,
                            &due_date,
                            &300,
                            &token.address,
                            &ReferralCode::None,
                        );
                        invoice_submitted = true;
                    }
                }
                NftOp::FundPartially(lp_idx, mut amt) => {
                    if invoice_submitted {
                        // Clamp amount so we don't overfund unless we want to test that rejection
                        let current_inv = contract.query_invoice(&invoice_id);
                        if let Some(inv) = current_inv {
                            let remaining = invoice_amount.saturating_sub(inv.amount_funded);
                            if remaining > 0 {
                                if amt > remaining {
                                    amt = remaining;
                                }
                                let lp = &lp_pool[lp_idx];
                                let _ = contract.try_fund_invoice(lp, &invoice_id, &amt, &false);
                            }
                        }
                    }
                }
                NftOp::TransferLp(lp_idx) => {
                    if invoice_submitted {
                        let current_inv = contract.query_invoice(&invoice_id);
                        if let Some(inv) = current_inv {
                            if inv.status == InvoiceStatus::Funded {
                                let new_lp = &lp_pool[lp_idx];
                                let _ = contract.try_transfer_lp_position(&invoice_id, new_lp);
                            }
                        }
                    }
                }
                NftOp::MarkPaid(mut amt) => {
                    if invoice_submitted {
                        let current_inv = contract.query_invoice(&invoice_id);
                        if let Some(inv) = current_inv {
                            if inv.status == InvoiceStatus::Funded {
                                let remaining = invoice_amount.saturating_sub(inv.amount_paid);
                                if remaining > 0 {
                                    if amt > remaining {
                                        amt = remaining;
                                    }
                                    let _ = contract.try_mark_paid(&invoice_id, &amt);
                                }
                            }
                        }
                    }
                }
                NftOp::ClaimDefault => {
                    if invoice_submitted {
                        let current_inv = contract.query_invoice(&invoice_id);
                        if let Some(inv) = current_inv {
                            if inv.status == InvoiceStatus::Funded {
                                // Warp time past due date
                                let mut ledger_info = env.ledger().get();
                                ledger_info.timestamp = due_date + 1;
                                env.ledger().set(ledger_info);

                                if let Some(ref lp) = inv.funder {
                                    let _ = contract.try_claim_default(lp, &invoice_id);
                                }
                            }
                        }
                    }
                }
                NftOp::AppealDefault => {
                    if invoice_submitted {
                        let current_inv = contract.query_invoice(&invoice_id);
                        if let Some(inv) = current_inv {
                            if inv.status == InvoiceStatus::Defaulted {
                                let empty_hash = BytesN::from_array(&env, &[0u8; 32]);
                                let _ = contract.try_appeal_default(&invoice_id, &empty_hash);
                            }
                        }
                    }
                }
                NftOp::ResolveAppeal(upheld) => {
                    if invoice_submitted {
                        let current_inv = contract.query_invoice(&invoice_id);
                        if let Some(inv) = current_inv {
                            if inv.status == InvoiceStatus::Appealed {
                                let _ = contract.try_resolve_appeal(&invoice_id, &upheld);
                            }
                        }
                    }
                }
                NftOp::Dispute => {
                    if invoice_submitted {
                        let current_inv = contract.query_invoice(&invoice_id);
                        if let Some(inv) = current_inv {
                            if inv.status == InvoiceStatus::Funded {
                                let empty_hash = BytesN::from_array(&env, &[0u8; 32]);
                                let _ = contract.try_dispute_invoice(&invoice_id, &empty_hash);
                            }
                        }
                    }
                }
                NftOp::ResolveDispute(resolution) => {
                    if invoice_submitted {
                        let current_inv = contract.query_invoice(&invoice_id);
                        if let Some(inv) = current_inv {
                            if inv.status == InvoiceStatus::Disputed {
                                let empty_hash = BytesN::from_array(&env, &[0u8; 32]);
                                let _ = contract.try_resolve_dispute(&invoice_id, &empty_hash, &resolution);
                            }
                        }
                    }
                }
            }

            // Assert Invariants after each step
            if invoice_submitted {
                let invoice_opt = contract.query_invoice(&invoice_id);
                prop_assert!(invoice_opt.is_some(), "Invoice should exist");
                let inv = invoice_opt.unwrap();

                let nft_metadata_opt = contract.query_nft_metadata(&invoice_id);
                let nft_owner_opt = contract.query_nft_owner(&invoice_id);

                let should_nft_exist = match inv.status {
                    InvoiceStatus::Funded
                    | InvoiceStatus::PartiallyFunded
                    | InvoiceStatus::Defaulted
                    | InvoiceStatus::Appealed
                    | InvoiceStatus::Disputed => true,
                    _ => false,
                };

                if should_nft_exist {
                    prop_assert!(nft_metadata_opt.is_some(), "NFT metadata should exist for status {:?}", inv.status);
                    prop_assert!(nft_owner_opt.is_some(), "NFT owner should exist for status {:?}", inv.status);

                    let nft_meta = nft_metadata_opt.unwrap();
                    let nft_owner = nft_owner_opt.unwrap();

                    prop_assert_eq!(nft_meta.invoice_id, invoice_id);
                    prop_assert_eq!(nft_meta.amount, invoice_amount);
                    prop_assert_eq!(nft_meta.token, token.address);
                    prop_assert_eq!(nft_meta.owner, nft_owner);

                    // Determine the expected owner from the invoice state
                    let expected_owner = if let Some(ref lp) = inv.funder {
                        lp.clone()
                    } else {
                        // PartiallyFunded: compute lead LP from funders list
                        let mut funders_vec = std::vec::Vec::new();
                        env.as_contract(&contract.address, || {
                            let funders = crate::invoice::get_invoice_funders(&env, invoice_id);
                            for i in 0..funders.len() {
                                funders_vec.push(funders.get(i).unwrap());
                            }
                        });

                        prop_assert!(!funders_vec.is_empty(), "Funders list should not be empty for PartiallyFunded invoice");

                        let mut lead_lp = funders_vec[0].0.clone();
                        let mut max_amt = funders_vec[0].1;
                        for i in 1..funders_vec.len() {
                            let (addr, amt) = &funders_vec[i];
                            if *amt > max_amt {
                                max_amt = *amt;
                                lead_lp = addr.clone();
                            }
                        }
                        lead_lp
                    };

                    prop_assert_eq!(nft_owner, expected_owner, "NFT owner desync! Expected: {:?}, Got: {:?}", expected_owner, nft_owner);
                } else {
                    prop_assert!(nft_metadata_opt.is_none(), "NFT metadata should NOT exist for status {:?}", inv.status);
                    prop_assert!(nft_owner_opt.is_none(), "NFT owner should NOT exist for status {:?}", inv.status);
                }
            }
        }
    }
}
