"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validatePendingState = validatePendingState;
exports.formatConfirmMessage = formatConfirmMessage;
function validatePendingState(invoice) {
    if (invoice.state !== "Pending") {
        throw new Error(`Invoice #${invoice.id} is in state "${invoice.state}" — only Pending invoices can be cancelled.`);
    }
}
function formatConfirmMessage(invoice) {
    return `Cancel Invoice #${invoice.id} (${invoice.amount} ${invoice.token}, due ${invoice.dueDate})? This cannot be undone. [y/N]`;
}
//# sourceMappingURL=cancel-helpers.js.map