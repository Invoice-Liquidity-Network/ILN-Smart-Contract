#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * ILN CLI entry point.
 *
 * Global flag:
 *   --profile <name>   Use a named keypair profile (issue #246)
 */
const commander_1 = require("commander");
const config_js_1 = require("./commands/config.js");
const export_js_1 = require("./commands/export.js");
const wallet_js_1 = require("./commands/wallet.js");
const submit_js_1 = require("./commands/submit.js");
const cancel_js_1 = require("./commands/cancel.js");
const marketplace_js_1 = require("./commands/marketplace.js");
const fund_js_1 = require("./commands/fund.js");
const status_js_1 = require("./commands/status.js");
const reputation_js_1 = require("./commands/reputation.js");
const completion_js_1 = require("./commands/completion.js");
const program = new commander_1.Command();
program
    .name("iln")
    .description("Invoice Liquidity Network CLI")
    .version("0.1.0")
    .option("--profile <name>", "Named keypair profile to use for this command");
program.addCommand((0, config_js_1.makeConfigCommand)());
program.addCommand((0, export_js_1.makeExportCommand)());
program.addCommand((0, wallet_js_1.makeWalletCommand)());
program.addCommand((0, submit_js_1.makeSubmitCommand)());
program.addCommand((0, cancel_js_1.makeCancelCommand)());
program.addCommand((0, marketplace_js_1.makeMarketplaceCommand)());
program.addCommand((0, fund_js_1.makeFundCommand)());
program.addCommand((0, status_js_1.makeStatusCommand)());
program.addCommand((0, reputation_js_1.makeReputationCommand)());
program.addCommand((0, completion_js_1.makeCompletionCommand)());
program.parse(process.argv);
//# sourceMappingURL=index.js.map