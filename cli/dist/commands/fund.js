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
exports.makeFundCommand = makeFundCommand;
/**
 * `iln fund --id X` — fund a Pending invoice as a liquidity provider.
 *
 * Shows a confirmation prompt with invoice details and yield before signing.
 * Use --yes to skip confirmation for scripting.
 *
 * Issue: #230
 */
const readline = __importStar(require("readline"));
const commander_1 = require("commander");
async function promptConfirm(message) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(`${message} `, (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase() === "y");
        });
    });
}
async function defaultFetcher(id) {
    return { id, amount: "100", token: "USDC", yieldPct: "3.20", dueDate: "2025-12-31", payerReputation: "medium" };
}
async function defaultExecutor(id) {
    return { invoiceId: id, txHash: `TX${Math.random().toString(36).slice(2).toUpperCase()}` };
}
function makeFundCommand(fetchInvoice = defaultFetcher, executeFund = defaultExecutor, confirm = promptConfirm) {
    const cmd = new commander_1.Command("fund").description("Fund a pending invoice as a liquidity provider");
    cmd
        .requiredOption("--id <invoice-id>", "Invoice ID to fund")
        .option("--yes", "Skip confirmation prompt")
        .action(async (opts) => {
        try {
            const invoice = await fetchInvoice(opts.id);
            if (!opts.yes) {
                const msg = `Fund invoice #${invoice.id} (${invoice.amount} ${invoice.token}, ${invoice.yieldPct}% yield)? [y/N]`;
                const confirmed = await confirm(msg);
                if (!confirmed) {
                    console.log("Aborted — invoice not funded.");
                    return;
                }
            }
            const result = await executeFund(opts.id);
            console.log(`Funded invoice #${result.invoiceId}. TX: ${result.txHash}`);
        }
        catch (err) {
            console.error(`Fund error: ${err.message}`);
            process.exit(1);
        }
    });
    return cmd;
}
//# sourceMappingURL=fund.js.map