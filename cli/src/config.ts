/**
 * ILN CLI configuration manager.
 *
 * Config file:   ~/.iln/config.json
 * Profile files: ~/.iln/profiles/<name>.json
 *
 * Issues: #245 (iln config command), #246 (--profile flag)
 */
import fs from "fs";
import os from "os";
import path from "path";
import { encrypt, decrypt } from "./crypto.js";

export interface ILNConfig {
  network: "testnet" | "mainnet";
  rpcUrl: string;
  defaultProfile?: string;
  pin?: string; // Encrypted or hashed PIN? No, usually we use PIN to derive key.
}

export interface ProfileData {
  name: string;
  publicKey: string;
  secretKey?: string;
}

export const DEFAULTS: ILNConfig = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
};

/** Resolve the ILN home directory (injectable for tests). */
export function getIlnDir(baseDir?: string): string {
  return path.join(baseDir ?? os.homedir(), ".iln");
}

function configFile(baseDir?: string): string {
  return path.join(getIlnDir(baseDir), "config.json");
}

function profilesDir(baseDir?: string): string {
  return path.join(getIlnDir(baseDir), "profiles");
}

function ensureDirs(baseDir?: string): void {
  const iln = getIlnDir(baseDir);
  if (!fs.existsSync(iln)) fs.mkdirSync(iln, { recursive: true });
  const prof = profilesDir(baseDir);
  if (!fs.existsSync(prof)) fs.mkdirSync(prof, { recursive: true });
}

export function loadConfig(baseDir?: string): ILNConfig {
  ensureDirs(baseDir);
  const file = configFile(baseDir);
  if (!fs.existsSync(file)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, "utf-8")) } as ILNConfig;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config: ILNConfig, baseDir?: string): void {
  ensureDirs(baseDir);
  fs.writeFileSync(configFile(baseDir), JSON.stringify(config, null, 2), "utf-8");
}

export function resetConfig(baseDir?: string): void {
  saveConfig({ ...DEFAULTS }, baseDir);
}

export function getConfigValue(key: keyof ILNConfig, baseDir?: string): string | undefined {
  const cfg = loadConfig(baseDir);
  const val = cfg[key];
  return val !== undefined ? String(val) : undefined;
}

export function setConfigValue(key: string, value: string, baseDir?: string): void {
  const allowedKeys: (keyof ILNConfig)[] = ["network", "rpcUrl", "defaultProfile"];
  if (!allowedKeys.includes(key as keyof ILNConfig)) {
    throw new Error(`Unknown config key: ${key}. Allowed: ${allowedKeys.join(", ")}`);
  }
  if (key === "network" && value !== "testnet" && value !== "mainnet") {
    throw new Error('network must be "testnet" or "mainnet"');
  }
  const cfg = loadConfig(baseDir);
  (cfg as unknown as Record<string, unknown>)[key] = value;
  saveConfig(cfg, baseDir);
}

// ── Profile helpers (#246) ────────────────────────────────────────────────────

export function profilePath(name: string, baseDir?: string): string {
  ensureDirs(baseDir);
  return path.join(profilesDir(baseDir), `${name}.json`);
}

export function saveProfile(profile: ProfileData, baseDir?: string, pin?: string): void {
  ensureDirs(baseDir);
  const data = { ...profile };
  if (data.secretKey && pin) {
    data.secretKey = encrypt(data.secretKey, pin);
  }
  fs.writeFileSync(profilePath(profile.name, baseDir), JSON.stringify(data, null, 2), "utf-8");
}

export function loadProfile(name: string, baseDir?: string, pin?: string): ProfileData {
  const file = profilePath(name, baseDir);
  if (!fs.existsSync(file)) {
    throw new Error(`Profile "${name}" not found. Run: iln wallet generate --profile ${name}`);
  }
  const data = JSON.parse(fs.readFileSync(file, "utf-8")) as ProfileData;
  if (data.secretKey && pin) {
    try {
      data.secretKey = decrypt(data.secretKey, pin);
    } catch {
      throw new Error(`Invalid PIN for profile "${name}"`);
    }
  }
  return data;
}

export function listProfiles(baseDir?: string): ProfileData[] {
  const dir = profilesDir(baseDir);
  ensureDirs(baseDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as ProfileData;
      } catch {
        return null;
      }
    })
    .filter((p): p is ProfileData => p !== null);
}

export function resolveProfile(profileFlag?: string, baseDir?: string, pin?: string): ProfileData | null {
  const name = profileFlag ?? loadConfig(baseDir).defaultProfile ?? "default";
  try {
    return loadProfile(name, baseDir, pin);
  } catch {
    return null;
  }
}
