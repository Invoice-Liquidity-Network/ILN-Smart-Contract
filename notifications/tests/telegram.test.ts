import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createTelegramRouter } from '../src/api/telegram.js';
import type { TelegramSubscription } from '../src/api/telegram.js';
import { deliverTelegramNotification, buildTelegramMessage } from '../src/delivery/telegram.js';
import type { TelegramInvoiceEvent } from '../src/delivery/telegram.js';

describe('Telegram Delivery & Router', () => {
  const store = new Map<string, TelegramSubscription>();
  const mockHttpClient = vi.fn();
  
  const app = express();
  app.use(express.json());
  app.use(createTelegramRouter(store, { httpClient: mockHttpClient }));

  it('buildTelegramMessage formats markdown correctly', () => {
    const event: TelegramInvoiceEvent = {
      type: 'invoice.submitted',
      invoiceId: 101,
      token: 'USDC',
      amount: '100000000',
      dueDate: 1700000000,
      freelancer: 'GAAFreelancer',
      payer: 'GAAPayer',
      invoiceUrl: 'https://app.example.com/invoice/101'
    };

    const text = buildTelegramMessage(event);
    expect(text).toContain('*🔵 Invoice #101 submitted*');
    expect(text).toContain('*Amount:* 10.00 USDC');
    expect(text).toContain('`GAAFreelancer`');
    expect(text).toContain('`GAAPayer`');
    expect(text).toContain('[View Invoice](https://app.example.com/invoice/101)');
  });

  it('delivers telegram notification using http client', async () => {
    mockHttpClient.mockResolvedValueOnce({ ok: true, status: 200 });

    const event: TelegramInvoiceEvent = {
      type: 'invoice.paid',
      invoiceId: 102,
      token: 'EURC',
      amount: '500000000',
      dueDate: 1700000000,
    };

    const result = await deliverTelegramNotification('my_bot_token', 'chat_123', event, mockHttpClient);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);

    expect(mockHttpClient).toHaveBeenCalledWith(
      'https://api.telegram.org/botmy_bot_token/sendMessage',
      expect.objectContaining({
        chat_id: 'chat_123',
        parse_mode: 'Markdown',
        text: expect.stringContaining('*🟠 Invoice #102 paid*'),
        disable_web_page_preview: true
      })
    );
  });

  it('registers a telegram subscription via API', async () => {
    const res = await request(app)
      .post('/subscriptions/telegram')
      .send({
        botToken: 'bot_test_token',
        chatId: 'test_chat_id',
        eventTypes: ['invoice.funded', 'invoice.disputed']
      });

    expect(res.status).toBe(201);
    expect(res.body.botToken).toBe('bot_test_token');
    expect(res.body.chatId).toBe('test_chat_id');
    expect(res.body.eventTypes).toEqual(['invoice.funded', 'invoice.disputed']);
    
    expect(store.size).toBe(1);
    const sub = Array.from(store.values())[0];
    expect(sub.botToken).toBe('bot_test_token');
  });

  it('notifies telegram subscriptions via API', async () => {
    store.clear();
    mockHttpClient.mockClear();
    
    // Add subscription
    await request(app)
      .post('/subscriptions/telegram')
      .send({
        botToken: 'bot_1',
        chatId: 'chat_1',
        eventTypes: ['invoice.disputed']
      });

    mockHttpClient.mockResolvedValueOnce({ ok: true, status: 200 });

    const event: TelegramInvoiceEvent = {
      type: 'invoice.disputed',
      invoiceId: 999,
      token: 'XLM',
      amount: '10000000',
      dueDate: 1700000000,
    };

    const notifyRes = await request(app)
      .post('/notify/telegram')
      .send(event);

    expect(notifyRes.status).toBe(200);
    expect(notifyRes.body.delivered).toBe(1);
    expect(notifyRes.body.total).toBe(1);

    expect(mockHttpClient).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid subscriptions', async () => {
    const res = await request(app)
      .post('/subscriptions/telegram')
      .send({
        botToken: 'bot',
        chatId: 'chat',
        eventTypes: ['invalid_event']
      });
      
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('unsupported_event_types');
  });
});
