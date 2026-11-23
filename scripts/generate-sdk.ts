/**
 * generate-sdk.ts — prototype Soroban contract spec → TypeScript SDK method stubs.
 *
 * Reads a contract ABI from:
 *   1. `stellar contract inspect --wasm <wasm> --output json`
 *   2. `stellar contract inspect --id <C...> --network testnet --output json`
 *   3. `--spec <path>` (stellar inspect JSON or docs/contract-spec.json from gen-spec.ts)
 *
 * Run:
 *   npx tsx scripts/generate-sdk.ts --spec docs/contract-spec.json
 *   npx tsx scripts/generate-sdk.ts --inspect-json docs/fixtures/stellar-inspect-invoice_liquidity.sample.json
 *   npx tsx scripts/generate-sdk.ts --check
 *
 * Issue #382 research spike — generates skeleton stubs only; business logic stays hand-written.
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.join(__dirname, "..");

export interface SpecParam {
  name: string;
  type: string;
}

export interface NormalizedFunction {
  name: string;
  doc: string;
  parameters: SpecParam[];
  returns: string;
  /** True when the contract fn only reads state (no auth-required writes). */
  readOnly: boolean;
}

export interface NormalizedSpec {
  source: string;
  functions: NormalizedFunction[];
}

/** Map Soroban/Rust scalar types to TypeScript. Complex structs stay as `unknown`. */
export function mapRustTypeToTs(rustType: string): string {
  const t = rustType.trim();
  if (t === "()" || t === "void") return "void";
  if (t === "u64" || t === "u32" || t === "i64" || t === "i128" || t === "u128") return "bigint";
  if (t === "bool") return "boolean";
  if (t === "Address" || t === "String" || t === "Symbol") return "string";
  if (t.startsWith("Option<")) {
    const inner = t.slice("Option<".length, -1);
    return `${mapRustTypeToTs(inner)} | undefined`;
  }
  if (t.startsWith("Vec<")) return "unknown[]";
  if (t.startsWith("BytesN<")) return "Buffer";
  if (t.startsWith("Result<")) {
    const inner = t.slice("Result<".length, -1);
    const comma = splitTopLevelGeneric(inner);
    if (comma.length === 2) return mapRustTypeToTs(comma[0]!);
  }
  return "unknown";
}

/** Map Soroban type string to nativeToScVal `type` option (when applicable). */
export function mapRustTypeToScValType(rustType: string): string | undefined {
  const t = rustType.trim();
  if (t === "u64" || t === "u32") return t;
  if (t === "i128") return "i128";
  if (t === "Address") return "address";
  if (t === "bool") return "bool";
  if (t.startsWith("Option<")) return undefined;
  return undefined;
}

export function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function splitTopLevelGeneric(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of s) {
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
    if (ch === "," && depth === 0) {
      out.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function flattenType(typeField: unknown): string {
  if (typeof typeField === "string") return typeField;
  if (typeField && typeof typeField === "object") {
    const obj = typeField as Record<string, unknown>;
    if ("result" in obj && obj.result && typeof obj.result === "object") {
      const r = obj.result as { ok?: unknown; error?: unknown };
      if (typeof r.ok === "string") return `Result<${r.ok}, ${String(r.error)}>`;
    }
    if ("option" in obj) return `Option<${flattenType(obj.option)}>`;
    if ("vec" in obj) return `Vec<${flattenType(obj.vec)}>`;
  }
  return "unknown";
}

function isReadOnly(returns: string, name: string): boolean {
  if (name.startsWith("get_") || name.startsWith("is_") || name.startsWith("list_")) return true;
  if (returns.startsWith("Result<") && !returns.includes("()")) {
    const inner = returns.slice("Result<".length, -1);
    const parts = splitTopLevelGeneric(inner);
    const ok = parts[0] ?? "";
    return ok !== "()" && ok !== "void";
  }
  if (!returns.startsWith("Result<") && returns !== "()" && returns !== "void") return true;
  return false;
}

/** Normalize stellar inspect JSON (array of function entries). */
export function normalizeStellarInspect(raw: unknown, source: string): NormalizedSpec {
  const functions: NormalizedFunction[] = [];

  const entries = Array.isArray(raw) ? raw : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const fn = entry as Record<string, unknown>;
    if (typeof fn.name !== "string") continue;

    const parameters: SpecParam[] = Array.isArray(fn.inputs)
      ? fn.inputs
          .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
          .map((i) => ({
            name: String(i.name ?? "arg"),
            type: flattenType(i.type),
          }))
      : [];

    const outputs = Array.isArray(fn.outputs) ? fn.outputs : [];
    let returns = "()";
    if (outputs.length > 0 && outputs[0] && typeof outputs[0] === "object") {
      returns = flattenType((outputs[0] as { type?: unknown }).type);
    }

    functions.push({
      name: fn.name,
      doc: typeof fn.doc === "string" ? fn.doc.trim() : "",
      parameters,
      returns,
      readOnly: isReadOnly(returns, fn.name),
    });
  }

  return { source, functions: functions.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** Normalize docs/contract-spec.json produced by scripts/gen-spec.ts. */
export function normalizeGenSpec(raw: unknown, source: string): NormalizedSpec {
  const obj = raw as { functions?: Array<Record<string, unknown>> };
  const functions: NormalizedFunction[] = (obj.functions ?? []).map((fn) => {
    const name = String(fn.name);
    const returns = String(fn.returns ?? "()");
    const parameters: SpecParam[] = Array.isArray(fn.parameters)
      ? fn.parameters.map((p) => ({
          name: String((p as SpecParam).name),
          type: String((p as SpecParam).type),
        }))
      : [];
    return {
      name,
      doc: typeof fn.doc === "string" ? fn.doc.trim() : "",
      parameters,
      returns,
      readOnly: isReadOnly(returns, name),
    };
  });
  return { source, functions: functions.sort((a, b) => a.name.localeCompare(b.name)) };
}

export function normalizeSpec(raw: unknown, source: string): NormalizedSpec {
  if (Array.isArray(raw)) return normalizeStellarInspect(raw, source);
  const obj = raw as { functions?: unknown[] };
  if (obj && Array.isArray(obj.functions)) return normalizeGenSpec(raw, source);
  throw new Error(`Unrecognized spec format in ${source}`);
}

export function runStellarInspect(args: string[]): string {
  const result = childProcess.spawnSync("stellar", ["contract", "inspect", ...args, "--output", "json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `stellar contract inspect failed (${result.status})`);
  }
  return result.stdout;
}

export function loadSpecFromCli(options: {
  wasm?: string;
  contractId?: string;
  network?: string;
  specPath?: string;
  inspectJson?: string;
}): NormalizedSpec {
  if (options.inspectJson) {
    const abs = path.isAbsolute(options.inspectJson)
      ? options.inspectJson
      : path.join(REPO_ROOT, options.inspectJson);
    const raw = JSON.parse(fs.readFileSync(abs, "utf8"));
    return normalizeSpec(raw, options.inspectJson);
  }

  if (options.specPath) {
    const abs = path.isAbsolute(options.specPath)
      ? options.specPath
      : path.join(REPO_ROOT, options.specPath);
    const raw = JSON.parse(fs.readFileSync(abs, "utf8"));
    return normalizeSpec(raw, options.specPath);
  }

  if (options.wasm) {
    const abs = path.isAbsolute(options.wasm) ? options.wasm : path.join(REPO_ROOT, options.wasm);
    const stdout = runStellarInspect(["--wasm", abs]);
    return normalizeSpec(JSON.parse(stdout), abs);
  }

  if (options.contractId) {
    const inspectArgs = ["--id", options.contractId];
    if (options.network) inspectArgs.push("--network", options.network);
    const stdout = runStellarInspect(inspectArgs);
    return normalizeSpec(JSON.parse(stdout), `contract:${options.contractId}`);
  }

  throw new Error("Provide --spec, --inspect-json, --wasm, or --contract-id");
}

function scValArg(param: SpecParam): string {
  const scType = mapRustTypeToScValType(param.type);
  if (scType === "address") {
    return `nativeToScVal(${snakeToCamel(param.name)}, { type: "address" })`;
  }
  if (scType) {
    return `nativeToScVal(${snakeToCamel(param.name)}, { type: "${scType}" })`;
  }
  return `nativeToScVal(${snakeToCamel(param.name)}) /* TODO: ${param.type} */`;
}

export function generateMethodStub(fn: NormalizedFunction): string {
  const tsName = snakeToCamel(fn.name);
  const paramTypes = fn.parameters.map((p) => `${snakeToCamel(p.name)}: ${mapRustTypeToTs(p.type)}`);
  const returnTs = fn.readOnly ? mapRustTypeToTs(fn.returns.replace(/^Result<([^,>]+).*$/, "$1")) : "string";
  const returnType = fn.readOnly ? `Promise<${returnTs}>` : "Promise<{ txHash: string }>";

  const contractArgs = fn.parameters.map((p) => scValArg(p)).join(",\n    ");
  const callArgs = contractArgs ? `\n    ${contractArgs},\n  ` : "";

  const simBlock = fn.readOnly
    ? `
  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw ILNError.fromError(sim.error);
  }
  if (!sim.result?.retval) {
    throw new ILNError("Empty simulation result for ${fn.name}");
  }
  return scValToNative(sim.result.retval) as ${returnTs};`
    : `
  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw ILNError.fromError(sim.error);
  }
  const assembledTx = SorobanRpc.assembleTransaction(tx, sim).build();
  const signedTx = await signTransaction(assembledTx);
  const sendResult = await server.sendTransaction(signedTx);
  if (sendResult.errorResultXdr) {
    throw new Error(\`Transaction failed: \${sendResult.errorResultXdr}\`);
  }
  return { txHash: sendResult.hash };`;

  const extraParams = fn.readOnly
    ? `,
  sourceAccount: Account`
    : `,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction`;

  const doc = fn.doc ? ` * ${fn.doc.replace(/\n/g, "\n * ")}\n` : "";

  return `/**
 * AUTO-GENERATED stub for \`${fn.name}\`. Review before use.
 *${doc ? `\n${doc}` : ""} */
export async function ${tsName}(
  server: SorobanRpc.Server,
  contractAddress: string,${paramTypes.length ? `\n  ${paramTypes.join(",\n  ")},` : ""}
  networkPassphrase: string${extraParams}
): ${returnType} {
  const contract = new Contract(contractAddress);
  const op = contract.call(
    "${fn.name}",${callArgs}
  );

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();
${simBlock}
}
`;
}

export interface SdkDriftOptions {
  spec: NormalizedSpec;
  generatedDir: string;
  contractSourcePath: string;
  only?: string[];
}

function camelToSnake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function rustParamsFromSource(source: string, fnName: string): SpecParam[] | null {
  const marker = new RegExp(`\\bpub\\s+fn\\s+${escapeRegExp(fnName)}\\s*\\(`);
  const match = marker.exec(source);
  if (!match) return null;

  const open = source.indexOf("(", match.index);
  const close = matchingParen(source, open);
  if (close < 0) return null;

  return splitParamList(source.slice(open + 1, close))
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((param) => {
      const colon = param.indexOf(":");
      if (colon < 0) return null;
      const name = param.slice(0, colon).replace(/^mut\s+/, "").trim();
      const type = param.slice(colon + 1).replace(/^&\s*(mut\s+)?/, "").trim();
      return name ? { name, type } : null;
    })
    .filter((p): p is SpecParam => p !== null && p.name !== "env");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitParamList(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of value) {
    if ("<([{".includes(ch)) depth++;
    else if (">)]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function generatedParams(source: string, camelName: string): string[] | null {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes(`export async function ${camelName}(`));
  if (start < 0) return null;

  const signature: string[] = [];
  for (let i = start; i < lines.length; i++) {
    signature.push(lines[i]!);
    if (/^\)\s*:/.test(lines[i]!)) break;
  }

  const fixed = new Set(["server", "contractAddress", "networkPassphrase", "sourceAccount", "signTransaction"]);
  return signature
    .map((line) => /^\s*([A-Za-z_]\w*)\s*:/.exec(line)?.[1])
    .filter((name): name is string => !!name && !fixed.has(name));
}

export function checkSdkContractDrift(options: SdkDriftOptions): string[] {
  const drift: string[] = [];
  const indexPath = path.join(options.generatedDir, "index.generated.ts");
  if (!fs.existsSync(indexPath)) return [`generated SDK index missing: ${indexPath}`];
  const index = fs.readFileSync(indexPath, "utf8");

  const generated = new Map<string, string>();
  const exportPattern = /export\s*\{\s*([A-Za-z_]\w*)\s*\}\s*from\s*["']\.\/([A-Za-z_]\w*)\.generated\.js["'];?/g;
  for (const match of index.matchAll(exportPattern)) {
    generated.set(camelToSnake(match[1]!), match[1]!);
  }

  const specByName = new Map(options.spec.functions.map((f) => [f.name, f]));
  const required = options.only?.length ? options.only : [...generated.keys()];
  const names = [...new Set([...required, ...generated.keys()])].sort();

  const contractSource = fs.readFileSync(options.contractSourcePath, "utf8");
  for (const name of names) {
    const camel = snakeToCamel(name);
    if (!generated.has(name)) {
      drift.push(`generated SDK export missing for contract entrypoint ${name}`);
      continue;
    }
    if (generated.get(name) !== camel) {
      drift.push(`generated SDK export ${generated.get(name)} does not match contract entrypoint ${name}`);
    }

    const specFn = specByName.get(name);
    if (!specFn) {
      drift.push(`contract spec entry missing for generated SDK method ${name}`);
      continue;
    }

    const rustParams = rustParamsFromSource(contractSource, name);
    if (!rustParams) {
      drift.push(`Rust contract entrypoint missing for generated SDK method ${name}`);
      continue;
    }

    const expectedParams = rustParams.map((p) => `${snakeToCamel(p.name)}: ${mapRustTypeToTs(p.type)}`);
    const specParams = specFn.parameters.map((p) => `${snakeToCamel(p.name)}: ${mapRustTypeToTs(p.type)}`);
    if (JSON.stringify(expectedParams) !== JSON.stringify(specParams)) {
      drift.push(
        `contract spec/Rust signature drift for ${name}: Rust ${expectedParams.join(", ")} vs spec ${specParams.join(", ")}`
      );
    }

    const stubPath = path.join(options.generatedDir, `${camel}.generated.ts`);
    if (!fs.existsSync(stubPath)) {
      drift.push(`generated SDK stub missing: ${stubPath}`);
      continue;
    }
    const stub = fs.readFileSync(stubPath, "utf8");
    if (!stub.includes(`"${name}"`)) {
      drift.push(`generated SDK stub ${camel} does not call contract entrypoint ${name}`);
    }
    const actualParams = generatedParams(stub, camel);
    if (!actualParams) {
      drift.push(`generated SDK stub signature missing: ${camel}`);
    } else if (JSON.stringify(actualParams) !== JSON.stringify(rustParams.map((p) => snakeToCamel(p.name)))) {
      drift.push(
        `SDK/Rust param drift for ${name}: SDK ${actualParams.join(", ")} vs Rust ${rustParams.map((p) => snakeToCamel(p.name)).join(", ")}`
      );
    }
  }

  return drift;
}

export function generateSdkFiles(
  spec: NormalizedSpec,
  outputDir: string,
  only?: string[]
): { files: string[]; count: number } {
  const filter = only?.length ? new Set(only) : null;
  const selected = spec.functions.filter((f) => !filter || filter.has(f.name));

  fs.mkdirSync(outputDir, { recursive: true });

  const header = `/**
 * AUTO-GENERATED by scripts/generate-sdk.ts — do not edit by hand.
 * Source: ${spec.source}
 * Regenerate: npx tsx scripts/generate-sdk.ts --spec docs/contract-spec.json
 */
import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  Account,
  Transaction,
} from "@stellar/stellar-sdk";
import { ILNError } from "../errors.js";

`;

  const files: string[] = [];
  for (const fn of selected) {
    const fileName = `${snakeToCamel(fn.name)}.generated.ts`;
    const filePath = path.join(outputDir, fileName);
    fs.writeFileSync(filePath, header + generateMethodStub(fn));
    files.push(filePath);
  }

  const indexBody = selected
    .map((fn) => `export { ${snakeToCamel(fn.name)} } from "./${snakeToCamel(fn.name)}.generated.js";`)
    .join("\n");
  const indexPath = path.join(outputDir, "index.generated.ts");
  fs.writeFileSync(
    indexPath,
    `/**\n * AUTO-GENERATED by scripts/generate-sdk.ts — do not edit by hand.\n * Source: ${spec.source}\n */\n${indexBody}\n`
  );
  files.push(indexPath);

  return { files, count: selected.length };
}

function parseArgs(argv: string[]): {
  wasm?: string;
  contractId?: string;
  network?: string;
  specPath?: string;
  inspectJson?: string;
  outputDir: string;
  only: string[];
  check: boolean;
  contractSource: string;
} {
  const out: ReturnType<typeof parseArgs> = {
    outputDir: path.join(REPO_ROOT, "sdk/src/generated"),
    only: [],
    check: false,
    contractSource: path.join(REPO_ROOT, "contracts/invoice_liquidity/src/lib.rs"),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--wasm") out.wasm = argv[++i];
    else if (arg === "--contract-id") out.contractId = argv[++i];
    else if (arg === "--network") out.network = argv[++i];
    else if (arg === "--spec") out.specPath = argv[++i];
    else if (arg === "--inspect-json") out.inspectJson = argv[++i];
    else if (arg === "--output") out.outputDir = path.isAbsolute(argv[++i]!) ? argv[i]! : path.join(REPO_ROOT, argv[i]!);
    else if (arg === "--only") out.only = argv[++i]!.split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--check") out.check = true;
    else if (arg === "--contract-source") out.contractSource = argv[++i]!;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: npx tsx scripts/generate-sdk.ts [options]

  --spec <path>           gen-spec or inspect JSON file (default fallback)
  --inspect-json <path>   stellar contract inspect JSON array
  --wasm <path>           run stellar contract inspect --wasm
  --contract-id <C...>    run stellar contract inspect --id (use with --network)
  --network <name>        testnet | mainnet | local
  --output <dir>          output directory (default: sdk/src/generated)
  --only <a,b,c>          generate only these snake_case function names
  --check                 read-only ABI/SDK drift gate; exits non-zero on drift
  --contract-source <p>   Rust contract source for --check
`);
      process.exit(0);
    }
  }

  if (!out.specPath && !out.inspectJson && !out.wasm && !out.contractId) {
    out.specPath = "docs/contract-spec.json";
  }
  if (out.only.length === 0) {
    out.only = ["get_invoice", "cancel_invoice", "mark_paid"];
  }

  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const spec = loadSpecFromCli(opts);

  if (opts.check) {
    const drift = checkSdkContractDrift({
      spec,
      generatedDir: opts.outputDir,
      contractSourcePath: opts.contractSource,
      only: opts.only,
    });
    if (drift.length) {
      for (const message of drift) console.error(`❌ ${message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`✅ Generated SDK matches the contract ABI (${spec.functions.length} spec entrypoints)`);
    return;
  }

  const { files, count } = generateSdkFiles(spec, opts.outputDir, opts.only);
  console.log(`✅ Generated ${count} method stub(s) in ${opts.outputDir}`);
  for (const f of files) console.log(`   ${path.relative(REPO_ROOT, f)}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMain) main();
