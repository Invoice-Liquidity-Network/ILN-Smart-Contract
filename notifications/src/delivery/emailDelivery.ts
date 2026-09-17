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

export class EmailDeliveryService {
  constructor(
    private readonly client: EmailClient,
    private readonly from: string,
  ) {}

  async send(msg: EmailMessage): Promise<EmailDeliveryResult> {
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
