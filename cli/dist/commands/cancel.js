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
exports.makeCancelCommand = makeCancelCommand;
/**
 * `iln cancel --id X` — cancel a Pending invoice.
 *
 * Fetches the invoice first and validates it is Pending.
 * Shows a confirmation prompt before submitting the cancel TX.
 *
 * Issue: #233
 */
const readline = __importStar(require("readline"));
const commander_1 = require("commander");
const cancel_helpers_js_1 = require("./cancel-helpers.js");
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
    return { id, state: "Pending", amount: "100", token: "USDC", dueDate: "2025-12-31" };
}
async function defaultCancelExecutor(id) {
    return { invoiceId: id, txHash: `TX${Math.random().toString(36).slice(2).toUpperCase()}` };
}
function makeCancelCommand(fetchInvoice = defaultFetcher, cancelExecutor = defaultCancelExecutor, confirm = promptConfirm) {
    const cmd = new commander_1.Command("cancel").description("Cancel a pending invoice");
    cmd
        .requiredOption("--id <invoice-id>", "Invoice ID to cancel")
        .option("--yes", "Skip confirmation prompt")
        .action(async (opts) => {
        try {
            const invoice = await fetchInvoice(opts.id);
            (0, cancel_helpers_js_1.validatePendingState)(invoice);
            if (!opts.yes) {
                const confirmed = await confirm((0, cancel_helpers_js_1.formatConfirmMessage)(invoice));
                if (!confirmed) {
                    console.log("Cancelled — no changes made.");
                    return;
                }
            }
            const result = await cancelExecutor(opts.id);
            console.log(`Invoice #${result.invoiceId} cancelled. TX: ${result.txHash}`);
        }
        catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
    });
    return cmd;
}
//# sourceMappingURL=cancel.js.map