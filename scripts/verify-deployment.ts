#!/usr/bin/env node
import { rpc, Keypair, TransactionBuilder, Networks, Contract, Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "fs";
import { resolve, join } from "path";
import { createHash } from "crypto";
import { execSync } from "child_process";
import { tmpdir } from "os";

const NETWORK = process.env.NETWORK || "testnet";

// Defaults are keyed off NETWORK so that setting NETWORK=mainnet without also
// overriding SOROBAN_RPC_URL/NETWORK_PASSPHRASE does not silently fall back to
// testnet infrastructure while claiming to verify mainnet.
const DEFAULT_RPC_URLS: Record<string, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://mainnet.sorobanrpc.com",
};
const DEFAULT_PASSPHRASES: Record<string, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
};

const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL || DEFAULT_RPC_URLS[NETWORK] || DEFAULT_RPC_URLS.testnet;
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || DEFAULT_PASSPHRASES[NETWORK] || Networks.TESTNET;
const ENV_FILE = process.env.ENV_FILE || `.contracts-${NETWORK}.env`;

// Local WASM artifacts, used for the on-chain WASM hash match check. Kept in
// sync with the CONTRACTS map in scripts/deploy.ts.
const LOCAL_WASM_PATHS: Record<string, string> = {
  invoice_liquidity: "target/wasm32v1-none/release/invoice_liquidity.wasm",
  iln_governance: "target/wasm32v1-none/release/iln_governance.wasm",
  iln_distribution: "target/wasm32v1-none/release/iln_distribution.wasm",
  reputation_bonus: "target/wasm32v1-none/release/reputation_bonus.wasm",
  insurance_pool: "target/wasm32v1-none/release/insurance_pool.wasm",
};

interface ContractInfo {
  name: string;
  id: string;
  hasContractStats: boolean;
}

/**
 * Guard against the classic footgun where NETWORK=mainnet is set (e.g. to
 * pick the right .env file) but SOROBAN_RPC_URL / NETWORK_PASSPHRASE are left
 * pointing at testnet, so a "mainnet verification" silently checks testnet
 * instead. Fails closed for mainnet; only warns for other networks.
 */
function assertNetworkConsistency(): void {
  const expectedPassphrase = DEFAULT_PASSPHRASES[NETWORK];
  if (!expectedPassphrase) {
    console.log(`Network '${NETWORK}' has no known default passphrase — skipping consistency check.`);
    return;
  }

  const mismatchedPassphrase = NETWORK_PASSPHRASE !== expectedPassphrase;
  const looksLikeWrongHost =
    NETWORK === "mainnet"
      ? SOROBAN_RPC_URL.includes("testnet")
      : NETWORK === "testnet"
        ? SOROBAN_RPC_URL.includes("mainnet")
        : false;

  if (mismatchedPassphrase || looksLikeWrongHost) {
    const message = [
      `Refusing to run: NETWORK=${NETWORK} but the effective RPC configuration does not match.`,
      `  SOROBAN_RPC_URL:    ${SOROBAN_RPC_URL}`,
      `  NETWORK_PASSPHRASE: ${NETWORK_PASSPHRASE}`,
      `  Expected passphrase for '${NETWORK}': ${expectedPassphrase}`,
      "Set SOROBAN_RPC_URL and NETWORK_PASSPHRASE explicitly for the target network, or unset them to use the built-in defaults.",
    ].join("\n");
    console.error(message);
    process.exit(1);
  }

  console.log(`Network configuration confirmed consistent for '${NETWORK}'.`);
}

/** SHA-256 hex digest of a local file. */
function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Fetches the WASM currently installed at `contractId` on `network` via the
 * Stellar CLI and returns its SHA-256 hex digest, or `null` if the CLI is
 * unavailable (treated as a skip, not a failure, so this stays usable in
 * environments without the CLI installed).
 */
function fetchDeployedWasmHash(contractId: string, network: string): string | null {
  const outFile = join(tmpdir(), `iln-verify-${contractId}-${Date.now()}.wasm`);
  try {
    execSync(`stellar contract fetch --id ${contractId} --network ${network} --out-file "${outFile}"`, {
      stdio: "pipe",
    });
    return sha256File(outFile);
  } catch (err: any) {
    console.log(`  (skip) Could not fetch deployed WASM via Stellar CLI: ${err.message?.split("\n")[0]}`);
    return null;
  } finally {
    if (existsSync(outFile)) unlinkSync(outFile);
  }
}

/**
 * Compares the on-chain WASM for a contract against the locally built
 * artifact. Skips (does not fail) when there is no local WASM to compare
 * against or the Stellar CLI cannot be reached, since those are environment
 * limitations rather than deployment defects.
 */
function checkWasmHashMatch(
  contractName: string,
  contractId: string
): { name: string; passed: boolean; error?: string } | null {
  const localPath = LOCAL_WASM_PATHS[contractName];
  if (!localPath || !existsSync(resolve(localPath))) {
    return null;
  }

  const localHash = sha256File(resolve(localPath));
  const deployedHash = fetchDeployedWasmHash(contractId, NETWORK);
  if (deployedHash === null) return null;

  if (localHash !== deployedHash) {
    return {
      name: "wasm_hash_match",
      passed: false,
      error: `Local WASM (${localHash}) does not match deployed WASM (${deployedHash})`,
    };
  }
  return { name: "wasm_hash_match", passed: true };
}

function loadContractIds(): ContractInfo[] {
  const envPath = resolve(ENV_FILE);
  if (!existsSync(envPath)) {
    const ids: ContractInfo[] = [];
    const envVarMap: Record<string, { varName: string; stats: boolean }> = {
      invoice_liquidity: { varName: "INVOICE_LIQUIDITY_ID", stats: true },
      iln_governance: { varName: "ILN_GOVERNANCE_ID", stats: false },
      iln_distribution: { varName: "ILN_DISTRIBUTION_ID", stats: false },
      reputation_bonus: { varName: "REPUTATION_BONUS_ID", stats: false },
      insurance_pool: { varName: "INSURANCE_POOL_ID", stats: false },
    };
    for (const [name, cfg] of Object.entries(envVarMap)) {
      const id = process.env[cfg.varName];
      if (id) ids.push({ name, id, hasContractStats: cfg.stats });
    }
    if (ids.length === 0) {
      console.error("No contract IDs found. Set INVOICE_LIQUIDITY_ID, ILN_GOVERNANCE_ID, etc.");
      process.exit(1);
    }
    return ids;
  }

  const content = readFileSync(envPath, "utf-8");
  const ids: ContractInfo[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, value] = trimmed.split("=");
    if (key === "INVOICE_LIQUIDITY_ID") ids.push({ name: "invoice_liquidity", id: value, hasContractStats: true });
    else if (key === "ILN_GOVERNANCE_ID") ids.push({ name: "iln_governance", id: value, hasContractStats: false });
    else if (key === "ILN_DISTRIBUTION_ID") ids.push({ name: "iln_distribution", id: value, hasContractStats: false });
    else if (key === "REPUTATION_BONUS_ID") ids.push({ name: "reputation_bonus", id: value, hasContractStats: false });
    else if (key === "INSURANCE_POOL_ID") ids.push({ name: "insurance_pool", id: value, hasContractStats: false });
  }
  return ids;
}

function bigintToI128ScVal(value: bigint): xdr.ScVal {
  const lo = value & 0xffffffffffffffffn;
  const hi = value >> 64n;
  return xdr.ScVal.scvI128(new xdr.Int128Parts({ lo: new xdr.Uint64(lo), hi: new xdr.Int64(hi) }));
}

function bigintToU64ScVal(value: bigint): xdr.ScVal {
  return xdr.ScVal.scvU64(new xdr.Uint64(value));
}

function numberToU32ScVal(value: number): xdr.ScVal {
  return xdr.ScVal.scvU32(value);
}

async function simulateViewFunction(
  server: rpc.Server,
  contractId: string,
  functionName: string,
  args: xdr.ScVal[] = []
): Promise<any> {
  const contract = new Contract(contractId);
  const source = Keypair.random();
  const account = await server.getAccount(source.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(functionName, ...args))
    .setTimeout(30)
    .build();
  const simulated = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulateTransactionError(simulated)) {
    throw new Error(`Simulation failed for '${functionName}': ${JSON.stringify(simulated.error)}`);
  }
  return simulated;
}

async function invokeContract(
  server: rpc.Server,
  contractId: string,
  functionName: string,
  args: xdr.ScVal[],
  signer: Keypair
): Promise<any> {
  const contract = new Contract(contractId);
  const account = await server.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(functionName, ...args))
    .setTimeout(30)
    .build();
  const simulated = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulateTransactionError(simulated)) {
    throw new Error(`Simulation failed for '${functionName}': ${JSON.stringify(simulated.error)}`);
  }
  const txResult = rpc.assembleTransaction(tx, simulated).build();
  txResult.sign(signer);
  const response = await server.sendTransaction(txResult);
  if (response.status === "ERROR") {
    throw new Error(`Send transaction failed: ${JSON.stringify(response.errorResultXdr)}`);
  }
  let status = response.status;
  const txHash = response.hash;
  while (status === "PENDING") {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const txRes = await server.getTransaction(txHash);
    status = txRes.status;
    if (status === "SUCCESS") return txRes;
    else if (status === "FAILED") throw new Error(`Transaction failed: ${JSON.stringify(txRes)}`);
  }
  throw new Error(`Unexpected transaction status: ${status}`);
}

/**
 * Verifies the deployed contract was actually initialized with the address
 * arguments the release lead intended, catching the class of error where the
 * wrong token/admin address is pasted into the deploy command. Driven by
 * EXPECTED_* environment variables so it stays a no-op (returns []) when the
 * operator hasn't supplied anything to check against.
 */
async function checkConstructorArgs(
  server: rpc.Server,
  contract: ContractInfo
): Promise<{ name: string; passed: boolean; error?: string }[]> {
  const tests: { name: string; passed: boolean; error?: string }[] = [];

  if (contract.name === "invoice_liquidity") {
    const tokenChecks: Array<[string, string | undefined]> = [
      ["usdc_token", process.env.EXPECTED_USDC_TOKEN],
      ["eurc_token", process.env.EXPECTED_EURC_TOKEN],
      ["xlm_token", process.env.EXPECTED_XLM_TOKEN],
    ];
    for (const [label, expected] of tokenChecks) {
      if (!expected) continue;
      const testName = `constructor_args:${label}`;
      try {
        const sim = await simulateViewFunction(server, contract.id, "get_token_decimals", [
          Address.fromString(expected).toScVal(),
        ]);
        const decimals = sim.result?.retval ? scValToNative(sim.result.retval) : null;
        if (decimals === null || decimals === undefined) {
          throw new Error(`${label} (${expected}) is not an approved token on this deployment`);
        }
        console.log(`  PASS  ${testName}  => ${expected} approved (${decimals} decimals)`);
        tests.push({ name: testName, passed: true });
      } catch (err: any) {
        console.log(`  FAIL  ${testName}  => ${err.message}`);
        tests.push({ name: testName, passed: false, error: err.message });
      }
    }
  }

  if (contract.name === "insurance_pool") {
    const expectedToken = process.env.EXPECTED_INSURANCE_TOKEN;
    if (expectedToken) {
      const testName = "constructor_args:token";
      try {
        const sim = await simulateViewFunction(server, contract.id, "get_token_address");
        const actual = sim.result?.retval ? scValToNative(sim.result.retval) : null;
        if (actual !== expectedToken) {
          throw new Error(`expected ${expectedToken}, got ${actual}`);
        }
        console.log(`  PASS  ${testName}  => ${actual}`);
        tests.push({ name: testName, passed: true });
      } catch (err: any) {
        console.log(`  FAIL  ${testName}  => ${err.message}`);
        tests.push({ name: testName, passed: false, error: err.message });
      }
    }

    const expectedCoverage = process.env.EXPECTED_INSURANCE_COVERAGE;
    if (expectedCoverage) {
      const testName = "constructor_args:coverage";
      try {
        const sim = await simulateViewFunction(server, contract.id, "get_coverage");
        const actual = sim.result?.retval ? scValToNative(sim.result.retval) : null;
        if (String(actual) !== expectedCoverage) {
          throw new Error(`expected ${expectedCoverage}, got ${actual}`);
        }
        console.log(`  PASS  ${testName}  => ${actual}`);
        tests.push({ name: testName, passed: true });
      } catch (err: any) {
        console.log(`  FAIL  ${testName}  => ${err.message}`);
        tests.push({ name: testName, passed: false, error: err.message });
      }
    }
  }

  return tests;
}

function parseArgs(argv: string[]) {
  let reportFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--report" && i + 1 < argv.length) reportFile = argv[++i];
  }
  return { reportFile: reportFile || process.env.VERIFICATION_REPORT_FILE || `verification-report.${NETWORK}.json` };
}

async function main() {
  const { reportFile } = parseArgs(process.argv.slice(2));
  assertNetworkConsistency();

  const results: { name: string; tests: { name: string; passed: boolean; error?: string }[] }[] = [];
  const server = new rpc.Server(SOROBAN_RPC_URL);

  const contracts = loadContractIds();

  for (const contract of contracts) {
    const tests: { name: string; passed: boolean; error?: string }[] = [];
    console.log(`\n--- ${contract.name} (${contract.id}) ---`);

    try {
      const sim = await simulateViewFunction(server, contract.id, "get_version");
      if (sim.result?.retval) {
        const version = scValToNative(sim.result.retval);
        console.log(`  PASS  get_version  => ${version}`);
        tests.push({ name: "get_version", passed: true });
      } else {
        throw new Error("No return value");
      }
    } catch (err: any) {
      console.log(`  FAIL  get_version  => ${err.message}`);
      tests.push({ name: "get_version", passed: false, error: err.message });
    }

    const wasmCheck = checkWasmHashMatch(contract.name, contract.id);
    if (wasmCheck) {
      console.log(`  ${wasmCheck.passed ? "PASS" : "FAIL"}  ${wasmCheck.name}${wasmCheck.error ? "  => " + wasmCheck.error : ""}`);
      tests.push(wasmCheck);
    }

    tests.push(...(await checkConstructorArgs(server, contract)));

    if (contract.hasContractStats) {
      try {
        const sim = await simulateViewFunction(server, contract.id, "get_contract_stats");
        if (sim.result?.retval) {
          const stats = scValToNative(sim.result.retval);
          console.log(`  PASS  get_contract_stats  => total_invoices=${stats.total_invoices}`);
          tests.push({ name: "get_contract_stats", passed: true });
        } else {
          throw new Error("No return value");
        }
      } catch (err: any) {
        console.log(`  FAIL  get_contract_stats  => ${err.message}`);
        tests.push({ name: "get_contract_stats", passed: false, error: err.message });
      }
    }

    if (contract.name === "invoice_liquidity") {
      // Submitting a real invoice moves state and spends fees on a live
      // financial contract. Random, unfunded keypairs can't sign a
      // transaction anyway, so on mainnet this only runs when the operator
      // explicitly supplies pre-funded verification accounts; otherwise it's
      // skipped rather than reported as a false-positive FAIL.
      const submitterSecret = process.env.VERIFY_SUBMITTER_SECRET;
      const payerSecret = process.env.VERIFY_PAYER_SECRET;
      const canRunWriteFlow = NETWORK !== "mainnet" || Boolean(submitterSecret && payerSecret);

      if (!canRunWriteFlow) {
        console.log(
          "  (skip) submit/cancel flow — set VERIFY_SUBMITTER_SECRET and VERIFY_PAYER_SECRET (funded accounts) to exercise this on mainnet"
        );
      } else {
        const submitter = submitterSecret ? Keypair.fromSecret(submitterSecret) : Keypair.random();
        const payer = payerSecret ? Keypair.fromSecret(payerSecret) : Keypair.random();
        try {
          console.log("  Testing submit + cancel flow...");
          const amount = 100_000_000n;
          const dueDate = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600);
          const submitArgs = [
            Address.fromString(submitter.publicKey()).toScVal(),
            Address.fromString(payer.publicKey()).toScVal(),
            bigintToI128ScVal(amount),
            bigintToU64ScVal(dueDate),
            numberToU32ScVal(500),
            xdr.ScVal.scvVoid(),
            xdr.ScVal.scvSymbol("None"),
          ];
          const submitResult = await invokeContract(server, contract.id, "submit_invoice", submitArgs, submitter);
          const invoiceId = scValToNative(submitResult.returnValue);
          console.log(`  PASS  submit_invoice  => invoice #${invoiceId}`);
          tests.push({ name: "submit_invoice", passed: true });

          const cancelResult = await invokeContract(
            server, contract.id, "cancel_invoice",
            [bigintToU64ScVal(invoiceId)], submitter
          );
          console.log(`  PASS  cancel_invoice  => invoice #${invoiceId} cancelled`);
          tests.push({ name: "cancel_invoice", passed: true });
        } catch (err: any) {
          console.log(`  FAIL  submit/cancel flow  => ${err.message}`);
          tests.push({ name: "submit_invoice", passed: false, error: err.message });
        }
      }
    }

    if (contract.name === "insurance_pool") {
      try {
        const coverageSim = await simulateViewFunction(server, contract.id, "get_coverage");
        if (coverageSim.result?.retval) {
          const coverage = scValToNative(coverageSim.result.retval);
          console.log(`  PASS  get_coverage  => ${coverage} stroops`);
          tests.push({ name: "get_coverage", passed: true });
        } else {
          throw new Error("No return value");
        }
      } catch (err: any) {
        console.log(`  FAIL  get_coverage  => ${err.message}`);
        tests.push({ name: "get_coverage", passed: false, error: err.message });
      }

      try {
        const balanceSim = await simulateViewFunction(server, contract.id, "get_pool_balance");
        if (balanceSim.result?.retval) {
          const balance = scValToNative(balanceSim.result.retval);
          console.log(`  PASS  get_pool_balance  => ${balance} stroops`);
          tests.push({ name: "get_pool_balance", passed: true });
        } else {
          throw new Error("No return value");
        }
      } catch (err: any) {
        console.log(`  FAIL  get_pool_balance  => ${err.message}`);
        tests.push({ name: "get_pool_balance", passed: false, error: err.message });
      }

      try {
        const lp = Keypair.random();
        const enrollSim = await simulateViewFunction(
          server,
          contract.id,
          "is_enrolled",
          [Address.fromString(lp.publicKey()).toScVal()]
        );
        if (enrollSim.result?.retval) {
          const enrolled = scValToNative(enrollSim.result.retval);
          console.log(`  PASS  is_enrolled  => ${enrolled}`);
          tests.push({ name: "is_enrolled", passed: true });
        } else {
          throw new Error("No return value");
        }
      } catch (err: any) {
        console.log(`  FAIL  is_enrolled  => ${err.message}`);
        tests.push({ name: "is_enrolled", passed: false, error: err.message });
      }
    }

    results.push({ name: contract.name, tests });
  }

  console.log("\n=========================================");
  console.log("  VERIFICATION SUMMARY");
  console.log("=========================================");
  let totalPassed = 0;
  let totalFailed = 0;
  for (const r of results) {
    console.log(`  ${r.name}:`);
    for (const t of r.tests) {
      const icon = t.passed ? "PASS" : "FAIL";
      console.log(`    ${icon}  ${t.name}`);
      if (t.passed) totalPassed++;
      else totalFailed++;
    }
  }
  console.log(`\n  ${totalPassed} passed, ${totalFailed} failed`);
  console.log("=========================================");

  const report = {
    network: NETWORK,
    sorobanRpcUrl: SOROBAN_RPC_URL,
    timestamp: new Date().toISOString(),
    totalPassed,
    totalFailed,
    allPassed: totalFailed === 0,
    contracts: results,
  };
  writeFileSync(resolve(reportFile), JSON.stringify(report, null, 2) + "\n");
  console.log(`\nVerification report written to ${reportFile}`);

  if (totalFailed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`\n  FATAL  ${err.message}`);
  process.exit(1);
});
