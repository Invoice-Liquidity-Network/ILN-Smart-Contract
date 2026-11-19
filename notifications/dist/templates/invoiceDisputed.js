import { formatAmount, formatDueDate, renderInvoiceEmail } from './common.js';
function sharedDetails(input) {
    return [
        { label: 'Recipient address', value: input.recipientAddress },
        { label: 'Freelancer', value: input.freelancer ?? 'Not provided' },
        { label: 'Payer', value: input.payer ?? 'Not provided' },
        { label: 'Funder', value: input.funder ?? 'Not provided' },
        { label: 'Token', value: input.token },
        { label: 'Amount', value: formatAmount(input.amount, input.token) },
        { label: 'Due date', value: formatDueDate(input.dueDate) },
    ];
}
export function buildInvoiceDisputedEmail(input) {
    return renderInvoiceEmail({
        eyebrow: 'Invoice dispute alert',
        heading: `Invoice #${input.invoiceId} disputed`,
        summaryLines: [
            `Invoice #${input.invoiceId} has been marked as disputed and may need your attention.`,
            'You are receiving this because your Stellar address is subscribed to disputed invoice updates.',
        ],
        details: sharedDetails(input),
        action: input.invoiceUrl
            ? {
                label: 'Open dispute details',
                url: input.invoiceUrl,
            }
            : undefined,
        unsubscribeUrl: input.unsubscribeUrl,
    });
}
