#!/usr/bin/env node
/**
 * verify-admin-signers.ts — ties the on-chain mainnet admin/multisig signer
 * set to the off-chain .github/CODEOWNERS list (Issue #647).
 *
 * Without this, the on-chain multisig signer set and the CODEOWNERS-declared
 * contracts team can drift apart silently: someone leaves the team but their
 * key stays a signer, or a key is added on-chain without ever being recorded
 * off-chain. This script fails CI when that drift is detectable.
 *
 * Drift is checked in two layers:
 *   1. Local (always runs): every signer key currently on the admin account
 *      must have a matching entry in .github/mainnet-admin-signers.json, and
 *      vice versa — no unmapped or stale keys.
 *   2. Remote (only when GITHUB_TOKEN is set): every mapped signer's GitHub
 *      username must currently be a member of the team the mapping file
 *      claims to represent, and that team must match what CODEOWNERS
 *      actually assigns to contracts/.
 *
 * Before the multi-sig admin exists (see "Multi-sig admin configured" on the
 * mainnet launch checklist), this exits 0 with a clear "not configured yet"
 * message rather than failing CI on every run.
 *
 * Configuration (environment variables):
 *   ADMIN_ADDRESS    Stellar account ID of the mainnet admin/multisig.
 *                     Falls back to reading ADMIN_ADDRESS from
 *                     .contracts-mainnet.env when unset.
 *   HORIZON_URL       Horizon endpoint (default: mainnet Horizon).
 *   GITHUB_TOKEN      Optional; enables the CODEOWNERS-team membership check.
 *   SIGNERS_FILE      Path to the signer mapping (default:
 *                      .github/mainnet-admin-signers.json).
 *   CODEOWNERS_FILE   Path to CODEOWNERS (default: .github/CODEOWNERS).
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

interface SignerMapping {
  codeownersTeam: string;
  signers: { publicKey: string; githubUsername: string }[];
}

interface HorizonSigner {
  key: string;
  type: string;
  weight: number;
}

const HORIZON_URL = (process.env.HORIZON_URL || "https://horizon.stellar.org").replace(/\/$/, "");
const SIGNERS_FILE = process.env.SIGNERS_FILE || ".github/mainnet-admin-signers.json";
const CODEOWNERS_FILE = process.env.CODEOWNERS_FILE || ".github/CODEOWNERS";

function loadAdminAddress(): string | null {
  if (process.env.ADMIN_ADDRESS) return process.env.ADMIN_ADDRESS;

  const envFile = process.env.MAINNET_ENV_FILE || ".contracts-mainnet.env";
  const path = resolve(envFile);
  if (!existsSync(path)) return null;

  const content = readFileSync(path, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("ADMIN_ADDRESS=")) {
      return trimmed.slice("ADMIN_ADDRESS=".length).trim();
    }
  }
  return null;
}

function loadSignerMapping(): SignerMapping {
  const path = resolve(SIGNERS_FILE);
  if (!existsSync(path)) {
    console.error(`Missing ${SIGNERS_FILE}. Create it to record who controls each signer key.`);
    process.exit(1);
  }
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  return { codeownersTeam: parsed.codeownersTeam, signers: parsed.signers || [] };
}

/** Returns the owner tokens (e.g. "@org/team") CODEOWNERS assigns to a path pattern. */
function codeownersForPath(pattern: string): string[] {
  const path = resolve(CODEOWNERS_FILE);
  if (!existsSync(path)) {
    console.error(`Missing ${CODEOWNERS_FILE}.`);
    process.exit(1);
  }
  const content = readFileSync(path, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [linePattern, ...owners] = trimmed.split(/\s+/);
    if (linePattern === pattern) return owners;
  }
  return [];
}

async function fetchOnChainSigners(adminAddress: string): Promise<HorizonSigner[]> {
  const res = await fetch(`${HORIZON_URL}/accounts/${adminAddress}`);
  if (!res.ok) {
    throw new Error(`Horizon returned HTTP ${res.status} for account ${adminAddress}`);
  }
  const json: any = await res.json();
  return json.signers || [];
}

async function fetchTeamMembers(team: string, token: string): Promise<Set<string>> {
  // team is "@org/slug"
  const match = /^@([^/]+)\/(.+)$/.exec(team);
  if (!match) throw new Error(`Malformed team reference: ${team}`);
  const [, org, slug] = match;
  const res = await fetch(`https://api.github.com/orgs/${org}/teams/${slug}/members`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`GitHub API returned HTTP ${res.status} for team ${team}`);
  }
  const members: any[] = await res.json();
  return new Set(members.map((m) => m.login.toLowerCase()));
}

async function main(): Promise<number> {
  const adminAddress = loadAdminAddress();
  if (!adminAddress) {
    console.log(
      "ADMIN_ADDRESS not configured (mainnet multi-sig admin not yet set up) — skipping signer/CODEOWNERS check."
    );
    return 0;
  }

  const mapping = loadSignerMapping();
  let failed = false;

  // Layer 0: the mapping file's declared team must match what CODEOWNERS
  // actually assigns to contracts/ — otherwise the whole check is auditing
  // the wrong group.
  const contractsOwners = codeownersForPath("contracts/");
  if (!contractsOwners.includes(mapping.codeownersTeam)) {
    console.error(
      `FAIL  ${SIGNERS_FILE} claims signers represent '${mapping.codeownersTeam}', but ${CODEOWNERS_FILE} assigns contracts/ to: ${contractsOwners.join(", ") || "(nothing)"}`
    );
    failed = true;
  } else {
    console.log(`PASS  ${SIGNERS_FILE} team '${mapping.codeownersTeam}' matches CODEOWNERS for contracts/`);
  }

  // Layer 1: on-chain signer set vs. the local mapping file.
  console.log(`\nFetching signers for ${adminAddress} from ${HORIZON_URL}...`);
  const onChainSigners = await fetchOnChainSigners(adminAddress);
  const onChainKeys = new Set(onChainSigners.map((s) => s.key));
  const mappedKeys = new Set(mapping.signers.map((s) => s.publicKey));

  for (const key of onChainKeys) {
    if (!mappedKeys.has(key)) {
      console.error(`FAIL  On-chain signer ${key} has no entry in ${SIGNERS_FILE}`);
      failed = true;
    }
  }
  for (const entry of mapping.signers) {
    if (!onChainKeys.has(entry.publicKey)) {
      console.error(
        `FAIL  ${SIGNERS_FILE} lists ${entry.publicKey} (${entry.githubUsername}) but it is not a signer on ${adminAddress} — key rotated or removed without updating the mapping`
      );
      failed = true;
    }
  }
  if (onChainKeys.size > 0 && !failed) {
    console.log(`PASS  All ${onChainKeys.size} on-chain signer(s) are accounted for in ${SIGNERS_FILE}`);
  }

  // Layer 2: mapped usernames vs. actual CODEOWNERS team membership.
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log("\nGITHUB_TOKEN not set — skipping CODEOWNERS team membership check.");
  } else {
    try {
      const members = await fetchTeamMembers(mapping.codeownersTeam, token);
      for (const entry of mapping.signers) {
        if (!members.has(entry.githubUsername.toLowerCase())) {
          console.error(
            `FAIL  ${entry.githubUsername} holds mainnet signer key ${entry.publicKey} but is not a member of ${mapping.codeownersTeam}`
          );
          failed = true;
        }
      }
      if (!failed) {
        console.log(`PASS  All mapped signers are current members of ${mapping.codeownersTeam}`);
      }
    } catch (err: any) {
      console.error(`FAIL  Could not verify team membership: ${err.message}`);
      failed = true;
    }
  }

  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`FATAL  ${err.message}`);
    process.exit(1);
  }
);
