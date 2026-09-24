import { describe, expect, it, vi } from 'vitest';
import {
  buildSlackMessage,
  deliverSlackNotification,
  type SlackInvoiceEvent,
} from '../src/delivery/slack';
import { PerRecipientRateLimiter } from '../src/delivery/rateLimiter';

const baseEvent: SlackInvoiceEvent = {
  type: 'invoice.submitted',
  invoiceId: 42,
  token: 'USDC',
  amount: '10000000',
  dueDate: Math.floor(Date.now() / 1000) + 30 * 86400,
  freelancer: 'GABCDEF...FREELANCER',
  payer: 'GHIJKL...PAYER',
};

describe('Slack notification', () => {
  describe('buildSlackMessage', () => {
    it('returns a valid Slack Block Kit payload', () => {
      const msg = buildSlackMessage(baseEvent);
      expect(msg).toHaveProperty('attachments');
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments[0]).toHaveProperty('blocks');
      expect(msg.attachments[0].color).toBe('#36a64f');
    });

    it('includes header with emoji and event type', () => {
      const msg = buildSlackMessage(baseEvent);
      const header = msg.attachments[0].blocks.find((b: any) => b.type === 'header');
      expect(header).toBeDefined();
      expect(header.text.text).toContain('Invoice #42');
      expect(header.text.text).toContain('submitted');
    });

    it('includes USDC blue emoji', () => {
      const msg = buildSlackMessage(baseEvent);
      const header = msg.attachments[0].blocks.find((b: any) => b.type === 'header');
      expect(header.text.text).toContain('\u{1F535}');
    });

    it('includes EURC yellow emoji', () => {
      const msg = buildSlackMessage({ ...baseEvent, token: 'EURC' });
      const header = msg.attachments[0].blocks.find((b: any) => b.type === 'header');
      expect(header.text.text).toContain('\u{1F7E0}');
    });

    it('includes XLM black emoji', () => {
      const msg = buildSlackMessage({ ...baseEvent, token: 'XLM' });
      const header = msg.attachments[0].blocks.find((b: any) => b.type === 'header');
      expect(header.text.text).toContain('\u{26AB}');
    });

    it('includes amount and token in section fields', () => {
      const msg = buildSlackMessage(baseEvent);
      const section = msg.attachments[0].blocks.find((b: any) => b.type === 'section');
      const fields = section.fields.map((f: any) => f.text);
      expect(fields.some((f: string) => f.includes('USDC'))).toBe(true);
      expect(fields.some((f: string) => f.includes('1.00 USDC'))).toBe(true);
    });

    it('includes freelancer when provided', () => {
      const msg = buildSlackMessage(baseEvent);
      const allText = JSON.stringify(msg);
      expect(allText).toContain('GABCDEF...FREELANCER');
    });

    it('includes due date', () => {
      const msg = buildSlackMessage(baseEvent);
      const allText = JSON.stringify(msg);
      expect(allText).toContain('Due Date');
    });

    it('includes invoice URL button when provided', () => {
      const msg = buildSlackMessage({
        ...baseEvent,
        invoiceUrl: 'https://iln.app/invoices/42',
      });
      const actions = msg.attachments[0].blocks.find((b: any) => b.type === 'actions');
      expect(actions).toBeDefined();
      expect(actions.elements[0].url).toBe('https://iln.app/invoices/42');
    });

    it('uses green color for invoice.submitted', () => {
      const msg = buildSlackMessage(baseEvent);
      expect(msg.attachments[0].color).toBe('#36a64f');
    });

    it('uses blue color for invoice.funded', () => {
      const msg = buildSlackMessage({ ...baseEvent, type: 'invoice.funded' });
      expect(msg.attachments[0].color).toBe('#0070e0');
    });

    it('uses green for invoice.paid', () => {
      const msg = buildSlackMessage({ ...baseEvent, type: 'invoice.paid' });
      expect(msg.attachments[0].color).toBe('#2eb886');
    });

    it('uses red for invoice.expiring_soon', () => {
      const msg = buildSlackMessage({ ...baseEvent, type: 'invoice.expiring_soon' });
      expect(msg.attachments[0].color).toBe('#e01e5a');
    });
  });

  describe('deliverSlackNotification', () => {
    it('sends payload to webhook URL', async () => {
      const http = vi.fn(async () => ({ ok: true, status: 200 }));
      const res = await deliverSlackNotification(
        'https://hooks.slack.com/services/T00/B00/xxx',
        baseEvent,
        http,
      );
      expect(res.ok).toBe(true);
      expect(http).toHaveBeenCalledTimes(1);
      const [url, body] = http.mock.calls[0];
      expect(url).toBe('https://hooks.slack.com/services/T00/B00/xxx');
      expect(body).toHaveProperty('attachments');
    });

    it('returns failure on HTTP error', async () => {
      const http = vi.fn(async () => ({ ok: false, status: 500 }));
      const res = await deliverSlackNotification('https://hooks.slack.com/xxx', baseEvent, http);
      expect(res.ok).toBe(false);
      expect(res.status).toBe(500);
    });

    it('returns failure on network error', async () => {
      const http = vi.fn(async () => {
        throw new Error('network');
      });
      const res = await deliverSlackNotification('https://hooks.slack.com/xxx', baseEvent, http);
      expect(res.ok).toBe(false);
      expect(res.status).toBe(0);
    });

    it('rate limits per channel: one exhausted channel does not affect another', async () => {
      const rateLimiter = new PerRecipientRateLimiter({
        maxRequests: 2,
        windowMs: 1000,
        now: () => 0,
      });
      const http = vi.fn(async () => ({ ok: true, status: 200 }));
      const noisy = 'https://hooks.slack.com/services/T1/B1/noisy';
      const quiet = 'https://hooks.slack.com/services/T2/B2/quiet';

      expect((await deliverSlackNotification(noisy, baseEvent, http, { rateLimiter })).ok).toBe(
        true,
      );
      expect((await deliverSlackNotification(noisy, baseEvent, http, { rateLimiter })).ok).toBe(
        true,
      );
      expect(
        (await deliverSlackNotification(noisy, baseEvent, http, { rateLimiter })).status,
      ).toBe(429);

      // The quiet channel is unaffected.
      expect((await deliverSlackNotification(quiet, baseEvent, http, { rateLimiter })).ok).toBe(
        true,
      );
      expect((await deliverSlackNotification(quiet, baseEvent, http, { rateLimiter })).ok).toBe(
        true,
      );
      expect(
        (await deliverSlackNotification(quiet, baseEvent, http, { rateLimiter })).status,
      ).toBe(429);

      // Only in-budget sends reached the HTTP client.
      expect(http).toHaveBeenCalledTimes(4);
    });
  });
});
