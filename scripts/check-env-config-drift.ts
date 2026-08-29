#!/usr/bin/env node
/**
 * check-env-config-drift.ts — catches silent drift between per-network
 * `.contracts-<network>.env` files (Issue #653).
 *
 * `.contracts-testnet.env` and any future `.contracts-mainnet.env` are
 * hand-maintained and easy to let drift apart: a key added to one file but
 * not the other, a `NETWORK=` value that doesn't match its own filename, or
 * a value (e.g. a contract ID, or a tunable constant changed "temporarily"
 * for testnet convenience) that gets copy-pasted into the other network's
 * file and never reverted. None of that is caught by anything else in CI.
 *
 * This script checks every `.contracts-*.env` file in the repo root for:
 *
 *   1. Schema parity   — every key present in one network's file must be
 *                         present in all the others.
 *   2. NETWORK sanity  — a file's `NETWORK=` value must match the network
 *                         name in its own filename.
 *   3. Cross-file reuse — no non-exempt key may share an identical value
 *                         across two different network files. Contract IDs,
 *                         admin addresses, and tunable constants are
 *                         per-deployment/per-network by construction; an
 *                         identical value is the exact "changed for testnet,
 *                         never reverted for mainnet" bug this check exists
 *                         to catch.
 *
 * Only one network file exists before mainnet is deployed, so with fewer
 * than two files present this exits 0 as a no-op (mirrors
 * verify-admin-signers.ts's "not configured yet" behavior) rather than
 * failing CI on every run.
 *
 * Usage:
 *   npx tsx scripts/check-env-config-drift.ts
 *
 * Configuration:
 *   ENV_FILES_DIR   Directory to scan for `.contracts-*.env` files
 *                    (default: repo root).
 */

import { readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";

/** Keys that are expected/allowed to be identical (or file-specific by design). */
const EXEMPT_KEYS = new Set(["NETWORK", "SOURCE"]);

export interface EnvFile {
  /** e.g. "testnet", "mainnet" — parsed from the filename. */
  network: string;
  fileName: string;
  values: Record<string, string>;
}

/** Parse a `.env`-style file into an ordered key/value map, ignoring comments/blank lines. */
export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    values[key] = value;
  }
  return values;
}

/** Find and load every `.contracts-<network>.env` file in `dir`. */
export function loadEnvFiles(dir: string): EnvFile[] {
  const pattern = /^\.contracts-([a-z0-9]+)\.env$/;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: EnvFile[] = [];
  for (const fileName of entries) {
    const match = pattern.exec(fileName);
    if (!match) continue;
    const contents = readFileSync(join(dir, fileName), "utf-8");
    files.push({ network: match[1], fileName, values: parseEnvFile(contents) });
  }
  return files.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

/** Run all drift checks across the given env files. Returns human-readable error strings. */
export function checkDrift(files: EnvFile[]): string[] {
  const errors: string[] = [];
  if (files.length < 2) return errors;

  // 1. Schema parity — union of all keys must appear in every file.
  const allKeys = new Set<string>();
  for (const f of files) for (const k of Object.keys(f.values)) allKeys.add(k);
  for (const key of allKeys) {
    const missingFrom = files.filter((f) => !(key in f.values));
    if (missingFrom.length > 0) {
      errors.push(
        `Schema drift: "${key}" is missing from ${missingFrom
          .map((f) => f.fileName)
          .join(", ")} but present in ${files
          .filter((f) => key in f.values)
          .map((f) => f.fileName)
          .join(", ")}.`
      );
    }
  }

  // 2. NETWORK sanity — NETWORK= value must match the file's own network suffix.
  for (const f of files) {
    const declared = f.values.NETWORK;
    if (declared && declared.toLowerCase() !== f.network.toLowerCase()) {
      errors.push(
        `NETWORK mismatch in ${f.fileName}: filename implies "${f.network}" but NETWORK="${declared}".`
      );
    }
  }

  // 3. Cross-file reuse — non-exempt keys must differ across distinct network files.
  for (const key of allKeys) {
    if (EXEMPT_KEYS.has(key)) continue;
    const withValue = files.filter((f) => key in f.values);
    for (let i = 0; i < withValue.length; i++) {
      for (let j = i + 1; j < withValue.length; j++) {
        const a = withValue[i];
        const b = withValue[j];
        if (a.network === b.network) continue;
        if (a.values[key] === b.values[key]) {
          errors.push(
            `Cross-network reuse: "${key}" has the identical value in ${a.fileName} and ` +
              `${b.fileName} ("${a.values[key]}"). This usually means a value meant to be ` +
              `network-specific (a contract ID, admin address, or a constant tuned for one ` +
              `network) was copy-pasted and never updated for the other.`
          );
        }
      }
    }
  }

  return errors;
}

export async function main(): Promise<number> {
  const dir = resolve(process.env.ENV_FILES_DIR || ".");
  const files = loadEnvFiles(dir);

  if (files.length < 2) {
    console.log(
      `ℹ️  Found ${files.length} .contracts-*.env file(s) — need at least 2 networks to ` +
        `check for drift. Skipping (no-op until a second network file, e.g. ` +
        `.contracts-mainnet.env, exists).`
    );
    return 0;
  }

  console.log(`Checking config drift across: ${files.map((f) => f.fileName).join(", ")}`);
  const errors = checkDrift(files);

  if (errors.length === 0) {
    console.log("✅ No configuration drift detected.");
    return 0;
  }

  console.error(`\n❌ Found ${errors.length} configuration drift issue(s):\n`);
  for (const err of errors) console.error(`  - ${err}`);
  return 1;
}

const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] &&
  /check-env-config-drift\.(ts|js|mjs)$/.test(process.argv[1]);

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`check-env-config-drift crashed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  );
}
