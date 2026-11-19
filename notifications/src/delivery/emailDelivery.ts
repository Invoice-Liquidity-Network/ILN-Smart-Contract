import { PerRecipientRateLimiter, type RateLimiterOptions } from './rateLimiter.js';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface EmailClient {
  send(msg: EmailMessage): Promise<{ id: string }>;
}

export interface EmailDeliveryResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/**
 * Delivery policy options. Rate limiting is scoped per recipient email
 * address so one noisy subscriber cannot starve email to everyone else
 * (Issue #728).
 */
export type EmailDeliveryOptions = RateLimiterOptions;

export class EmailDeliveryService {
  private readonly rateLimiter: PerRecipientRateLimiter;

  constructor(
    private readonly client: EmailClient,
    private readonly from: string,
    options: EmailDeliveryOptions = {},
  ) {
    this.rateLimiter = new PerRecipientRateLimiter(options);
  }

  async send(msg: EmailMessage): Promise<EmailDeliveryResult> {
    // Recipient-scoped budget: the email address is the key, so hitting one
    // recipient's limit never blocks another recipient.
    if (!this.rateLimiter.tryConsume(normalizeRecipient(msg.to))) {
      return { ok: false, error: 'rate_limited' };
    }

    try {
      const res = await this.client.send(msg);
      return { ok: true, id: res.id };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  getFrom(): string {
    return this.from;
  }
}

function normalizeRecipient(email: string): string {
  return email.trim().toLowerCase();
}
