"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateKeypair = generateKeypair;
exports.makeWalletCommand = makeWalletCommand;
const commander_1 = require("commander");
const config_js_1 = require("../config.js");
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const promises_1 = __importDefault(require("readline/promises"));
/**
 * Helper to read input from the terminal (e.g., for PINs or secrets).
 */
async function ask(question, silent = false) {
    const rl = promises_1.default.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    if (silent) {
        process.stdout.write(question);
        const password = await new Promise((resolve) => {
            process.stdin.on("data", (data) => {
                resolve(data.toString().trim());
            });
        });
        process.stdout.write("\n");
        rl.close();
        return password;
    }
    const answer = await rl.question(question);
    rl.close();
    return answer;
}
/** Generate a Stellar keypair. */
function generateKeypair() {
    const kp = stellar_sdk_1.Keypair.random();
    return {
        publicKey: kp.publicKey(),
        secretKey: kp.secret(),
    };
}
function makeWalletCommand() {
    const cmd = new commander_1.Command("wallet").description("Manage Stellar keypairs and named profiles");
    // iln wallet generate [--profile name]
    cmd
        .command("generate")
        .description("Generate a new Stellar keypair and store it as a named profile")
        .option("--profile <name>", "Profile name to store the keypair under", "default")
        .option("--json", "Output result as JSON")
        .action(async (opts) => {
        const kp = generateKeypair();
        if (!opts.json) {
            console.log(`\x1b[33mWarning: Keep your secret key secure. Anyone with access to it can control your funds.\x1b[0m`);
            const pin = await ask("Set a PIN to encrypt your secret key: ", true);
            (0, config_js_1.saveProfile)({ name: opts.profile, publicKey: kp.publicKey, secretKey: kp.secretKey }, undefined, pin);
            console.log(`✓ Keypair generated and saved as profile "${opts.profile}"`);
            console.log(`  Public key : ${kp.publicKey}`);
        }
        else {
            (0, config_js_1.saveProfile)({ name: opts.profile, publicKey: kp.publicKey, secretKey: kp.secretKey });
            console.log(JSON.stringify({ profile: opts.profile, publicKey: kp.publicKey }));
        }
    });
    // iln wallet import --secret S...
    cmd
        .command("import")
        .description("Import an existing Stellar secret key")
        .requiredOption("--secret <secret>", "The Stellar secret key to import")
        .option("--profile <name>", "Profile name to store the keypair under", "default")
        .action(async (opts) => {
        try {
            const kp = stellar_sdk_1.Keypair.fromSecret(opts.secret);
            const pin = await ask("Set a PIN to encrypt your secret key: ", true);
            (0, config_js_1.saveProfile)({ name: opts.profile, publicKey: kp.publicKey(), secretKey: opts.secret }, undefined, pin);
            console.log(`✓ Secret key imported and saved as profile "${opts.profile}"`);
            console.log(`  Public key : ${kp.publicKey()}`);
        }
        catch (err) {
            console.error(`Error: Invalid secret key. ${err.message}`);
            process.exit(1);
        }
    });
    // iln wallet show
    cmd
        .command("show")
        .description("Display the current public key and balances")
        .action(async () => {
        const profile = (0, config_js_1.resolveProfile)();
        if (!profile) {
            console.error("Error: No active wallet profile found.");
            process.exit(1);
        }
        console.log(`\x1b[1mActive Wallet Profile: ${profile.name}\x1b[0m`);
        console.log(`Public Key: ${profile.publicKey}`);
        try {
            const server = new stellar_sdk_1.Horizon.Server("https://horizon-testnet.stellar.org");
            const account = await server.loadAccount(profile.publicKey);
            console.log(`\n\x1b[1mBalances:\x1b[0m`);
            const balances = account.balances;
            const targets = ["XLM", "USDC", "EURC"];
            targets.forEach(asset => {
                const bal = balances.find((b) => b.asset_type === "native" ? "XLM" === asset : b.asset_code === asset);
                if (bal) {
                    console.log(`${asset.padEnd(5)}: ${bal.balance}`);
                }
                else {
                    console.log(`${asset.padEnd(5)}: 0`);
                }
            });
        }
        catch (err) {
            console.log(`\nCould not fetch balances: ${err.message}`);
        }
    });
    // iln wallet fund
    cmd
        .command("fund")
        .description("Request testnet XLM via Friendbot")
        .action(async () => {
        const profile = (0, config_js_1.resolveProfile)();
        if (!profile) {
            console.error("Error: No active wallet profile found.");
            process.exit(1);
        }
        console.log(`Requesting testnet XLM for ${profile.publicKey}...`);
        try {
            const res = await fetch("https://friendbot.stellar.org", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ address: profile.publicKey }),
            });
            if (res.ok) {
                console.log(`✓ Successfully requested XLM from Friendbot.`);
            }
            else {
                console.error(`Error: Friendbot request failed with status ${res.status}`);
            }
        }
        catch (err) {
            console.error(`Error: ${err.message}`);
        }
    });
    // iln wallet list
    cmd
        .command("list")
        .description("List all saved profiles with their public keys")
        .option("--json", "Output as JSON")
        .action((opts) => {
        const profiles = (0, config_js_1.listProfiles)();
        if (opts.json) {
            console.log(JSON.stringify(profiles.map((p) => ({ name: p.name, publicKey: p.publicKey })), null, 2));
        }
        else if (profiles.length === 0) {
            console.log("No profiles found. Run: iln wallet generate");
        }
        else {
            for (const p of profiles) {
                console.log(`${p.name.padEnd(20)} ${p.publicKey}`);
            }
        }
    });
    return cmd;
}
//# sourceMappingURL=wallet.js.map