export interface SubmitOptions {
    payer?: string;
    amount?: string;
    token?: string;
    rate?: string;
    due?: string;
    referral?: string;
    dryRun?: boolean;
}
export interface SubmitResult {
    invoiceId: string;
    txHash: string;
    payer: string;
    amount: string;
    token: string;
    rateBps: number;
    yieldPct: string;
    dueDate: string;
    referral?: string;
}
//# sourceMappingURL=submit-types.d.ts.map