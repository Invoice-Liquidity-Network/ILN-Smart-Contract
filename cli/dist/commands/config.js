"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeConfigCommand = makeConfigCommand;
/**
 * `iln config` — manage CLI settings.
 *
 * Sub-commands:
 *   iln config set <key> <value>
 *   iln config get <key>
 *   iln config list
 *   iln config reset
 *
 * Issue: #245
 */
const commander_1 = require("commander");
const config_js_1 = require("../config.js");
function makeConfigCommand() {
    const cmd = new commander_1.Command("config").description("Manage ILN CLI configuration stored in ~/.iln/config.json");
    // iln config set <key> <value>
    cmd
        .command("set <key> <value>")
        .description("Set a config value (keys: network, rpcUrl, defaultProfile)")
        .action((key, value) => {
        try {
            (0, config_js_1.setConfigValue)(key, value);
            console.log(`✓ Set ${key} = ${value}`);
        }
        catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
    });
    // iln config get <key>
    cmd
        .command("get <key>")
        .description("Get a single config value")
        .action((key) => {
        const val = (0, config_js_1.getConfigValue)(key);
        if (val === undefined) {
            console.error(`Key "${key}" not found in config.`);
            process.exit(1);
        }
        console.log(val);
    });
    // iln config list
    cmd
        .command("list")
        .description("Show all current config values")
        .option("--json", "Output as JSON")
        .action((opts) => {
        const cfg = (0, config_js_1.loadConfig)();
        if (opts.json) {
            console.log(JSON.stringify(cfg, null, 2));
        }
        else {
            for (const [k, v] of Object.entries(cfg)) {
                console.log(`${k}: ${v}`);
            }
        }
    });
    // iln config reset
    cmd
        .command("reset")
        .description("Restore all config values to defaults")
        .action(() => {
        (0, config_js_1.resetConfig)();
        console.log("✓ Config reset to defaults.");
    });
    return cmd;
}
//# sourceMappingURL=config.js.map