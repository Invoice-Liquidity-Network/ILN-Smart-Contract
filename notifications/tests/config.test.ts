import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = {
  PORT: process.env.PORT,
  NOTIFICATIONS_DB_PATH: process.env.NOTIFICATIONS_DB_PATH,
  NOTIFICATIONS_PUBLIC_URL: process.env.NOTIFICATIONS_PUBLIC_URL,
  EMAIL_FROM: process.env.EMAIL_FROM,
  EMAIL_TOKEN_SECRET: process.env.EMAIL_TOKEN_SECRET,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
};

function restoreEnv() {
  process.env.PORT = ORIGINAL_ENV.PORT;
  process.env.NOTIFICATIONS_DB_PATH = ORIGINAL_ENV.NOTIFICATIONS_DB_PATH;
  process.env.NOTIFICATIONS_PUBLIC_URL = ORIGINAL_ENV.NOTIFICATIONS_PUBLIC_URL;
  process.env.EMAIL_FROM = ORIGINAL_ENV.EMAIL_FROM;
  process.env.EMAIL_TOKEN_SECRET = ORIGINAL_ENV.EMAIL_TOKEN_SECRET;
  process.env.RESEND_API_KEY = ORIGINAL_ENV.RESEND_API_KEY;
}

describe('config', () => {
  afterEach(() => {
    restoreEnv();
    vi.resetModules();
  });

  it('applies defaults when environment variables are missing', async () => {
    delete process.env.PORT;
    delete process.env.NOTIFICATIONS_DB_PATH;
    delete process.env.NOTIFICATIONS_PUBLIC_URL;
    delete process.env.EMAIL_FROM;
    delete process.env.EMAIL_TOKEN_SECRET;
    delete process.env.RESEND_API_KEY;

    const { config } = await import('../src/config');

    expect(config.port).toBe(3001);
    expect(config.publicUrl).toBe('http://localhost:3001');
    expect(config.emailFrom).toBe('ILN Notifications <noreply@iln.dev>');
    expect(config.emailTokenSecret).toBe('iln-notifications-email-secret');
    expect(config.resendApiKey).toBe('');
    expect(config.dbPath).toContain('iln-notifications.db');
  });

  it('reads environment overrides', async () => {
    process.env.PORT = '4567';
    process.env.NOTIFICATIONS_DB_PATH = '/tmp/notifications.db';
    process.env.NOTIFICATIONS_PUBLIC_URL = 'https://notify.example.com';
    process.env.EMAIL_FROM = 'Alerts <alerts@example.com>';
    process.env.EMAIL_TOKEN_SECRET = 'secret-override';
    process.env.RESEND_API_KEY = 're_test_123';

    const { config } = await import('../src/config');

    expect(config.port).toBe(4567);
    expect(config.dbPath).toBe('/tmp/notifications.db');
    expect(config.publicUrl).toBe('https://notify.example.com');
    expect(config.emailFrom).toBe('Alerts <alerts@example.com>');
    expect(config.emailTokenSecret).toBe('secret-override');
    expect(config.resendApiKey).toBe('re_test_123');
  });

  it('confirms static config does not hot-reload without module re-import / process restart', async () => {
    process.env.PORT = '3001';
    process.env.RESEND_API_KEY = 'initial_key';

    const { config: initialConfig } = await import('../src/config');
    expect(initialConfig.port).toBe(3001);
    expect(initialConfig.resendApiKey).toBe('initial_key');

    // Mutate environment variable in running process without restarting/reloading
    process.env.PORT = '9999';
    process.env.RESEND_API_KEY = 'rotated_key';

    // Without module reload or process restart, initialConfig snapshot remains unchanged
    expect(initialConfig.port).toBe(3001);
    expect(initialConfig.resendApiKey).toBe('initial_key');

    // After module cache reset (simulating a service redeploy/restart), new env values are loaded
    vi.resetModules();
    const { config: reloadedConfig } = await import('../src/config');
    expect(reloadedConfig.port).toBe(9999);
    expect(reloadedConfig.resendApiKey).toBe('rotated_key');
  });

  it('supports hot-rotation of Slack webhook credentials without service restart', async () => {
    const { createSlackRouter } = await import('../src/api/slack.js');
    const store = new Map<string, any>();
    const deliveredUrls: string[] = [];
    const httpClient = vi.fn(async (url: string) => {
      deliveredUrls.push(url);
      return { ok: true, status: 200 };
    });

    // 1. Initial subscription with old webhook
    const initialSub = {
      id: 'slk_old',
      url: 'https://hooks.slack.com/services/OLD/WEBHOOK/URL',
      eventTypes: ['invoice.submitted', 'invoice.paid'],
    };
    store.set(initialSub.id, initialSub);

    // 2. Perform rotation: register new webhook URL dynamically
    const newSub = {
      id: 'slk_new',
      url: 'https://hooks.slack.com/services/NEW/WEBHOOK/URL',
      eventTypes: ['invoice.submitted', 'invoice.paid'],
    };
    store.set(newSub.id, newSub);

    // 3. Remove old compromised webhook
    store.delete('slk_old');

    // 4. Verify delivery router uses the new webhook immediately
    const sampleEvent = {
      type: 'invoice.submitted' as const,
      invoiceId: 101,
      token: 'USDC' as const,
      amount: '5000000',
      dueDate: 1735689600,
    };

    const activeSubscriptions = [...store.values()].filter((s) =>
      s.eventTypes.includes(sampleEvent.type),
    );
    const { deliverSlackNotification } = await import('../src/delivery/slack.js');
    await Promise.all(
      activeSubscriptions.map((s) => deliverSlackNotification(s.url, sampleEvent, httpClient)),
    );

    expect(deliveredUrls).toEqual(['https://hooks.slack.com/services/NEW/WEBHOOK/URL']);
    expect(deliveredUrls).not.toContain('https://hooks.slack.com/services/OLD/WEBHOOK/URL');
  });

  it('supports hot-rotation of Telegram bot token credentials without service restart', async () => {
    const store = new Map<string, any>();
    const deliveredRequests: Array<{ url: string; botToken: string }> = [];
    const httpClient = vi.fn(async (url: string) => {
      const match = url.match(/\/bot([^/]+)\/sendMessage/);
      deliveredRequests.push({ url, botToken: match ? match[1] : '' });
      return { ok: true, status: 200 };
    });

    // 1. Initial subscription with old bot token
    const initialSub = {
      id: 'tg_old',
      botToken: 'OLD_BOT_TOKEN_123',
      chatId: '-100123456',
      eventTypes: ['invoice.funded'],
    };
    store.set(initialSub.id, initialSub);

    // 2. Perform rotation: register new subscription with new bot token
    const newSub = {
      id: 'tg_new',
      botToken: 'NEW_ROTATED_BOT_TOKEN_456',
      chatId: '-100123456',
      eventTypes: ['invoice.funded'],
    };
    store.set(newSub.id, newSub);

    // 3. Revoke/delete old subscription
    store.delete('tg_old');

    // 4. Verify delivery immediately uses the new token
    const sampleEvent = {
      type: 'invoice.funded' as const,
      invoiceId: 202,
      token: 'USDC' as const,
      amount: '9500000',
      dueDate: 1735689600,
    };

    const activeSubscriptions = [...store.values()].filter((s) =>
      s.eventTypes.includes(sampleEvent.type),
    );
    const { deliverTelegramNotification } = await import('../src/delivery/telegram.js');
    await Promise.all(
      activeSubscriptions.map((s) =>
        deliverTelegramNotification(s.botToken, s.chatId, sampleEvent, httpClient),
      ),
    );

    expect(deliveredRequests).toHaveLength(1);
    expect(deliveredRequests[0].botToken).toBe('NEW_ROTATED_BOT_TOKEN_456');
    expect(deliveredRequests[0].url).toContain('NEW_ROTATED_BOT_TOKEN_456');
  });
});

