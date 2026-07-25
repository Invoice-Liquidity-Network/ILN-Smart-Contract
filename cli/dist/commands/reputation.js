"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeReputationCommand = makeReputationCommand;
const commander_1 = require("commander");
const sdk_1 = require("@iln/sdk");
const config_js_1 = require("../config.js");
/** Basic ANSI colors for terminal output. */
const colors = {
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    reset: "\x1b[0m",
    bold: "\x1b[1m",
};
function getColorForScore(score) {
    if (score >= 70)
        return colors.green;
    if (score >= 40)
        return colors.yellow;
    return colors.red;
}
function makeReputationCommand() {
    const cmd = new commander_1.Command("reputation").description("Check an address's ILN reputation score");
    cmd
        .option("-a, --address <address>", "Stellar address to check")
        .option("--json", "Output result as JSON")
        .action(async (opts) => {
        try {
            const config = (0, config_js_1.loadConfig)();
            const client = sdk_1.ILNClient.testnet(); // Default to testnet for CLI
            let address = opts.address;
            if (!address) {
                const profile = (0, config_js_1.resolveProfile)();
                if (!profile) {
                    console.error("Error: No connected wallet found. Run: iln wallet generate");
                    process.exit(1);
                }
                address = profile.publicKey;
            }
            const rep = await client.getReputation(address);
            if (opts.json) {
                console.log(JSON.stringify(rep, null, 2));
            }
            else {
                const scoreColor = getColorForScore(rep.score);
                console.log(`${colors.bold}Reputation Profile for ${address}${colors.reset}`);
                console.log(`--------------------------------------------------`);
                console.log(`Score:       ${scoreColor}${rep.score}${colors.reset}`);
                console.log(`Paid:        ${rep.invoicesPaid}`);
                console.log(`Defaulted:   ${rep.invoicesDefaulted}`);
                console.log(`Submitted:   ${rep.invoicesSubmitted}`);
                // Decay status not available in SDK, omitting or marking as N/A
                console.log(`Decay:       N/A`);
                console.log(`--------------------------------------------------`);
            }
        }
        catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
    });
    return cmd;
}
//# sourceMappingURL=reputation.js.map