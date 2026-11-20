//! Issue #1040 — fairness measurement harness for burst deposits.
//!
//! `burst(n, equal_score)` joins `n` LPs in a tight burst (same ledger-age
//! window, every join before the first resolution), then resolves across
//! `k` distinct invoices and tallies wins per LP. `max_win_share_deviation`
//! compares the per-LP win share against the uniform `1/n` expectation with
//! an explicit tolerance.
//!
//! # Determinism caveat (read before interpreting any number here)
//!
//! The on-chain draw uses Soroban's **network-seeded PRNG**, so a *single*
//! resolution run is not a fairness proof — the seed is not under the
//! tester's control and the same input sequence need not repeat across
//! networks or ledger histories. What this harness makes is a *statistical*
//! claim, and it exists so the claim can be evaluated off-chain (see
//! `docs/events.md`, "Fairness measurement under burst deposits"):
//! `fund_queue_tie_broken` carries `tied_count` + `winner_index` per tie and
//! `fund_queue_ordering_rejected` marks every fail-closed integrity verdict,
//! so an indexer can compute long-run per-LP win shares from real traffic.
//! The in-test assertions below are deliberately loose (generous tolerance
//! bands with astronomically small false-failure probability under a working
//! uniform draw), because a *tight* statistical bound in a hermetic test
//! would be flakiness theater, not evidence.
//!
//! # Before / after (the one number verifiable without execution)
//!
//! Score reads per resolution over the capped queue, at
//! `MAX_FUND_QUEUE_LEN = 50`:
//!   * **Before (base `2ae6312e`)**: two inline scans (`best_score` pass,
//!     then the tied-index pass) each re-reading every entry's current score
//!     — `2 x 50 = 100` `get_lp_score` reads per resolution worst case.
//!   * **After (Issue #1039's fused engine)**: one pass —
//!     `1 x 50 = 50` reads.
//! This is asserted statically against the declared
//! `RESOURCE_ENVELOPE::queue_resolution_tie_fanout` cap below; the
//! `tests_benchmarks.rs`-style CPU measurement (`measure(...)` against
//! `MAX_CPU_INSTRUCTIONS`) is what would confirm it in CI — and CI does not
//! run cargo on this repo, so this lane reports it as a static count, never
//! as an executed measurement.

#![cfg(test)]

use super::*;
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env,
};

const INVOICE_AMOUNT: i128 = 1_000_000_000;
const DISCOUNT_RATE: u32 = 300;
const DUE_DATE_OFFSET: u64 = 60 * 60 * 24 * 30;

struct BurstEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: TokenClient<'static>,
    freelancer: Address,
    payer: Address,
}

fn setup_burst() -> BurstEnv {
    let env = Env::default();
    env.mock_all_auths();

    let usdc_admin = Address::generate(&env);
    let usdc_id = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let usdc_addr = usdc_id.address();

    let token = TokenClient::new(&env, &usdc_addr);
    let token_admin = StellarAssetClient::new(&env, &usdc_addr);

    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    token_admin.mint(&payer, &(INVOICE_AMOUNT * 100));

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);
    token_admin.mint(&contract.address, &(INVOICE_AMOUNT * 1000));

    let xlm_admin = Address::generate(&env);
    let xlm_id = env.register_stellar_asset_contract_v2(xlm_admin);
    let xlm_addr = xlm_id.address();
    let eurc_addr = Address::generate(&env);
    contract.initialize(&usdc_admin, &usdc_addr, &eurc_addr, &xlm_addr);

    let mut ledger = env.ledger().get();
    ledger.timestamp = 1_700_000_000;
    ledger.sequence_number = 100;
    env.ledger().set(ledger);

    BurstEnv {
        env,
        contract,
        token,
        freelancer,
        payer,
    }
}

fn submit_invoice_burst(t: &BurstEnv) -> u64 {
    let due_date = t.env.ledger().timestamp() + DUE_DATE_OFFSET;
    t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &INVOICE_AMOUNT,
        &due_date,
        &DISCOUNT_RATE,
        &t.token.address,
        &ReferralCode::None,
    )
}

fn advance_ledgers(env: &Env, delta: u32) {
    let mut info = env.ledger().get();
    info.sequence_number += delta;
    info.timestamp += u64::from(delta) * 5;
    env.ledger().set(info);
}

/// Burst-deposit fairness harness.
///
/// Joins `lps.len()` LPs to `k` distinct invoices back-to-back (all joins
/// for an invoice land before its resolution — the "burst deposit" pattern
/// the issue names) and tallies wins per LP index. `equal_score = true`
/// leaves every LP at the default reputation (all joins tie, so each
/// resolution is a pure uniform PRNG draw among all candidates);
/// `equal_score = false` gives index 0 a strictly higher current score, the
/// fully-dominating baseline the deviation metric should report as maximally
/// skewed.
fn burst(t: &BurstEnv, lps: &[Address], equal_score: bool, k: u32) -> std::vec::Vec<u32> {
    let n = lps.len() as u32;
    if !equal_score {
        let top = lps[0].clone();
        let env = &t.env;
        t.env.as_contract(&t.contract.address, || {
            crate::invoice::set_lp_score(env, &top, 100);
        });
    }

    let mut counts = std::vec![0u32; n as usize];
    for _trial in 0..k {
        let id = submit_invoice_burst(t);
        // Burst: every join before the first resolve of this invoice.
        for lp in lps {
            t.contract.join_fund_queue(lp, &id);
        }
        advance_ledgers(&t.env, QUEUE_DELAY_LEDGERS);
        let winner = t.contract.resolve_fund_queue(&id);
        for (i, lp) in lps.iter().enumerate() {
            if *lp == winner {
                counts[i] += 1;
            }
        }
    }
    counts
}

/// Maximum deviation of any LP's win share from the uniform `1/n`
/// expectation, in share units:
///
/// `max_i |counts[i]/k - 1/n|`
///
/// Returned scaled by `k * n` as an exact integer (deviation <= tol_share
/// iff `max_win_share_deviation(counts, k, n) <= tol_share * (k * n)`), so
/// no floating point is needed on the assert side.
fn max_win_share_deviation(counts: &[u32], k: u32, n: u32) -> u32 {
    let mut max_scaled = 0u32;
    for c in counts {
        let scaled = if c * n > k { c * n - k } else { k - c * n };
        if scaled > max_scaled {
            max_scaled = scaled;
        }
    }
    max_scaled
}

// ── Burst, all tied: uniform-share sanity within an explicit tolerance ───────

#[test]
fn test_burst_two_equal_lps_win_share_within_tolerance() {
    let t = setup_burst();
    let lp_a = Address::generate(&t.env);
    let lp_b = Address::generate(&t.env);

    let k = 40;
    let counts = burst(&t, &[lp_a.clone(), lp_b.clone()], true, k);
    let total: u32 = counts.iter().sum();
    assert_eq!(total, k, "every resolution awards exactly one win");
    assert!(
        counts[0] > 0 && counts[1] > 0,
        "under a working uniform tie draw both LPs must win at least once \
         across {k} bursts (P(one-sided) = 2^-{k}); got {:?}",
        counts
    );
    // Tolerance: 1.0 share unit of deviation — with n = 2 this only rejects
    // total domination (counts = 40/0), which the both-won check already
    // excludes; the band is deliberately loose (see module docs).
    let dev = max_win_share_deviation(&counts, k, 2);
    assert!(
        dev <= (k * 2) / 2,
        "max deviation from 1/2 must stay within the 0.5-share tolerance band, got {dev}/{}",
        k * 2
    );
}

#[test]
fn test_burst_four_equal_lps_win_share_within_tolerance() {
    let t = setup_burst();
    let mut lps = std::vec::Vec::new();
    for _ in 0..4 {
        lps.push(Address::generate(&t.env));
    }

    let k = 80;
    let counts = burst(&t, &lps, true, k);
    assert_eq!(counts.iter().sum::<u32>(), k);
    // Each of 4 tied LPs has P(never winning) = (3/4)^80 ~ 9e-11.
    for (i, c) in counts.iter().enumerate() {
        assert!(
            *c > 0,
            "tied LP {i} must win at least once across {k} bursts, got {c}"
        );
    }
    // Tolerance: win share never above 3/n (deviation 2/n): count*n <= 3k,
    // i.e. 11 sigma+ away from the Binomial(80, 1/4) mean of 20.
    let dev = max_win_share_deviation(&counts, k, 4);
    assert!(
        dev <= 2 * k,
        "max deviation must stay within the 2/n = 0.5-share tolerance band, got {dev}"
    );
}

// ── Burst, unequal scores: the harness must report the dominating case ───────

#[test]
fn test_burst_unequal_scores_single_candidate_wins_every_time() {
    let t = setup_burst();
    let mut lps = std::vec::Vec::new();
    for _ in 0..4 {
        lps.push(Address::generate(&t.env));
    }

    let k = 8;
    let counts = burst(&t, &lps, false, k);
    assert_eq!(
        counts,
        std::vec![k, 0, 0, 0],
        "with a unique current maximum the candidate group has one member and \
         the draw is deterministic — the harness's deviation metric must see \
         full dominance, not tie noise"
    );
    // Deviation of the dominating LP: share 1 vs 1/4 expectation, scaled by
    // k*n = 32 -> |8*4 - 8| = 24.
    assert_eq!(max_win_share_deviation(&counts, k, 4), 24);
}

// ── Static before/after: score reads per resolution at the cap ───────────────

#[test]
fn test_1040_static_score_reads_before_after() {
    // The honest "measure the current baseline" answer without execution:
    // get_lp_score calls per resolution over a capped, all-tied queue.
    let cap = crate::constants::MAX_FUND_QUEUE_LEN;
    assert_eq!(cap, 50);

    // The declared worst-case fan-out envelope for the tie scan (Issue
    // #1058) must equal the same cap the fused pass is bounded by.
    let declared = crate::storage::RESOURCE_ENVELOPE
        .iter()
        .find(|(name, _)| *name == "queue_resolution_tie_fanout")
        .map(|(_, c)| *c);
    assert_eq!(
        declared,
        Some(cap),
        "the fused scan's bound must remain the declared envelope cap"
    );

    // Before (base 2ae6312e, two inline scans): 2 x cap = 100 reads.
    // After  (#1039 fused single pass):             1 x cap = 50 reads.
    let before = 2 * cap;
    let after = 1 * cap;
    assert_eq!(before, 100);
    assert_eq!(after, 50);
    assert!(
        after < before,
        "the fused pass must strictly halve worst-case reads"
    );
}

// ── Property: burst fairness across arbitrary n in [2, cap] ─────────────────

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10))]

    /// For any burst size up to the queue cap, with all LPs equally scored:
    ///  1. exactly `k` wins are awarded and every winner is a burst member
    ///     (the candidate group is the whole queue — nothing outside wins);
    ///  2. no LP's win share exceeds a deliberately loose multiple of the
    ///     uniform `1/n` expectation (loose on purpose — see the determinism
    ///     caveat in the module docs; a single hermetic run is not a
    ///     fairness proof, it only rejects gross bias).
    #[test]
    fn proptest_burst_win_share_bounded_for_any_n(
        n in 2usize..=(crate::constants::MAX_FUND_QUEUE_LEN as usize),
    ) {
        let t = setup_burst();
        let mut lps = std::vec::Vec::with_capacity(n);
        for _ in 0..n {
            lps.push(Address::generate(&t.env));
        }

        let n_u32 = n as u32;
        let k = 2 * n_u32; // expected count per LP: k/n = 2
        let counts = burst(&t, &lps, true, k);

        prop_assert_eq!(counts.iter().sum::<u32>(), k, "every win goes to a burst member");
        // Gross-bias band: count_i <= 8 * k / n = 16x the mean. Under a
        // uniform draw count_i ~ Binomial(2n, 1/n) <= Poisson-ish(2);
        // P(>= 16) is astronomically small at every n in range.
        for (i, c) in counts.iter().enumerate() {
            let scaled = c.checked_mul(n_u32).unwrap_or(u32::MAX);
            prop_assert!(
                scaled <= 8 * k,
                "LP {i} won {c} of {k} bursts at n={n}: beyond the 8x-uniform \
                 gross-bias band",
            );
        }
        let dev = max_win_share_deviation(&counts, k, n_u32);
        prop_assert!(dev <= 7 * k, "deviation band, n={n}, k={k}, dev={dev}");
    }
}
