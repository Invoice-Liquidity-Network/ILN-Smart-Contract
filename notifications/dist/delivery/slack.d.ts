export interface SlackInvoiceEvent {
    type: 'invoice.submitted' | 'invoice.funded' | 'invoice.paid' | 'invoice.expiring_soon';
    invoiceId: number;
    token: 'USDC' | 'EURC' | 'XLM';
    amount: string;
    dueDate: number;
    freelancer?: string;
    payer?: string;
    funder?: string;
    invoiceUrl?: string;
}
export declare function buildSlackMessage(event: SlackInvoiceEvent): {
    attachments: {
        color: string;
        blocks: any[];
    }[];
};
export type SlackHttpClient = (url: string, body: unknown) => Promise<{
    ok: boolean;
    status: number;
}>;
export declare function deliverSlackNotification(webhookUrl: string, event: SlackInvoiceEvent, http: SlackHttpClient): Promise<{
    ok: boolean;
    status: number;
}>;
