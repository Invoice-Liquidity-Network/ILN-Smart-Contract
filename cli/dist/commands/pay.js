"use strict";
/**
 * `iln pay` command — pay an invoice in full or partially.
 *
 * Usage:
 *   iln pay --id X              → full payment
 *   iln pay --id X --amount 50  → partial payment of 50 USDC
 *   iln pay --id X --yes        → skip confirmation prompt
 *
 * Issue: #232
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.printPaymentPreview = printPaymentPreview;
exports.printSettlementReceipt = printSettlementReceipt;
exports.printPartialProgress = printPartialProgress;
exports.makePayCommand = makePayCommand;
const commander_1 = require("commander");
// ── Preview printer ───────────────────────────────────────────────────────────
/**
 * Prints the payment preview line shown before signing.
 * "Paying 50 USDC of 100 USDC remaining on Invoice #X (Payer earns LP: Y USDC)"
 */
function printPaymentPreview(invoice, payAmount) {
    const lpNote = invoice.lp
        ? ` (Payer earns LP: ${lpEarningsEstimate(payAmount)} ${invoice.token})`
        : "";
    console.log(`\nPaying ${payAmount} ${invoice.token} of ${invoice.remainingAmount} ` +
        `${invoice.token} remaining on Invoice #${invoice.id}${lpNote}`);
}
/** Receipt printer for full payment. */
function printSettlementReceipt(result) {
    console.log("\n── Settlement Receipt ──────────────────────────────");
    console.log(`  Invoice:   ${result.invoiceId}`);
    console.log(`  Paid:      ${result.paidAmount} ${result.token}`);
    console.log(`  Remaining: ${result.remainingAmount} ${result.token}`);
    if (result.lpEarnings !== undefined) {
        console.log(`  LP earned: ${result.lpEarnings} ${result.token}`);
    }
    console.log(`  Tx hash:   ${result.txHash}`);
    console.log(`  Status:    ${result.isFullyPaid ? "FULLY PAID ✓" : "PARTIAL — invoice still open"}`);
    console.log("────────────────────────────────────────────────────\n");
}
/** Partial payment progress line. */
function printPartialProgress(result) {
    console.log(`Paid ${result.paidAmount} ${result.token}. ` +
        `${result.remainingAmount} ${result.token} remaining.`);
}
// ── LP earnings estimate (simple placeholder — replace with contract formula) ─
function lpEarningsEstimate(amount) {
    // 0.5% of paid amount as LP reward estimate; replace with real formula
    return Math.round(amount * 0.005 * 100) / 100;
}
// ── Command factory ───────────────────────────────────────────────────────────
/**
 * Factory function following the project's injected-deps pattern.
 * Keeps the command pure and fully testable without real network calls.
 */
function makePayCommand(prompter, fetcher, executor) {
    const cmd = new commander_1.Command("pay");
    cmd
        .description("Pay an invoice in full or partially")
        .requiredOption("--id <invoiceId>", "Invoice ID to pay")
        .option("--amount <usdc>", "Amount to pay (omit for full payment)", parseFloat)
        .option("--yes", "Skip confirmation prompt", false)
        .action(async (opts) => {
        const options = {
            id: opts.id,
            amount: opts.amount,
            yes: opts.yes,
        };
        // ── 1. Fetch invoice state ──────────────────────────────────────────
        let invoice;
        try {
            invoice = await fetcher(options.id);
        }
        catch (err) {
            console.error(`Error fetching invoice ${options.id}: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
        // ── 2. Resolve pay amount ───────────────────────────────────────────
        const payAmount = options.amount !== undefined
            ? options.amount
            : invoice.remainingAmount; // full payment
        if (payAmount <= 0) {
            console.error("Payment amount must be greater than 0.");
            process.exit(1);
        }
        if (payAmount > invoice.remainingAmount) {
            console.error(`Amount ${payAmount} exceeds remaining balance of ${invoice.remainingAmount} ${invoice.token}.`);
            process.exit(1);
        }
        // ── 3. Payment preview ──────────────────────────────────────────────
        printPaymentPreview(invoice, payAmount);
        // ── 4. Confirmation ─────────────────────────────────────────────────
        if (!options.yes) {
            const confirmed = await prompter(`Confirm payment of ${payAmount} ${invoice.token}? [y/N] `);
            if (!confirmed) {
                console.log("Payment cancelled.");
                return;
            }
        }
        // ── 5. Execute payment ──────────────────────────────────────────────
        let result;
        try {
            result = await executor(options.id, payAmount);
        }
        catch (err) {
            console.error(`Payment failed: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
        // ── 6. Output ───────────────────────────────────────────────────────
        if (result.isFullyPaid) {
            printSettlementReceipt(result);
        }
        else {
            printPartialProgress(result);
        }
    });
    return cmd;
}
//# sourceMappingURL=pay.js.map