import { describe, expect, it, vi } from 'vitest';
import {
  buildInvoiceDisputedEmail,
  buildInvoiceExpiringSoonEmail,
  buildInvoiceFundedEmail,
  buildInvoicePaidEmail,
} from '../src/templates';
import { renderInvoiceEmail } from '../src/templates/common';

const baseInput = {
  invoiceId: 42,
  token: 'USDC' as const,
  amount: '10000000',
  dueDate: 1_700_000_000,
  recipientAddress: 'GABCDEF1234567890',
  freelancer: 'GFREELANCER123',
  payer: 'GPAYER123',
  funder: 'GFUNDER123',
  invoiceUrl: 'https://iln.app/invoices/42',
  unsubscribeUrl: 'https://notifications.example.com/subscriptions/email?token=signed',
};

describe('invoice email templates', () => {
  it.each([
    ['funded', buildInvoiceFundedEmail, 'funded'],
    ['paid', buildInvoicePaidEmail, 'paid'],
    ['disputed', buildInvoiceDisputedEmail, 'disputed'],
  ] as const)('renders %s template with unsubscribe link', (_label, builder, expectedWord) => {
    const email = builder(baseInput);

    expect(email.subject).toContain(expectedWord);
    expect(email.html).toContain(baseInput.unsubscribeUrl);
    expect(email.text).toContain(`Unsubscribe: ${baseInput.unsubscribeUrl}`);
    expect(email.html).toContain(baseInput.invoiceUrl);
    expect(email.text).toContain('Recipient address: GABCDEF1234567890');
  });

  it.each([
    buildInvoiceFundedEmail,
    buildInvoicePaidEmail,
    buildInvoiceDisputedEmail,
  ])('renders a template without an invoice link', (builder) => {
    const email = builder({
      ...baseInput,
      invoiceUrl: undefined,
    });

    expect(email.html).toContain('unsubscribe here');
    expect(email.text).toContain('Unsubscribe:');
  });

  it.each([
    buildInvoiceFundedEmail,
    buildInvoicePaidEmail,
    buildInvoiceDisputedEmail,
  ])('renders optional detail placeholders when participant addresses are missing', (builder) => {
    const email = builder({
      ...baseInput,
      freelancer: undefined,
      payer: undefined,
      funder: undefined,
      invoiceUrl: undefined,
    });

    expect(email.text).toContain('Not provided');
    expect(email.html).toContain('Not provided');
  });

  it.each([72, 24] as const)('renders expiring soon reminders for %s hours', (hours) => {
    const now = 1_700_000_000_000;
    const email = buildInvoiceExpiringSoonEmail({
      ...baseInput,
      reminderHours: hours,
      now,
    });

    expect(email.subject).toContain(`${hours} hours`);
    expect(email.html).toContain(`${hours}-hour reminder`);
    expect(email.text).toContain(`${hours}-hour reminder`);
    expect(email.html).toContain(baseInput.unsubscribeUrl);
  });

  it('derives reminder hours from due date when not explicitly provided', () => {
    const now = 1_700_000_000_000;
    const email = buildInvoiceExpiringSoonEmail({
      ...baseInput,
      dueDate: Math.floor((now + 72 * 60 * 60 * 1000) / 1000),
      now,
    });

    expect(email.subject).toContain('72 hours');
  });

  it('renders a shell without eyebrow or action copy', () => {
    const email = renderInvoiceEmail({
      heading: 'Standalone email',
      summaryLines: ['A short summary.'],
      details: [{ label: 'Field', value: 'Value' }],
      unsubscribeUrl: baseInput.unsubscribeUrl,
    });

    expect(email.subject).toBe('Standalone email');
    expect(email.html).toContain('Standalone email');
    expect(email.text).toContain('Field: Value');
  });
});
