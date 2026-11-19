/**
 * Type definitions for the dispute command.
 */
export interface DisputeOptions {
  invoiceId: string;
  reasonHash: string;
  payer?: string;
}

export interface InvoiceSummary {
  id: string;
  status: string;
  amount: string;
  token: string;
  dueDate: string;
}

export interface DisputeResult {
  invoiceId: string;
  txHash: string;
  disputedAt: string;
}
