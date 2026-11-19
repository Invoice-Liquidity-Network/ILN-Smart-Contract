import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.env.PORT ?? 3001);

const DAY_MS = 24 * 60 * 60 * 1000;

export const config = {
  port,
  dbPath: process.env.NOTIFICATIONS_DB_PATH ?? join(tmpdir(), 'iln-notifications.db'),
  publicUrl: process.env.NOTIFICATIONS_PUBLIC_URL ?? `http://localhost:${port}`,
  emailFrom: process.env.EMAIL_FROM ?? 'ILN Notifications <noreply@iln.dev>',
  emailTokenSecret: process.env.EMAIL_TOKEN_SECRET ?? 'iln-notifications-email-secret',
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  // Delivery history retention (Issue #733): response bodies are purged
  // before full records so PII (recipient emails, message content) is kept
  // for the shortest practical window while debugging metadata survives.
  deliveryBodyRetentionMs: Number(
    process.env.NOTIFICATIONS_DELIVERY_BODY_RETENTION_MS ?? 7 * DAY_MS,
  ),
  deliveryRecordRetentionMs: Number(
    process.env.NOTIFICATIONS_DELIVERY_RECORD_RETENTION_MS ?? 90 * DAY_MS,
  ),
};
