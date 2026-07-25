/**
 * `iln submit` — submit an invoice to the ILN network.
 *
 * Modes:
 *   Flag-based:   iln submit --payer G... --amount 100 --token USDC --rate 300 --due 2025-12-31
 *   Interactive:  iln submit  (launches @inquirer/prompts wizard)
 *   Dry-run:      any mode + --dry-run  (prints TX without signing)
 *
 * Issue: #229
 */
import { Command } from "commander";
import type { SubmitOptions, SubmitResult } from "./submit-types.js";
export type Prompter = () => Promise<Required<Omit<SubmitOptions, "dryRun">>>;
export type Submitter = (opts: Required<Omit<SubmitOptions, "dryRun">>) => Promise<SubmitResult>;
export declare function runInteractivePrompts(): Promise<Required<Omit<SubmitOptions, "dryRun">>>;
export declare function makeSubmitCommand(prompter?: Prompter, submitter?: Submitter): Command;
//# sourceMappingURL=submit.d.ts.map