/**
 * Types for the `iln pay` command.
 * Issue: #232
 */

/** Input options resolved from CLI flags. */
export interface PayOptions {
  /** Invoice ID to pay. */
  id: string;
  /** Amount to pay in USDC. Omit for full payment. */
  amount?: number;
  /** Skip confirmation prompt and pay immediately. */
  yes: boolean;
}

/** Invoice state fetched before payment. */
export interface InvoicePayState {
  id: string;
  totalAmount: number;
  remainingAmount: number;
  token: string;
  payer: string;
  lp?: string;
}

/** Result returned after a successful payment. */
export interface PayResult {
  invoiceId: string;
  txHash: string;
  paidAmount: number;
  remainingAmount: number;
  token: string;
  lpEarnings?: number;
  isFullyPaid: boolean;
}
