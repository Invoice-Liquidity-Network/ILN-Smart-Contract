#![cfg(test)]

//! Tests for the fixed-size top-payers heap (Issue #77).

use super::*;
use crate::test::setup;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

#[allow(dead_code)]
fn top_scores(client: &InvoiceLiquidityContractClient, limit: u32) -> soroban_sdk::Vec<u32> {
    let entries = client.get_top_payers(&limit);
    let mut scores = soroban_sdk::Vec::new(&client.env);
    for entry in entries.iter() {
        scores.push_back(entry.score);
    }
    scores
}

#[test]
fn test_get_top_payers_empty() {
    let t = setup();
    let top = t.contract.get_top_payers(&10);
    assert_eq!(top.len(), 0);
}

#[test]
fn test_top_payers_tracks_score_updates() {
    let t = setup();
    let payer_a = Address::generate(&t.env);
    let payer_b = Address::generate(&t.env);

    t.env.as_contract(&t.contract.address, || {
        invoice::set_payer_score(&t.env, &payer_a, 90);
        invoice::set_payer_score(&t.env, &payer_b, 75);
    });

    let top = t.contract.get_top_payers(&10);
    assert_eq!(top.len(), 2);
    assert_eq!(top.get(0).unwrap().score, 90);
    assert_eq!(top.get(0).unwrap().address, payer_a);
    assert_eq!(top.get(1).unwrap().score, 75);
}

#[test]
fn test_top_payers_respects_limit() {
    let t = setup();

    t.env.as_contract(&t.contract.address, || {
        for i in 0..5u32 {
            let payer = Address::generate(&t.env);
            invoice::set_payer_score(&t.env, &payer, 60 + i);
        }
    });

    let top = t.contract.get_top_payers(&3);
    assert_eq!(top.len(), 3);
    assert_eq!(top.get(0).unwrap().score, 64);
    assert_eq!(top.get(1).unwrap().score, 63);
    assert_eq!(top.get(2).unwrap().score, 62);
}

#[test]
fn test_top_payers_updates_after_many_score_changes() {
    let t = setup();
    let mut tracked = soroban_sdk::Vec::new(&t.env);

    // Exercise heap maintenance across multiple smaller batches to stay within
    // Soroban test resource limits while still exceeding the top-50 capacity.
    for batch in 0..3u32 {
        t.env.as_contract(&t.contract.address, || {
            for i in 0..20u32 {
                let payer = Address::generate(&t.env);
                tracked.push_back(payer.clone());
                invoice::set_payer_score(&t.env, &payer, 50 + batch * 10 + i);
            }
        });
    }

    t.env.as_contract(&t.contract.address, || {
        let leader = tracked.get(tracked.len() - 1).unwrap();
        invoice::set_payer_score(&t.env, &leader, 40);

        let challenger = Address::generate(&t.env);
        invoice::set_payer_score(&t.env, &challenger, 100);
    });

    let top = t.contract.get_top_payers(&50);
    assert_eq!(top.len(), 50);
    assert_eq!(top.get(0).unwrap().score, 100);
    assert!(top.get(0).unwrap().score >= top.get(49).unwrap().score);

    let demoted = tracked.get(tracked.len() - 1).unwrap();
    let mut leader_still_present = false;
    for entry in top.iter() {
        if entry.address == demoted {
            leader_still_present = true;
        }
    }
    assert!(
        !leader_still_present,
        "demoted payer should fall out of the top-50 heap"
    );
}

#[test]
fn test_mark_paid_updates_top_payers_heap() {
    let t = setup();
    let due_date = t.env.ledger().timestamp() + 60 * 60 * 24 * 30;
    let amount: i128 = 1_000_000_000;
    let discount_rate: u32 = 300;

    assert_eq!(t.contract.payer_score(&t.payer), 50);
    assert_eq!(t.contract.get_top_payers(&10).len(), 0);

    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &amount,
        &due_date,
        &discount_rate,
        &t.token.address,
        &ReferralCode::None,
    );
    t.contract.fund_invoice(&t.funder, &id, &amount, &false);
    t.contract.mark_paid(&id, &amount);

    assert_eq!(t.contract.payer_score(&t.payer), 51);

    let top = t.contract.get_top_payers(&1);
    assert_eq!(top.len(), 1);
    assert_eq!(top.get(0).unwrap().address, t.payer);
    assert_eq!(top.get(0).unwrap().score, 51);
}
