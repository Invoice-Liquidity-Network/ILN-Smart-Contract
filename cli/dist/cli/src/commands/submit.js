"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runInteractivePrompts = runInteractivePrompts;
exports.makeSubmitCommand = makeSubmitCommand;
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
const commander_1 = require("commander");
const submit_receipt_js_1 = require("./submit-receipt.js");
const TOKENS = ["USDC", "EURC", "XLM"];
function validateStellarAddress(addr) {
    return /^G[A-Z2-7]{55}$/.test(addr);
}
async function runInteractivePrompts() {
    const { input, select, confirm } = await Promise.resolve().then(() => __importStar(require("@inquirer/prompts")));
    const payer = await input({
        message: "Payer Stellar address:",
        validate: (v) => validateStellarAddress(v) || "Must be a valid Stellar G-address (56 chars)",
    });
    const amountStr = await input({
        message: "Invoice amount:",
        validate: (v) => (!isNaN(Number(v)) && Number(v) > 0) || "Must be a positive number",
    });
    const token = await select({
        message: "Token:",
        choices: TOKENS.map((t) => ({ value: t, name: t })),
    });
    const rateStr = await input({
        message: "Discount rate in basis points (e.g. 300 = 3.00%):",
        validate: (v) => {
            const n = Number(v);
            return (!isNaN(n) && n >= 0 && n <= 10000) || "Must be 0–10000";
        },
    });
    console.log(`  → Effective yield: ${(0, submit_receipt_js_1.bpsToYieldPct)(Number(rateStr))}%`);
    const due = await input({
        message: "Due date (YYYY-MM-DD):",
        validate: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) || "Use YYYY-MM-DD format",
    });
    const referral = await input({ message: "Referral code (optional, press Enter to skip):" });
    return { payer, amount: amountStr, token, rate: rateStr, due, referral };
}
async function defaultSubmitter(opts) {
    const invoiceId = `INV-${Date.now()}`;
    const txHash = `TX${Math.random().toString(36).slice(2).toUpperCase()}`;
    return {
        invoiceId,
        txHash,
        payer: opts.payer,
        amount: opts.amount,
        token: opts.token,
        rateBps: Number(opts.rate),
        yieldPct: (0, submit_receipt_js_1.bpsToYieldPct)(Number(opts.rate)),
        dueDate: opts.due,
        referral: opts.referral || undefined,
    };
}
function makeSubmitCommand(prompter = runInteractivePrompts, submitter = defaultSubmitter) {
    const cmd = new commander_1.Command("submit").description("Submit an invoice to the ILN network");
    cmd
        .option("--payer <address>", "Payer Stellar G-address")
        .option("--amount <number>", "Invoice amount")
        .option("--token <USDC|EURC|XLM>", "Token", "USDC")
        .option("--rate <bps>", "Discount rate in basis points")
        .option("--due <YYYY-MM-DD>", "Due date")
        .option("--referral <code>", "Optional referral code")
        .option("--dry-run", "Build and print transaction without signing")
        .action(async (opts) => {
        try {
            const isInteractive = !opts.payer && !opts.amount && !opts.rate && !opts.due;
            const params = isInteractive
                ? await prompter()
                : {
                    payer: opts.payer ?? "",
                    amount: opts.amount ?? "",
                    token: opts.token ?? "USDC",
                    rate: opts.rate ?? "0",
                    due: opts.due ?? "",
                    referral: opts.referral ?? "",
                };
            if (!params.payer || !validateStellarAddress(params.payer)) {
                console.error("Error: invalid payer address");
                process.exit(1);
            }
            if (opts.dryRun) {
                console.log("\n[dry-run] Transaction payload (not signed):");
                console.log(JSON.stringify({ ...params, rateBps: Number(params.rate) }, null, 2));
                return;
            }
            const result = await submitter(params);
            console.log(`\n✓ Invoice #${result.invoiceId} submitted. TX: ${result.txHash}`);
            (0, submit_receipt_js_1.printReceiptTable)(result);
        }
        catch (err) {
            console.error(`Submit failed: ${err.message}`);
            process.exit(1);
        }
    });
    return cmd;
}
//# sourceMappingURL=submit.js.map