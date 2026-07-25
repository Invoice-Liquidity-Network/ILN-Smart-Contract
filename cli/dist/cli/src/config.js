"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULTS = void 0;
exports.getIlnDir = getIlnDir;
exports.loadConfig = loadConfig;
exports.saveConfig = saveConfig;
exports.resetConfig = resetConfig;
exports.getConfigValue = getConfigValue;
exports.setConfigValue = setConfigValue;
exports.profilePath = profilePath;
exports.saveProfile = saveProfile;
exports.loadProfile = loadProfile;
exports.listProfiles = listProfiles;
exports.resolveProfile = resolveProfile;
/**
 * ILN CLI configuration manager.
 *
 * Config file:   ~/.iln/config.json
 * Profile files: ~/.iln/profiles/<name>.json
 *
 * Issues: #245 (iln config command), #246 (--profile flag)
 */
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const crypto_js_1 = require("./crypto.js");
exports.DEFAULTS = {
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
};
/** Resolve the ILN home directory (injectable for tests). */
function getIlnDir(baseDir) {
    return path_1.default.join(baseDir ?? os_1.default.homedir(), ".iln");
}
function configFile(baseDir) {
    return path_1.default.join(getIlnDir(baseDir), "config.json");
}
function profilesDir(baseDir) {
    return path_1.default.join(getIlnDir(baseDir), "profiles");
}
function ensureDirs(baseDir) {
    const iln = getIlnDir(baseDir);
    if (!fs_1.default.existsSync(iln))
        fs_1.default.mkdirSync(iln, { recursive: true });
    const prof = profilesDir(baseDir);
    if (!fs_1.default.existsSync(prof))
        fs_1.default.mkdirSync(prof, { recursive: true });
}
function loadConfig(baseDir) {
    ensureDirs(baseDir);
    const file = configFile(baseDir);
    if (!fs_1.default.existsSync(file))
        return { ...exports.DEFAULTS };
    try {
        return { ...exports.DEFAULTS, ...JSON.parse(fs_1.default.readFileSync(file, "utf-8")) };
    }
    catch {
        return { ...exports.DEFAULTS };
    }
}
function saveConfig(config, baseDir) {
    ensureDirs(baseDir);
    fs_1.default.writeFileSync(configFile(baseDir), JSON.stringify(config, null, 2), "utf-8");
}
function resetConfig(baseDir) {
    saveConfig({ ...exports.DEFAULTS }, baseDir);
}
function getConfigValue(key, baseDir) {
    const cfg = loadConfig(baseDir);
    const val = cfg[key];
    return val !== undefined ? String(val) : undefined;
}
function setConfigValue(key, value, baseDir) {
    const allowedKeys = ["network", "rpcUrl", "defaultProfile"];
    if (!allowedKeys.includes(key)) {
        throw new Error(`Unknown config key: ${key}. Allowed: ${allowedKeys.join(", ")}`);
    }
    if (key === "network" && value !== "testnet" && value !== "mainnet") {
        throw new Error('network must be "testnet" or "mainnet"');
    }
    const cfg = loadConfig(baseDir);
    cfg[key] = value;
    saveConfig(cfg, baseDir);
}
// ── Profile helpers (#246) ────────────────────────────────────────────────────
function profilePath(name, baseDir) {
    ensureDirs(baseDir);
    return path_1.default.join(profilesDir(baseDir), `${name}.json`);
}
function saveProfile(profile, baseDir, pin) {
    ensureDirs(baseDir);
    const data = { ...profile };
    if (data.secretKey && pin) {
        data.secretKey = (0, crypto_js_1.encrypt)(data.secretKey, pin);
    }
    fs_1.default.writeFileSync(profilePath(profile.name, baseDir), JSON.stringify(data, null, 2), "utf-8");
}
function loadProfile(name, baseDir, pin) {
    const file = profilePath(name, baseDir);
    if (!fs_1.default.existsSync(file)) {
        throw new Error(`Profile "${name}" not found. Run: iln wallet generate --profile ${name}`);
    }
    const data = JSON.parse(fs_1.default.readFileSync(file, "utf-8"));
    if (data.secretKey && pin) {
        try {
            data.secretKey = (0, crypto_js_1.decrypt)(data.secretKey, pin);
        }
        catch {
            throw new Error(`Invalid PIN for profile "${name}"`);
        }
    }
    return data;
}
function listProfiles(baseDir) {
    const dir = profilesDir(baseDir);
    ensureDirs(baseDir);
    if (!fs_1.default.existsSync(dir))
        return [];
    return fs_1.default
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
        try {
            return JSON.parse(fs_1.default.readFileSync(path_1.default.join(dir, f), "utf-8"));
        }
        catch {
            return null;
        }
    })
        .filter((p) => p !== null);
}
function resolveProfile(profileFlag, baseDir, pin) {
    const name = profileFlag ?? loadConfig(baseDir).defaultProfile ?? "default";
    try {
        return loadProfile(name, baseDir, pin);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=config.js.map