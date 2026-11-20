/**
 * Tests for generate-sdk.ts (Issue #382 spike).
 *
 *   npx tsx --test scripts/generate-sdk.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkSdkContractDrift,
  generateSdkFiles,
  loadSpecFromCli,
  mapRustTypeToTs,
  normalizeSpec,
  snakeToCamel,
} from "./generate-sdk.ts";

test("mapRustTypeToTs maps Soroban scalars", () => {
  assert.equal(mapRustTypeToTs("u64"), "bigint");
  assert.equal(mapRustTypeToTs("Address"), "string");
  assert.equal(mapRustTypeToTs("Result<u64, ContractError>"), "bigint");
  assert.equal(mapRustTypeToTs("Option<BytesN<32>>"), "Buffer | undefined");
});

test("snakeToCamel converts contract names", () => {
  assert.equal(snakeToCamel("get_invoice"), "getInvoice");
  assert.equal(snakeToCamel("mark_paid"), "markPaid");
});

test("normalizeSpec accepts stellar inspect JSON array", () => {
  const fixture = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "../docs/fixtures/stellar-inspect-invoice_liquidity.sample.json"
  );
  const raw = JSON.parse(fs.readFileSync(fixture, "utf8"));
  const spec = normalizeSpec(raw, fixture);
  assert.ok(spec.functions.length >= 4);
  const names = spec.functions.map((f) => f.name);
  assert.ok(names.includes("get_invoice"));
  assert.ok(names.includes("cancel_invoice"));
  assert.ok(names.includes("mark_paid"));
});

test("normalizeSpec accepts gen-spec contract-spec.json shape", () => {
  const specPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "../docs/contract-spec.json"
  );
  const raw = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const spec = normalizeSpec(raw, specPath);
  assert.equal(spec.functions.length, raw.functionCount);
});

test("generateSdkFiles writes at least three typed stubs", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iln-sdk-gen-"));
  const spec = loadSpecFromCli({
    inspectJson: "docs/fixtures/stellar-inspect-invoice_liquidity.sample.json",
  });
  const { count, files } = generateSdkFiles(spec, tmp, [
    "get_invoice",
    "cancel_invoice",
    "mark_paid",
  ]);
  assert.equal(count, 3);
  assert.ok(files.some((f) => f.endsWith("getInvoice.generated.ts")));
  assert.ok(files.some((f) => f.endsWith("cancelInvoice.generated.ts")));
  assert.ok(files.some((f) => f.endsWith("markPaid.generated.ts")));

  const getInvoice = fs.readFileSync(path.join(tmp, "getInvoice.generated.ts"), "utf8");
  assert.match(getInvoice, /export async function getInvoice/);
  assert.match(getInvoice, /invoiceId: bigint/);
  assert.match(getInvoice, /Promise<unknown>/);
});

test("checkSdkContractDrift accepts generated stubs matching the contract ABI", () => {
  const spec = loadSpecFromCli({ specPath: "docs/contract-spec.json" });
  const drift = checkSdkContractDrift({
    spec,
    generatedDir: path.join(path.dirname(new URL(import.meta.url).pathname), "../sdk/src/generated"),
    contractSourcePath: path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "../contracts/invoice_liquidity/src/lib.rs"
    ),
  });
  assert.deepEqual(drift, []);
});

test("checkSdkContractDrift reports missing and mismatched generated methods", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iln-sdk-drift-"));
  fs.writeFileSync(path.join(tmp, "index.generated.ts"), 'export { getInvoice } from "./getInvoice.generated.js";\n');
  fs.writeFileSync(
    path.join(tmp, "getInvoice.generated.ts"),
    'export async function getInvoice(\n  server: X,\n  contractAddress: string,\n  invoiceId: string,\n  networkPassphrase: string\n): Promise<unknown> { contract.call("get_invoice"); }\n'
  );
  const rustSource = path.join(tmp, "contract.rs");
  fs.writeFileSync(rustSource, "pub fn get_invoice(env: Env, invoice_id: u64) -> Result<(), Error> {}\n");
  const spec = loadSpecFromCli({ specPath: "docs/contract-spec.json" });

  const drift = checkSdkContractDrift({
    spec,
    generatedDir: tmp,
    contractSourcePath: rustSource,
    only: ["get_invoice", "cancel_invoice"],
  });
  assert.ok(drift.some((m) => m.includes("generated SDK export missing for contract entrypoint cancel_invoice")));
  assert.ok(drift.some((m) => m.includes("SDK/Rust param drift for get_invoice")));
});
