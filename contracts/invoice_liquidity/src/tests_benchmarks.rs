#![cfg(test)]

//! Execution cost benchmarks for core contract instructions (Issue #76).
//! Emits machine-readable `BENCHMARK` lines for CI regression checks.

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    Address, Env,
};

const BENCH_INVOICE_AMOUNT: i128 = 1_000_000_000;
const BENCH_DISCOUNT_RATE: u32 = 300;

struct BaseBenchEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    token: Address,
    freelancer: Address,
    payer: Address,
    lp: Address,
}

fn setup_benchmark_env() -> BaseBenchEnv {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let mut ledger = env.ledger().get();
    ledger.timestamp = 1_700_000_000;
    env.ledger().set(ledger);

    let usdc_admin = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let xlm_admin = Address::generate(&env);
    let xlm = env.register_stellar_asset_contract_v2(xlm_admin);

    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);
    let eurc_address = Address::generate(&env);
    contract.initialize(&usdc_admin, &usdc.address(), &eurc_address, &xlm.address());

    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let lp = Address::generate(&env);

    let usdc_client = StellarAssetClient::new(&env, &usdc.address());
    usdc_client.mint(&lp, &1_000_000_000_000);
    usdc_client.mint(&payer, &1_000_000_000_000);

    BaseBenchEnv {
        env,
        contract,
        token: usdc.address(),
        freelancer,
        payer,
        lp,
    }
}

fn emit_benchmark(name: &str, cpu: u64, mem: u64) {
    std::println!("BENCHMARK {name} cpu={cpu} mem={mem}");
}

fn measure<F: FnOnce()>(env: &Env, name: &str, action: F) -> (u64, u64) {
    env.cost_estimate().budget().reset_unlimited();
    action();
    let cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let mem = env.cost_estimate().budget().memory_bytes_cost();
    emit_benchmark(name, cpu, mem);
    (cpu, mem)
}

#[test]
fn benchmark_submit_invoice() {
    let bench = setup_benchmark_env();
    let due_date = bench.env.ledger().timestamp() + 86_400;

    measure(&bench.env, "submit_invoice", || {
        bench.contract.submit_invoice(&ReferralCode::None);
    });
}

#[test]
fn benchmark_fund_invoice() {
    let bench = setup_benchmark_env();
    let due_date = bench.env.ledger().timestamp() + 86_400;
    let id = bench.contract.submit_invoice(&ReferralCode::None);

    measure(&bench.env, "fund_invoice", || {
        bench
            .contract
            .fund_invoice(&bench.lp, &id, &BENCH_INVOICE_AMOUNT, &false);
    });
}

#[test]
fn benchmark_mark_paid() {
    let bench = setup_benchmark_env();
    let due_date = bench.env.ledger().timestamp() + 86_400;
    let id = bench.contract.submit_invoice(&ReferralCode::None);
    bench
        .contract
        .fund_invoice(&bench.lp, &id, &BENCH_INVOICE_AMOUNT, &false);

    measure(&bench.env, "mark_paid", || {
        bench.contract.mark_paid(&id, &BENCH_INVOICE_AMOUNT);
    });
}

#[test]
fn benchmark_all_functions_summary() {
    let mut results = std::vec::Vec::new();

    let bench = setup_benchmark_env();
    let due_date = bench.env.ledger().timestamp() + 86_400;

    results.push(measure(&bench.env, "submit_invoice", || {
        bench.contract.submit_invoice(&ReferralCode::None);
    }));

    let id = bench.contract.submit_invoice(&ReferralCode::None);
    results.push(measure(&bench.env, "fund_invoice", || {
        bench
            .contract
            .fund_invoice(&bench.lp, &id, &BENCH_INVOICE_AMOUNT, &false);
    }));
    results.push(measure(&bench.env, "mark_paid", || {
        bench.contract.mark_paid(&id, &BENCH_INVOICE_AMOUNT);
    }));

    std::println!("\n| Function       | CPU Instructions | Memory (bytes) |");
    std::println!("| -------------- | ---------------- | -------------- |");
    for (name, (cpu, mem)) in [
        ("submit_invoice", results[0]),
        ("fund_invoice", results[1]),
        ("mark_paid", results[2]),
    ] {
        std::println!("| {name:<14} | {cpu:>16} | {mem:>14} |");
    }
}

// ================================================================
// Tests for get_contract_stats with multiple tokens (Issue #485)
// ================================================================

use soroban_sdk::{contract, contractimpl, token::Client as TokenClient};

#[contract]
struct MockPriceOracle;

#[contractimpl]
impl MockPriceOracle {
    pub fn get_price(_env: soroban_sdk::Env, _token: Address) -> i128 {
        20_000
    }
}

struct MultiTokenBenchEnv {
    env: Env,
    contract: InvoiceLiquidityContractClient<'static>,
    usdc: Address,
    usdc_client: TokenClient<'static>,
    xlm: Address,
    eurc: Address,
    freelancer: Address,
    payer: Address,
    lp: Address,
    admin: Address,
}

fn setup_multi_token() -> MultiTokenBenchEnv {
    let env = Env::default();
    env.mock_all_auths();

    let mut ledger = env.ledger().get();
    ledger.timestamp = 1_700_000_000;
    env.ledger().set(ledger);

    let usdc_admin = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(usdc_admin.clone());
    let xlm_admin = Address::generate(&env);
    let xlm = env.register_stellar_asset_contract_v2(xlm_admin);
    let eurc_admin = Address::generate(&env);
    let eurc = env.register_stellar_asset_contract_v2(eurc_admin);

    let admin = usdc_admin.clone();
    let contract_id = env.register_contract(None, InvoiceLiquidityContract);
    let contract = InvoiceLiquidityContractClient::new(&env, &contract_id);
    contract.initialize(&admin, &usdc.address(), &eurc.address(), &xlm.address());

    let freelancer = Address::generate(&env);
    let payer = Address::generate(&env);
    let lp = Address::generate(&env);

    let usdc_client = StellarAssetClient::new(&env, &usdc.address());
    let usdc_token = TokenClient::new(&env, &usdc.address());
    let xlm_client = StellarAssetClient::new(&env, &xlm.address());
    let eurc_client = StellarAssetClient::new(&env, &eurc.address());

    usdc_client.mint(&lp, &10_000_000_000_000);
    usdc_client.mint(&payer, &10_000_000_000_000);
    xlm_client.mint(&lp, &10_000_000_000_000);
    xlm_client.mint(&payer, &10_000_000_000_000);
    eurc_client.mint(&lp, &10_000_000_000_000);
    eurc_client.mint(&payer, &10_000_000_000_000);

    MultiTokenBenchEnv {
        env,
        contract,
        usdc: usdc.address(),
        usdc_client,
        xlm: xlm.address(),
        eurc: eurc.address(),
        freelancer,
        payer,
        lp,
        admin,
    }
}

fn submit_and_fund(
    t: &MultiTokenBenchEnv,
    token: &Address,
    amount: i128,
) -> u64 {
    let due_date = t.env.ledger().timestamp() + 86_400 * 30;
    let id = t.contract.submit_invoice(
        &t.freelancer,
        &t.payer,
        &amount,
        &due_date,
        &300u32,
        token,
        &ReferralCode::None,
    );
    t.contract.fund_invoice(&t.lp, &id, &amount, &false);
    t.contract.mark_paid(&id, &amount);
    id
}

#[test]
fn test_stats_tracks_usdc_volume() {
    let t = setup_multi_token();
    submit_and_fund(&t, &t.usdc, 500_000_000);

    let stats = t.contract.get_contract_stats();
    assert_eq!(stats.total_volume_usdc, 500_000_000);
    assert_eq!(stats.total_invoices, 1);
    assert_eq!(stats.total_funded, 1);
    assert_eq!(stats.total_paid, 1);
}

#[test]
fn test_stats_tracks_xlm_volume() {
    let t = setup_multi_token();
    submit_and_fund(&t, &t.xlm, 2_000_000_000);

    let stats = t.contract.get_contract_stats();
    assert_eq!(stats.total_volume_xlm, 2_000_000_000);
    assert_eq!(stats.total_volume_usdc, 0);
}

#[test]
fn test_stats_tracks_eurc_volume() {
    let t = setup_multi_token();
    submit_and_fund(&t, &t.eurc, 750_000_000);

    let stats = t.contract.get_contract_stats();
    assert_eq!(stats.total_volume_eurc, 750_000_000);
    assert_eq!(stats.total_volume_usdc, 0);
    assert_eq!(stats.total_volume_xlm, 0);
}

#[test]
fn test_stats_multi_token_aggregation() {
    let t = setup_multi_token();
    submit_and_fund(&t, &t.usdc, 1_000_000_000);
    submit_and_fund(&t, &t.xlm, 2_000_000_000);
    submit_and_fund(&t, &t.eurc, 3_000_000_000);

    let stats = t.contract.get_contract_stats();
    assert_eq!(stats.total_invoices, 3);
    assert_eq!(stats.total_funded, 3);
    assert_eq!(stats.total_paid, 3);
    assert_eq!(stats.total_volume_usdc, 1_000_000_000);
    assert_eq!(stats.total_volume_xlm, 2_000_000_000);
    assert_eq!(stats.total_volume_eurc, 3_000_000_000);
}

#[test]
fn test_stats_usd_normalized_with_price_oracle() {
    let t = setup_multi_token();
    submit_and_fund(&t, &t.usdc, 1_000_000_000);

    // Install a mock price oracle that returns a fixed price.
    let oracle_id = t.env.register_contract(None, MockPriceOracle);
    t.env.as_contract(&t.contract.address, || {
        let mut config = crate::storage::get_config(&t.env).unwrap();
        config.price_oracle = Some(oracle_id.clone());
        crate::storage::set_config(&t.env, &config);
    });

    let stats = t.contract.get_contract_stats();
    // MockPriceOracle returns 20_000; normalized = 1_000_000_000 * 20_000 / 10_000
    assert_eq!(
        stats.total_volume_usd_normalized,
        1_000_000_000 * 20_000 / 10_000
    );
}

#[test]
fn test_stats_without_price_oracle_returns_zero_normalized() {
    let t = setup_multi_token();
    submit_and_fund(&t, &t.usdc, 1_000_000_000);

    // No oracle configured — should return 0 for normalized volume.
    let stats = t.contract.get_contract_stats();
    assert_eq!(stats.total_volume_usd_normalized, 0);
}
