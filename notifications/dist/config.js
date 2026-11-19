import { tmpdir } from 'node:os';
import { join } from 'node:path';
const port = Number(process.env.PORT ?? 3001);
export const config = {
    port,
    dbPath: process.env.NOTIFICATIONS_DB_PATH ?? join(tmpdir(), 'iln-notifications.db'),
    publicUrl: process.env.NOTIFICATIONS_PUBLIC_URL ?? `http://localhost:${port}`,
    emailFrom: process.env.EMAIL_FROM ?? 'ILN Notifications <noreply@iln.dev>',
    emailTokenSecret: process.env.EMAIL_TOKEN_SECRET ?? 'iln-notifications-email-secret',
    resendApiKey: process.env.RESEND_API_KEY ?? '',
};
