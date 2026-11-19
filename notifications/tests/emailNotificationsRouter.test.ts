import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createEmailNotificationsRouter } from '../src/api/emailNotifications';
import { EmailDeliveryService } from '../src/delivery/emailDelivery';
import { buildNotificationEmailMessage } from '../src/delivery/email';
import { EmailSubscriptionStore } from '../src/subscriptions/emailSubscriptionStore';

function makeApp(options?: {
  publicUrl?: string;
  sendImpl?: (message: { to: string; subject: string; html: string; text?: string }) => Promise<{ id: string }>;
}) {
  let nowMs = 1_700_000_000_000;
  const store = new EmailSubscriptionStore();
  const sentEmails: Array<{ to: string; subject: string; html: string; text?: string }> = [];
  const client = {
    send: vi.fn(
      options?.sendImpl ??
        (async (message: { to: string; subject: string; html: string; text?: string }) => {
          sentEmails.push(message);
          return { id: `msg_${sentEmails.length}` };
        }),
    ),
  };
  const delivery = new EmailDeliveryService(client, 'noreply@iln.dev');

  const app = express();
  app.use(express.json());
  app.use(
    createEmailNotificationsRouter(store, delivery, {
      tokenSecret: 'test-secret',
      publicUrl: options?.publicUrl ?? 'https://notifications.example.com',
      now: () => nowMs,
      unsubscribeTtlMs: 120_000,
    }),
  );

  return {
    app,
    store,
    sentEmails,
    advanceTime(ms: number) {
      nowMs += ms;
      return nowMs;
    },
    currentTime() {
      return nowMs;
    },
  };
}

function createActiveSubscription(
  store: EmailSubscriptionStore,
  address: string,
  email: string,
  eventTypes: string[],
  consentAt: number,
) {
  const sub = store.create({ address, email, eventTypes });
  store.activate(sub.id, consentAt);
  return store.get(sub.id)!;
}

describe('email notifications router', () => {
  it('sends only to active matching subscribers', async () => {
    const { app, store, sentEmails, currentTime } = makeApp();

    createActiveSubscription(
      store,
      'GFREELANCER123',
      'freelancer@example.com',
      ['invoice.funded'],
      currentTime(),
    );
    createActiveSubscription(
      store,
      'GPAYER123',
      'payer@example.com',
      ['invoice.paid'],
      currentTime(),
    );
    store.create({
      address: 'GFREELANCER123',
      email: 'pending@example.com',
      eventTypes: ['invoice.funded'],
    });

    const res = await request(app).post('/notify/email').send({
      type: 'invoice.funded',
      invoiceId: 42,
      token: 'USDC',
      amount: '10000000',
      dueDate: Math.floor((currentTime() + 72 * 60 * 60 * 1000) / 1000),
      freelancer: 'GFREELANCER123',
      payer: 'GPAYER123',
      funder: 'GFUNDER123',
      invoiceUrl: 'https://iln.app/invoices/42',
    });

    expect(res.status).toBe(200);
    expect(res.body.delivered).toBe(1);
    expect(res.body.failed).toBe(0);
    expect(res.body.total).toBe(1);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]?.to).toBe('freelancer@example.com');
    expect(sentEmails[0]?.subject).toContain('funded');
    expect(sentEmails[0]?.html).toContain('/subscriptions/email?token=');
    expect(sentEmails[0]?.html).toContain('https://iln.app/invoices/42');
  });

  it.each([72, 24] as const)('renders the %s-hour reminder subject', async (hours) => {
    const { app, store, sentEmails, currentTime } = makeApp();

    createActiveSubscription(
      store,
      'GPAYER123',
      'payer@example.com',
      ['invoice.expiring_soon'],
      currentTime(),
    );

    const res = await request(app).post('/notify/email').send({
      type: 'invoice.expiring_soon',
      invoiceId: 7,
      token: 'EURC',
      amount: '2500000',
      dueDate: Math.floor((currentTime() + hours * 60 * 60 * 1000) / 1000),
      payer: 'GPAYER123',
    });

    expect(res.status).toBe(200);
    expect(res.body.delivered).toBe(1);
    expect(sentEmails[0]?.subject).toContain(`${hours} hours`);
    expect(sentEmails[0]?.text).toContain(`${hours}-hour reminder`);
  });

  it('returns a 400 when no recipient address is present', async () => {
    const { app } = makeApp();

    const res = await request(app).post('/notify/email').send({
      type: 'invoice.paid',
      invoiceId: 11,
      token: 'XLM',
      amount: '1000000',
      dueDate: Math.floor(Date.now() / 1000) + 86400,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_recipient_address');
  });

  it.each(['', 'not a url'] as const)('falls back to localhost unsubscribe links when publicUrl is %p', async (publicUrl) => {
    const { app, sentEmails, store, currentTime } = makeApp({ publicUrl });

    const subscription = store.create({
      address: 'GPAYER123',
      email: 'payer@example.com',
      eventTypes: ['invoice.paid'],
    });
    store.activate(subscription.id, currentTime());

    await request(app).post('/notify/email').send({
      type: 'invoice.paid',
      invoiceId: 100,
      token: 'USDC',
      amount: '10000000',
      dueDate: Math.floor(Date.now() / 1000) + 86400,
      payer: 'GPAYER123',
    });

    expect(sentEmails[0]?.html).toContain('http://localhost:3001/subscriptions/email?token=');
  });

  it('counts failed disputed notifications when delivery is unavailable', async () => {
    const { app, store } = makeApp({
      sendImpl: async () => {
        throw new Error('resend down');
      },
    });

    const subscription = store.create({
      address: 'GPAYER123',
      email: 'payer@example.com',
      eventTypes: ['invoice.disputed'],
    });
    store.activate(subscription.id, Date.now());

    const res = await request(app).post('/notify/email').send({
      type: 'invoice.disputed',
      invoiceId: 7,
      token: 'USDC',
      amount: '10000000',
      dueDate: Math.floor(Date.now() / 1000) + 86400,
      payer: 'GPAYER123',
      invoiceUrl: 'https://iln.app/invoices/7',
    });

    expect(res.status).toBe(200);
    expect(res.body.delivered).toBe(0);
    expect(res.body.failed).toBe(1);
    expect(res.body.total).toBe(1);
  });

  it('throws for unsupported notification event types', () => {
    const subscription = {
      id: 'eml_1',
      address: 'GPAYER123',
      email: 'payer@example.com',
      eventTypes: ['invoice.paid'],
      status: 'active',
      consentAt: Date.now(),
      verificationSentAt: Date.now(),
      unsubscribedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    expect(() =>
      buildNotificationEmailMessage(subscription as any, { type: 'invoice.cancelled' as any }, {
        publicUrl: 'https://notifications.example.com',
        tokenSecret: 'test-secret',
      }),
    ).toThrow('Unsupported email event type');
  });
});
