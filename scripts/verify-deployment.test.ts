/**
 * Tests for the pure deployment-verification helpers.
 *
 * Run with:
 *   npx tsx --test scripts/verify-deployment.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StrKey } from "@stellar/stellar-sdk";
import {
  isValidContractId,
  parseArgs,
  resolveNetworkConfig,
  rollbackDeploymentRecords,
  validateContractIds,
} from "./verify-deployment.ts";

const VALID_ID = StrKey.encodeContract(Buffer.alloc(32, 1));

test("isValidContractId accepts checksummed C-addresses only", () => {
  assert.equal(isValidContractId(VALID_ID), true);
  assert.equal(isValidContractId(VALID_ID.toLowerCase()), false);
  assert.equal(isValidContractId("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"), false);
  assert.equal(isValidContractId("C123"), false);
});

test("validateContractIds reports malformed and duplicate IDs", () => {
  assert.deepEqual(
    validateContractIds([{ name: "invoice_liquidity", id: VALID_ID, hasContractStats: true }]),
    [],
  );
  const problems = validateContractIds([
    { name: "invoice_liquidity", id: VALID_ID, hasContractStats: true },
    { name: "iln_governance", id: VALID_ID, hasContractStats: false },
    { name: "iln_distribution", id: "not-a-contract", hasContractStats: false },
  ]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /reuses contract ID/);
  assert.match(problems[1], /not a valid contract ID/);
});

test("resolveNetworkConfig fails closed for unknown networks", () => {
  assert.deepEqual(resolveNetworkConfig({ NETWORK: "testnet" }), {
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    passphrase: "Test SDF Network ; September 2015",
  });
  assert.match(
    (resolveNetworkConfig({ NETWORK: "futurenet" }) as { error: string }).error,
    /no built-in defaults/,
  );
  assert.deepEqual(
    resolveNetworkConfig({
      NETWORK: "futurenet",
      SOROBAN_RPC_URL: "https://rpc.example",
      NETWORK_PASSPHRASE: "Example Network",
    }),
    {
      network: "futurenet",
      rpcUrl: "https://rpc.example",
      passphrase: "Example Network",
    },
  );
});

test("parseArgs recognizes rollback and report options", () => {
  assert.deepEqual(parseArgs(["--rollback-on-failure", "--report", "out.json"]), {
    reportFile: "out.json",
    rollbackOnFailure: true,
  });
});

test("rollbackDeploymentRecords restores environment and summary snapshots", () => {
  const dir = mkdtempSync(join(tmpdir(), "iln-rollback-"));
  try {
    const envFile = join(dir, ".contracts-testnet.env");
    const summaryFile = join(dir, "deploy-summary.json");
    writeFileSync(`${envFile}.previous`, "INVOICE_LIQUIDITY_ID=OLD\n");
    writeFileSync(`${summaryFile}.previous`, '{"invoice_liquidity":"OLD"}\n');
    writeFileSync(envFile, "INVOICE_LIQUIDITY_ID=NEW\n");
    writeFileSync(summaryFile, '{"invoice_liquidity":"NEW"}\n');

    const result = rollbackDeploymentRecords(envFile, summaryFile);

    assert.equal(result.performed, true);
    assert.equal(result.summaryRestored, true);
    assert.equal(readFileSync(envFile, "utf8"), "INVOICE_LIQUIDITY_ID=OLD\n");
    assert.equal(readFileSync(summaryFile, "utf8"), '{"invoice_liquidity":"OLD"}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rollbackDeploymentRecords reports a missing snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "iln-rollback-missing-"));
  try {
    const result = rollbackDeploymentRecords(join(dir, ".env"), join(dir, "summary.json"));
    assert.equal(result.performed, false);
    assert.match(result.error ?? "", /No rollback snapshot/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
