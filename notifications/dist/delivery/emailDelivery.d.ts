export interface EmailMessage {
    to: string;
    subject: string;
    html: string;
    text?: string;
}
export interface EmailClient {
    send(msg: EmailMessage): Promise<{
        id: string;
    }>;
}
export interface EmailDeliveryResult {
    ok: boolean;
    id?: string;
    error?: string;
}
export declare class EmailDeliveryService {
    private readonly client;
    private readonly from;
    constructor(client: EmailClient, from: string);
    send(msg: EmailMessage): Promise<EmailDeliveryResult>;
    getFrom(): string;
}
