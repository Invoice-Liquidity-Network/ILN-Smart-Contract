const TOKEN_EMOJI = {
    USDC: '\u{1F535}',
    EURC: '\u{1F7E0}',
    XLM: '\u{26AB}',
    default: '\u{26AB}',
};
function tokenEmoji(token) {
    return TOKEN_EMOJI[token] ?? TOKEN_EMOJI.default;
}
function formatAmount(amount, token) {
    const num = parseInt(amount, 10);
    const decimals = 7;
    const formatted = (num / 10 ** decimals).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: decimals,
    });
    return `${formatted} ${token}`;
}
function formatDate(timestamp) {
    const seconds = Math.floor(timestamp);
    return `<!date^${seconds}^{date_short_pretty} {time}|${new Date(timestamp * 1000).toISOString()}>`;
}
function eventColor(eventType) {
    switch (eventType) {
        case 'invoice.submitted':
            return '#36a64f';
        case 'invoice.funded':
            return '#0070e0';
        case 'invoice.paid':
            return '#2eb886';
        case 'invoice.expiring_soon':
            return '#e01e5a';
        default:
            return '#cccccc';
    }
}
export function buildSlackMessage(event) {
    const emoji = tokenEmoji(event.token);
    const amountStr = formatAmount(event.amount, event.token);
    const blocks = [
        {
            type: 'header',
            text: {
                type: 'plain_text',
                text: `${emoji} Invoice #${event.invoiceId} ${event.type.replace('invoice.', '')}`,
            },
        },
        {
            type: 'section',
            fields: [
                { type: 'mrkdwn', text: `*Token:*\n${event.token}` },
                { type: 'mrkdwn', text: `*Amount:*\n${amountStr}` },
            ],
        },
    ];
    if (event.freelancer) {
        blocks.push({
            type: 'section',
            fields: [
                { type: 'mrkdwn', text: `*Freelancer:*\n${event.freelancer}` },
            ],
        });
    }
    if (event.payer) {
        blocks.push({
            type: 'section',
            fields: [
                { type: 'mrkdwn', text: `*Payer:*\n${event.payer}` },
            ],
        });
    }
    if (event.funder) {
        blocks.push({
            type: 'section',
            fields: [
                { type: 'mrkdwn', text: `*Funder:*\n${event.funder}` },
            ],
        });
    }
    blocks.push({
        type: 'section',
        fields: [
            { type: 'mrkdwn', text: `*Due Date:*\n${formatDate(event.dueDate)}` },
        ],
    });
    if (event.invoiceUrl) {
        blocks.push({
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: { type: 'plain_text', text: 'View Invoice' },
                    url: event.invoiceUrl,
                },
            ],
        });
    }
    return {
        attachments: [
            {
                color: eventColor(event.type),
                blocks,
            },
        ],
    };
}
export async function deliverSlackNotification(webhookUrl, event, http) {
    const payload = buildSlackMessage(event);
    try {
        const res = await http(webhookUrl, payload);
        return { ok: res.ok, status: res.status };
    }
    catch {
        return { ok: false, status: 0 };
    }
}
