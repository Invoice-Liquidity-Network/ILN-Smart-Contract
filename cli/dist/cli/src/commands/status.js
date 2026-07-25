"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeStatusCommand = makeStatusCommand;
/**
 * `iln status --id X` — display a rich, human-readable invoice summary.
 *
 * Flags:
 *   --json    Output raw JSON for piping
 *   --watch   Refresh every 10 seconds until a terminal state is reached
 *
 * Issue: #231
 */
const commander_1 = require("commander");
const status_types_js_1 = require("./status-types.js");
const status_formatter_js_1 = require("./status-formatter.js");
const status_timeline_js_1 = require("./status-timeline.js");
async function defaultFetcher(id) {
    return {
        id,
        state: "Pending",
        submitter: "GSUBMITTER000000000000000000000000000000000000000000000",
        payer: "GPAYER000000000000000000000000000000000000000000000000000",
        token: "USDC",
        amount: "100",
        discountRateBps: 300,
        effectiveYieldPct: "3.00",
        dueDate: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
        createdAt: new Date().toISOString(),
    };
}
function makeStatusCommand(fetchInvoice = defaultFetcher, setIntervalFn = setInterval, clearIntervalFn = clearInterval) {
    const cmd = new commander_1.Command("status").description("Display a rich summary of an invoice");
    cmd
        .requiredOption("--id <invoice-id>", "Invoice ID")
        .option("--json", "Output raw JSON")
        .option("--watch", "Refresh every 10 seconds until terminal state")
        .action(async (opts) => {
        async function printStatus() {
            try {
                const inv = await fetchInvoice(opts.id);
                if (opts.json) {
                    console.log(JSON.stringify(inv, null, 2));
                }
                else {
                    console.log((0, status_formatter_js_1.formatDetail)(inv));
                    console.log((0, status_timeline_js_1.buildTimeline)(inv.state));
                }
                return status_types_js_1.TERMINAL_STATES.includes(inv.state);
            }
            catch (err) {
                console.error(`Status error: ${err.message}`);
                process.exit(1);
                return true;
            }
        }
        const done = await printStatus();
        if (!opts.watch || done)
            return;
        const timer = setIntervalFn(async () => {
            const finished = await printStatus();
            if (finished)
                clearIntervalFn(timer);
        }, 10_000);
    });
    return cmd;
}
//# sourceMappingURL=status.js.map