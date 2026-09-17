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
});

