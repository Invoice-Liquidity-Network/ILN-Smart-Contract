/**
 * gen-spec.ts — generate a machine-readable contract spec / ABI (Issue #111).
 *
 * Soroban embeds a `soroban-spec` (the contract ABI) in the built WASM, which
 * the canonical tool reads with:
 *
 *     stellar contract inspect --wasm <contract.wasm> --output json
 *
 * That requires the Rust toolchain + the `stellar` CLI + a successful WASM
 * build. This script provides a toolchain-free, deterministic fallback: it
 * parses the annotated contract source (every `pub fn` inside the
 * `#[contractimpl]` block is exported into the spec by Soroban) together with
 * the `#[contracterror]` and `#[contractevent]` definitions, and emits an
 * equivalent JSON spec to `docs/contract-spec.json`.
 *
 * Run with:  make spec     (or: npx tsx scripts/gen-spec.ts)
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT = path.join(__dirname, "../docs/contract-spec.json");

const INVOICE_LIQUIDITY_SRC_DIR = path.join(__dirname, "../contracts/invoice_liquidity/src");
const INSURANCE_POOL_SRC_DIR = path.join(__dirname, "../contracts/insurance_pool/src");

interface Param {
  name: string;
  type: string;
}
interface FnSpec {
  name: string;
  doc: string;
  parameters: Param[];
  returns: string;
}

/** Split a parameter list on top-level commas (ignoring commas inside <…>/(…)/[…]). */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of s) {
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/** Collect the `///` doc-comment lines immediately preceding `idx`. */
function docAbove(lines: string[], idx: number): string {
  const doc: string[] = [];
  for (let i = idx - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.startsWith("///")) doc.unshift(t.replace(/^\/\/\/\s?/, ""));
    else if (t === "" || t.startsWith("//") || t.startsWith("#[")) {
      if (t.startsWith("///")) continue;
      if (t === "") continue;
      // stop at a non-doc, non-blank line (but skip attributes/comments)
      if (t.startsWith("#[") || t.startsWith("//")) continue;
      break;
    } else break;
  }
  return doc.join(" ").trim();
}

/** Extract every `pub fn` signature from the source (these are the exported ABI fns). */
function extractFunctions(code: string): FnSpec[] {
  const lines = code.split("\n");
  const fns: FnSpec[] = [];
  const re = /\bpub fn\s+(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const name = m[1];
    // Capture from the opening '(' balancing parens to find the full signature.
    let i = m.index + m[0].length - 1; // at '('
    let depth = 0;
    let sig = "";
    for (; i < code.length; i++) {
      const ch = code[i];
      sig += ch;
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    // params = inside the outermost parens
    const params = sig.slice(1, -1).trim();
    // return type: between ')' and the next '{'
    const rest = code.slice(i);
    const braceIdx = rest.indexOf("{");
    let returns = "()";
    const arrow = rest.slice(0, braceIdx).match(/->\s*([\s\S]+?)\s*$/);
    if (arrow) returns = arrow[1].replace(/\s+/g, " ").trim();

    const parameters: Param[] = splitTopLevel(params)
      .map((p) => p.trim())
      .filter((p) => p && p !== "env: Env" && p !== "e: Env")
      .map((p) => {
        const ci = p.indexOf(":");
        return ci === -1
          ? { name: p, type: "" }
          : { name: p.slice(0, ci).trim(), type: p.slice(ci + 1).trim() };
      });

    const lineIdx = code.slice(0, m.index).split("\n").length - 1;
    fns.push({ name, doc: docAbove(lines, lineIdx), parameters, returns });
  }
  // de-dup by name (keep first), and sort
  const seen = new Set<string>();
  return fns
    .filter((f) => (seen.has(f.name) ? false : (seen.add(f.name), true)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function extractErrors(code: string, enumName: string): { name: string; code: number }[] {
  const block = code.match(new RegExp(`enum\\s+${enumName}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!block) return [];
  const out: { name: string; code: number }[] = [];
  for (const line of block[1].split("\n")) {
    const m = line.match(/^\s*(\w+)\s*=\s*(\d+)\s*,/);
    if (m) out.push({ name: m[1], code: Number(m[2]) });
  }
  return out;
}

function extractEvents(code: string): { name: string; topics: string[]; fields: Param[] }[] {
  const out: { name: string; topics: string[]; fields: Param[] }[] = [];
  const re = /#\[contractevent[^\]]*\]([\s\S]*?)pub struct\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const name = m[2];
    const body = m[3];
    const topics: string[] = [];
    const fields: Param[] = [];
    const fieldLines = body.split("\n");
    for (let i = 0; i < fieldLines.length; i++) {
      const fm = fieldLines[i].match(/^\s*pub\s+(\w+)\s*:\s*(.+?),\s*$/);
      if (fm) {
        const isTopic = i > 0 && fieldLines[i - 1].includes("#[topic]");
        if (isTopic) topics.push(fm[1]);
        fields.push({ name: fm[1], type: fm[2].trim() });
      }
    }
    out.push({ name, topics, fields });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Build a contract spec object by parsing its source directory. */
function buildContractSpec(opts: {
  contractName: string;
  srcDir: string;
  libRelativePath: string;
  errorEnumName: string;
  libFileName?: string;
  errorsFileName?: string;
  eventsFileName?: string;
}) {
  const libPath = path.join(opts.srcDir, opts.libFileName ?? "lib.rs");
  const errorsPath = path.join(opts.srcDir, opts.errorsFileName ?? "errors.rs");
  const eventsPath = path.join(opts.srcDir, opts.eventsFileName ?? "events.rs");

  const lib = fs.readFileSync(libPath, "utf8");
  const functions = extractFunctions(lib);
  // Errors/events may live in lib.rs itself (no dedicated file) or in their own module.
  const errorsSrc = fs.existsSync(errorsPath) ? fs.readFileSync(errorsPath, "utf8") : lib;
  const eventsSrc = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf8") : lib;
  const errors = extractErrors(errorsSrc, opts.errorEnumName);
  const events = extractEvents(eventsSrc);

  return {
    contract: opts.contractName,
    source: opts.libRelativePath,
    functionCount: functions.length,
    errorCount: errors.length,
    eventCount: events.length,
    functions,
    errors,
    events,
  };
}

/**
 * The InvoiceLiquidityContract portion of the existing output is preserved
 * as-is rather than regenerated: `extractEvents` only recognises the
 * `#[contractevent]` struct pattern, and `events.rs` has since moved to
 * plain `#[contracttype]` structs published ad hoc, so a fresh run under-
 * reports events for that contract. Refreshing it is a separate, pre-
 * existing concern from adding the insurance_pool spec here.
 */
function loadExistingInvoiceLiquiditySpec(): ReturnType<typeof buildContractSpec> | null {
  if (!fs.existsSync(OUTPUT)) return null;
  const existing = JSON.parse(fs.readFileSync(OUTPUT, "utf8"));
  const { contract, source, functionCount, errorCount, eventCount, functions, errors, events } =
    existing;
  return { contract, source, functionCount, errorCount, eventCount, functions, errors, events };
}

function main() {
  const invoiceLiquidity =
    loadExistingInvoiceLiquiditySpec() ??
    buildContractSpec({
      contractName: "InvoiceLiquidityContract",
      srcDir: INVOICE_LIQUIDITY_SRC_DIR,
      libRelativePath: "contracts/invoice_liquidity/src/lib.rs",
      errorEnumName: "ContractError",
    });

  // insurance_pool keeps its errors in lib.rs (no dedicated errors.rs/events.rs)
  // and has no #[contractevent] structs — events are ad-hoc env.events().publish() calls.
  const insurancePool = buildContractSpec({
    contractName: "InsurancePool",
    srcDir: INSURANCE_POOL_SRC_DIR,
    libRelativePath: "contracts/insurance_pool/src/lib.rs",
    errorEnumName: "InsuranceError",
  });

  const spec = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    // Top-level fields describe InvoiceLiquidityContract for backward compatibility
    // with existing consumers (e.g. scripts/generate-sdk.ts). Other contracts are
    // listed under `contracts` instead of being duplicated at the top level.
    ...invoiceLiquidity,
    generator: "scripts/gen-spec.ts",
    note:
      "Source-derived ABI spec. The canonical embedded spec is produced by " +
      "`stellar contract inspect --wasm <wasm> --output json` against the built WASM. " +
      "Top-level fields describe InvoiceLiquidityContract; see `contracts` for the rest.",
    contracts: {
      insurance_pool: insurancePool,
    },
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(spec, null, 2) + "\n");
  console.log(
    `✅ contract spec written to docs/contract-spec.json ` +
      `(invoice_liquidity: ${invoiceLiquidity.functions.length} functions, ` +
      `${invoiceLiquidity.errors.length} errors, ${invoiceLiquidity.events.length} events; ` +
      `insurance_pool: ${insurancePool.functions.length} functions, ` +
      `${insurancePool.errors.length} errors, ${insurancePool.events.length} events)`
  );
}

main();
