"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildReceiptRows = buildReceiptRows;
exports.printReceiptTable = printReceiptTable;
exports.bpsToYieldPct = bpsToYieldPct;
function buildReceiptRows(result) {
    const rows = [
        ["Invoice ID", result.invoiceId],
        ["TX Hash", result.txHash],
        ["Payer", result.payer],
        ["Amount", `${result.amount} ${result.token}`],
        ["Discount Rate", `${result.rateBps} bps (${result.yieldPct}%)`],
        ["Due Date", result.dueDate],
    ];
    if (result.referral)
        rows.push(["Referral", result.referral]);
    return rows;
}
function printReceiptTable(result) {
    const rows = buildReceiptRows(result);
    const labelWidth = Math.max(...rows.map(([l]) => l.length)) + 2;
    console.log("\n┌" + "─".repeat(labelWidth + 32) + "┐");
    for (const [label, value] of rows) {
        console.log(`│ ${label.padEnd(labelWidth)} ${value}`);
    }
    console.log("└" + "─".repeat(labelWidth + 32) + "┘");
}
function bpsToYieldPct(rateBps) {
    return (rateBps / 100).toFixed(2);
}
//# sourceMappingURL=submit-receipt.js.map