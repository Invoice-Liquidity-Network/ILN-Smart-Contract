export interface EmailContent {
    subject: string;
    html: string;
    text: string;
}
export interface EmailAction {
    label: string;
    url: string;
}
export interface EmailDetail {
    label: string;
    value: string;
}
export interface RenderInvoiceEmailOptions {
    eyebrow?: string;
    heading: string;
    summaryLines: string[];
    details: EmailDetail[];
    unsubscribeUrl: string;
    action?: EmailAction;
}
export declare function escapeHtml(value: string): string;
export declare function escapeAttribute(value: string): string;
export declare function formatAmount(amount: string, token: string): string;
export declare function formatDueDate(dueDate: number): string;
export declare function renderInvoiceEmail(options: RenderInvoiceEmailOptions): EmailContent;
