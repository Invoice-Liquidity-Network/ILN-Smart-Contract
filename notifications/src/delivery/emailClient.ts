import { Resend } from 'resend';
import type { EmailClient, EmailMessage } from './emailDelivery.js';

export interface ResendEmailClientOptions {
  apiKey?: string;
  from: string;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export function createEmailClient(options: ResendEmailClientOptions): EmailClient {
  if (!options.apiKey) {
    return {
      async send(message: EmailMessage) {
        options.logger?.warn(
          `RESEND_API_KEY is not set; skipping real email delivery to ${message.to}`
        );
        return { id: `local_${Date.now().toString(36)}` };
      },
    };
  }

  const resend = new Resend(options.apiKey);

  return {
    async send(message: EmailMessage) {
      const response = await resend.emails.send({
        from: options.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text ?? undefined,
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      if (!response.data?.id) {
        throw new Error('Resend response did not include an email id');
      }

      return { id: response.data.id };
    },
  };
}
