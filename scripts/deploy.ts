#!/usr/bin/env node

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const WASM_SIZE_BUDGET = 100 * 1024;

const CONTRACTS: Record<string, string> = {
  invoice_liquidity: "target/wasm32v1-none/release/invoice_liquidity.wasm",
  iln_governance: "target/wasm32v1-none/release/iln_governance.wasm",
  iln_distribution: "target/wasm32v1-none/release/iln_distribution.wasm",
  reputation_bonus: "target/wasm32v1-none/release/reputation_bonus.wasm",
};

interface DeployResult {
  contractName: string;
  wasmHash: string;
  contractId: string;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let network: string | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--network" && i + 1 < args.length) {
      network = args[++i];
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    }
  }

  return { network, dryRun };
}

function runCommand(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
}

function checkNetwork(network: string): void {
  const networks = execSync("stellar network ls", { encoding: "utf-8" });
  if (!networks.includes(network)) {
    console.error(`Network '${network}' is not configured.`);
    console.error(`Configure it with: stellar network add --global ${network} --rpc-url <url> --network-passphrase "<passphrase>"`);
    process.exit(1);
  }
  console.log(`Network '${network}' is configured.`);
}

function checkDeployerBalance(network: string): void {
  try {
    const balance = execSync(
      `stellar keys balance deployer --network ${network}`,
      { encoding: "utf-8" }
    ).trim();
    const balanceNum = parseFloat(balance);
    if (balanceNum < 5) {
      console.error(`Deployer balance is ${balance} XLM — below the recommended minimum of 5 XLM.`);
      process.exit(1);
    }
    console.log(`Deployer balance: ${balance} XLM (sufficient).`);
  } catch {
    console.error("Failed to check deployer balance. Ensure the 'deployer' key exists and is funded.");
    process.exit(1);
  }
}

function checkWasmFiles(): void {
  let allExist = true;
  for (const [name, path] of Object.entries(CONTRACTS)) {
    const fullPath = resolve(path);
    if (!existsSync(fullPath)) {
      console.error(`WASM not found: ${path} (contract: ${name})`);
      allExist = false;
      continue;
    }
    const size = readFileSync(fullPath).length;
    if (size > WASM_SIZE_BUDGET) {
      console.error(`WASM ${path} is ${size} bytes — exceeds ${WASM_SIZE_BUDGET} byte budget.`);
      allExist = false;
    } else {
      console.log(`  ${name}: ${(size / 1024).toFixed(1)} KB (OK)`);
    }
  }
  if (!allExist) {
    console.error("WASM validation failed. Run 'cargo build --target wasm32v1-none --release' first.");
    process.exit(1);
  }
}

function computeExpectedContractIds(): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const [name, path] of Object.entries(CONTRACTS)) {
    const fullPath = resolve(path);
    const hash = runCommand(
      `sha256sum "${fullPath}" | cut -d' ' -f1`
    );
    ids[name] = hash.substring(0, 8);
  }
  return ids;
}

function deployContracts(network: string): DeployResult[] {
  const results: DeployResult[] = [];

  for (const [name, path] of Object.entries(CONTRACTS)) {
    console.log(`\nDeploying ${name}...`);

    const uploadOutput = runCommand(
      `stellar contract upload --network ${network} --source deployer --wasm "${path}"`
    );
    const wasmHash = uploadOutput.match(/WASM hash: ([a-f0-9]+)/)?.[1];
    if (!wasmHash) {
      console.error(`Failed to extract WASM hash for ${name}`);
      console.error(uploadOutput);
      process.exit(1);
    }
    console.log(`  WASM hash: ${wasmHash}`);

    const deployOutput = runCommand(
      `stellar contract deploy --network ${network} --source deployer --wasm-hash ${wasmHash}`
    );
    const contractId = deployOutput.match(/Contract ID: ([A-Z0-9]+)/)?.[1];
    if (!contractId) {
      console.error(`Failed to extract contract ID for ${name}`);
      console.error(deployOutput);
      process.exit(1);
    }
    console.log(`  Contract ID: ${contractId}`);

    results.push({ contractName: name, wasmHash, contractId });
  }

  return results;
}

function updateReadme(results: DeployResult[]): void {
  const readmePath = resolve("README.md");
  if (!existsSync(readmePath)) {
    console.error("README.md not found — skipping update.");
    return;
  }

  const content = readFileSync(readmePath, "utf-8");
  const tableRows = results.map((r) => {
    let notes: string;
    switch (r.contractName) {
      case "invoice_liquidity":
        notes = "Primary integration contract; used in [SDK examples](docs/sdk-integration.md)";
        break;
      case "iln_governance":
        notes = "Governance proposals and voting";
        break;
      case "iln_distribution":
        notes = "Rewards distribution";
        break;
      case "reputation_bonus":
        notes = "Reputation-based bonus rules";
        break;
      default:
        notes = "";
    }
    return `| **\`${r.contractName}\`** | \`${r.contractId}\` | ${notes} |`;
  });

  const testnetUsdcSac = process.env.TESTNET_USDC_SAC || "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
  const table = [
    "| Resource | Contract ID | Notes |",
    "|----------|-------------|-------|",
    ...tableRows,
    `| **Testnet USDC (SAC)** | \`${testnetUsdcSac}\` | Referenced in SDK integration guide |`,
  ].join("\n");

  const startMarker = "<!-- TESTNET_CONTRACT_IDS_START -->";
  const endMarker = "<!-- TESTNET_CONTRACT_IDS_END -->";

  if (!content.includes(startMarker) || !content.includes(endMarker)) {
    console.error("Missing TESTNET_CONTRACT_IDS markers in README.md — skipping update.");
    return;
  }

  const updated = content.replace(
    new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`, "m"),
    `${startMarker}\n${table}\n${endMarker}`
  );

  writeFileSync(readmePath, updated, "utf-8");
  console.log("README.md updated with new contract IDs.");
}

function promptNetworkConfirmation(network: string): void {
  const netLabel = network === "mainnet" ? "MAINNET (PRODUCTION)" : "testnet";
  console.log(`\n⚠️  You are about to deploy to: ${netLabel}`);
  console.log("Pre-flight checks passed. Proceeding...\n");
}

async function main() {
  const { network, dryRun } = parseArgs();

  if (!network) {
    console.error("Error: --network flag is required (testnet|mainnet).");
    console.error("Usage: npx tsx scripts/deploy.ts --network testnet [--dry-run]");
    process.exit(1);
  }

  if (network !== "testnet" && network !== "mainnet") {
    console.error(`Error: network must be 'testnet' or 'mainnet', got '${network}'.`);
    process.exit(1);
  }

  console.log(`=== ILN Deploy Script ===`);
  console.log(`Network: ${network}`);
  console.log(`Mode: ${dryRun ? "DRY-RUN" : "LIVE"}\n`);

  console.log("[1/4] Checking network configuration...");
  checkNetwork(network);

  console.log("\n[2/4] Checking deployer balance...");
  checkDeployerBalance(network);

  console.log("\n[3/4] Validating WASM files...");
  checkWasmFiles();

  console.log("\n[4/4] Running deployment...");
  promptNetworkConfirmation(network);

  if (dryRun) {
    console.log("\n[dry-run] Computing expected contract IDs...");
    const expectedIds = computeExpectedContractIds();
    for (const [name, id] of Object.entries(expectedIds)) {
      console.log(`  ${name}: ${id} (prefix derived from WASM hash)`);
    }
    console.log("\n[dry-run] All checks passed. No transactions submitted.");
    console.log("Run without --dry-run to deploy.");
    process.exit(0);
  }

  const results = deployContracts(network);

  console.log("\n=== Deployment Summary ===");
  for (const r of results) {
    console.log(`${r.contractName}: ${r.contractId}`);
  }

  updateReadme(results);
  console.log("\nDeployment complete.");
}

main().catch((err) => {
  console.error("Deployment failed:", err.message);
  process.exit(1);
});
