import { type EmailContent } from './common.js';
import type { InvoiceEmailBaseInput } from './invoiceFunded.js';
export interface InvoiceExpiringSoonEmailInput extends InvoiceEmailBaseInput {
    reminderHours?: 72 | 24;
    now?: number;
}
export declare function buildInvoiceExpiringSoonEmail(input: InvoiceExpiringSoonEmailInput): EmailContent;
