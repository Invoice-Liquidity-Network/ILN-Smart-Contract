export type InvoiceState = "Pending" | "Funded" | "Paid" | "Cancelled" | "Expired" | "Disputed";
export interface InvoiceDetail {
    id: string;
    state: InvoiceState;
    submitter: string;
    payer: string;
    lp?: string;
    token: string;
    amount: string;
    discountRateBps: number;
    effectiveYieldPct: string;
    dueDate: string;
    createdAt: string;
}
export declare const TERMINAL_STATES: InvoiceState[];
//# sourceMappingURL=status-types.d.ts.map