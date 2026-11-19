import { type EmailContent } from './common.js';
export interface InvoiceEmailBaseInput {
    invoiceId: number;
    token: string;
    amount: string;
    dueDate: number;
    recipientAddress: string;
    freelancer?: string;
    payer?: string;
    funder?: string;
    invoiceUrl?: string;
    unsubscribeUrl: string;
}
export declare function buildInvoiceFundedEmail(input: InvoiceEmailBaseInput): EmailContent;
