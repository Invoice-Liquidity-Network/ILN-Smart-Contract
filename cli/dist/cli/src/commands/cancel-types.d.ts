export type InvoiceState = "Pending" | "Funded" | "Paid" | "Cancelled" | "Expired" | "Disputed";
export interface InvoiceSummary {
    id: string;
    state: InvoiceState;
    amount: string;
    token: string;
    dueDate: string;
}
export interface CancelOptions {
    id: string;
    yes?: boolean;
}
export interface CancelResult {
    invoiceId: string;
    txHash: string;
}
//# sourceMappingURL=cancel-types.d.ts.map