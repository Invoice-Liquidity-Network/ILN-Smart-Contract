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
export function buildInvoicePaidEmail(input) {
    return renderInvoiceEmail({
        eyebrow: 'Invoice payment update',
        heading: `Invoice #${input.invoiceId} paid`,
        summaryLines: [
            `Invoice #${input.invoiceId} has been paid and the payment details are now available.`,
            'You are receiving this because your Stellar address is subscribed to paid invoice updates.',
        ],
        details: sharedDetails(input),
        action: input.invoiceUrl
            ? {
                label: 'Review payment',
                url: input.invoiceUrl,
            }
            : undefined,
        unsubscribeUrl: input.unsubscribeUrl,
    });
}
