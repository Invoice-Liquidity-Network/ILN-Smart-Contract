/**
 * Offline guard (runs in the normal unit run, needs no network): keeps the smoke-test map in
 * `mutationRegistry.ts` honest as `src/methods` evolves.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MUTATIONS, READ_ONLY, type SmokeEntry } from "./mutationRegistry.js";

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const METHODS_DIR = join(SDK_ROOT, "src/methods");

/** Names of exported functions (sync or async) across non-test files in src/methods. */
function exportedFunctions(): string[] {
  const names: string[] = [];
  for (const file of readdirSync(METHODS_DIR)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const src = readFileSync(join(METHODS_DIR, file), "utf8");
    for (const m of src.matchAll(/^export (?:async )?function (\w+)/gm)) names.push(m[1]!);
  }
  return names;
}

describe("mutation smoke registry", () => {
  const exported = exportedFunctions();

  it("classifies every exported src/methods function as a mutation or read-only", () => {
    const known = new Set([...Object.keys(MUTATIONS), ...READ_ONLY]);
    const unclassified = exported.filter((n) => !known.has(n));
    expect(unclassified, `add to MUTATIONS (with a smoke test or a deferral reason) or READ_ONLY`).toEqual([]);
  });

  it("has no entries for functions that no longer exist", () => {
    const present = new Set(exported);
    const stale = [...Object.keys(MUTATIONS), ...READ_ONLY].filter((n) => !present.has(n));
    expect(stale).toEqual([]);
  });

  it("does not list a function as both a mutation and read-only", () => {
    const both = READ_ONLY.filter((n) => n in MUTATIONS);
    expect(both).toEqual([]);
  });

  it("points every smoke entry at an existing test that calls the mutation", () => {
    const problems: string[] = [];
    for (const [name, entry] of Object.entries(MUTATIONS)) {
      if (entry.status !== "smoke") continue;
      const { file, test } = entry as SmokeEntry;
      let src: string;
      try {
        src = readFileSync(join(SDK_ROOT, file), "utf8");
      } catch {
        problems.push(`${name}: missing file ${file}`);
        continue;
      }
      if (!src.includes(test)) problems.push(`${name}: no test titled "${test}" in ${file}`);
      if (!new RegExp(`\\b${name}\\(`).test(src)) problems.push(`${name}: ${file} never calls ${name}()`);
      if (!/waitForInvoice|getInvoice|isEnrolled/.test(src)) {
        problems.push(`${name}: ${file} does not read chain state back`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("gives every deferral a reason and detail", () => {
    const bad = Object.entries(MUTATIONS).filter(
      ([, e]) => e.status === "deferred" && (!e.reason || e.detail.trim().length < 10)
    );
    expect(bad.map(([n]) => n)).toEqual([]);
  });
});
