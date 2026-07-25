/**
 * Options for the fundInvoice() SDK method.
 */
export interface FundOptions {
    /**
     * When true, the SDK will reject funding if the oracle price feed is stale
     * or unavailable. Defaults to false.
     */
    requireOracleVerification?: boolean;
    /**
     * Called when the LP's current token allowance is less than the invoice
     * amount and an approval transaction is about to be built.
     *
     * @param params.requiredAmount  - Amount that needs to be approved (in token base units)
     * @param params.currentAllowance - Current allowance the contract holds
     */
    onApprovalRequired?: (params: {
        requiredAmount: bigint;
        currentAllowance: bigint;
    }) => void;
    /**
     * Called immediately after the approval transaction has been submitted to
     * the network (before confirmation).
     *
     * @param params.approveTxHash - Hash of the submitted approval transaction
     */
    onApprovalSent?: (params: {
        approveTxHash: string;
    }) => void;
    /**
     * Called after the fund_invoice contract call has been simulated and the
     * transaction is ready to sign and submit.
     *
     * @param params.effectiveYieldBps - Annualised yield in basis points derived
     *   from the invoice's discount rate and time-to-due-date
     * @param params.invoiceId         - The invoice being funded
     */
    onFunded?: (params: {
        effectiveYieldBps: number;
        invoiceId: bigint;
    }) => void;
}
/**
 * Return value of a successful fundInvoice() call.
 */
export interface FundResult {
    /** Hash of the fund_invoice transaction. */
    txHash: string;
    /**
     * Annualised effective yield in basis points for this funding position.
     * Derived from discountRate × daysToMaturity / 365.
     */
    effectiveYieldBps: number;
}
/**
 * Minimal view of an invoice returned by get_invoice().
 */
export interface InvoiceView {
    id: bigint;
    /** Token contract address used for this invoice. */
    token: string;
    /** Full invoice amount in token base units. */
    amount: bigint;
    /** Unix timestamp (seconds) when payment is due. */
    dueDate: number;
    /** Discount rate in basis points (e.g. 300 = 3.00 %). */
    discountRate: number;
    /** Current lifecycle status string. */
    status: string;
}
/** Allowance query parameters. */
export interface AllowanceParams {
    /** Token contract address (SEP-41 / SAC). */
    tokenAddress: string;
    /** Address of the token owner (the LP). */
    owner: string;
    /** Address that will spend the tokens (the invoice-liquidity contract). */
    spender: string;
}
/** Result of an allowance check. */
export interface AllowanceResult {
    /** Current approved amount in token base units. */
    amount: bigint;
    /** Ledger sequence at which the allowance expires (0 = no expiry stored). */
    expirationLedger: number;
}
//# sourceMappingURL=types.d.ts.map