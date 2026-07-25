export interface MarketplaceListing {
    id: string;
    amount: string;
    token: string;
    yieldPct: string;
    dueDate: string;
    payerReputation: "low" | "medium" | "high";
}
export interface MarketplaceOptions {
    sort?: "yield" | "amount" | "due";
    filter?: string;
}
export interface FundOptions {
    id: string;
    yes?: boolean;
}
export interface FundResult {
    invoiceId: string;
    txHash: string;
}
//# sourceMappingURL=marketplace-types.d.ts.map