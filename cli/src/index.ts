#!/usr/bin/env node
/**
 * ILN CLI entry point.
 *
 * Global flags:
 *   --profile <name>   Use a named keypair profile (issue #246)
 *   --json             Output machine-readable JSON for all commands
 */
import { Command } from "commander";
import { makeConfigCommand } from "./commands/config.js";
import { makeExportCommand } from "./commands/export.js";
import { makeWalletCommand } from "./commands/wallet.js";
import { makeSubmitCommand } from "./commands/submit.js";
import { makeCancelCommand } from "./commands/cancel.js";
import { makeDisputeCommand } from "./commands/dispute.js";
import { makeMarketplaceCommand } from "./commands/marketplace.js";
import { makeFundCommand } from "./commands/fund.js";
import { makeStatusCommand } from "./commands/status.js";
import { makeReputationCommand } from "./commands/reputation.js";
import { makeCompletionCommand } from "./commands/completion.js";
import { makePauseCommand, makeUnpauseCommand } from "./commands/pause.js";

const program = new Command();

program
  .name("iln")
  .description("Invoice Liquidity Network CLI")
  .version("0.1.0")
  .option("--profile <name>", "Named keypair profile to use for this command")
  .option("--json", "Output machine-readable JSON");

program.addCommand(makeConfigCommand());
program.addCommand(makeExportCommand());
program.addCommand(makeWalletCommand());
program.addCommand(makeSubmitCommand());
program.addCommand(makeCancelCommand());
program.addCommand(makeDisputeCommand());
program.addCommand(makeMarketplaceCommand());
program.addCommand(makeFundCommand());
program.addCommand(makeStatusCommand());
program.addCommand(makeReputationCommand());
program.addCommand(makeCompletionCommand());
program.addCommand(makePauseCommand());
program.addCommand(makeUnpauseCommand());

program.parse(process.argv);
