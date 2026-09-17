#!/usr/bin/env node
import { rpc, Keypair, TransactionBuilder, Networks, Contract, Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;
const NETWORK = process.env.NETWORK || "testnet";
const ENV_FILE = process.env.ENV_FILE || `.contracts-${NETWORK}.env`;

interface ContractInfo {
  name: string;
  id: string;
  hasContractStats: boolean;
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

async function main() {
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
      const submitter = Keypair.random();
      const payer = Keypair.random();
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
  if (totalFailed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`\n  FATAL  ${err.message}`);
  process.exit(1);
});
