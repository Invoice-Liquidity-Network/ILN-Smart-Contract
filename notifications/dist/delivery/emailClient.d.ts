import type { EmailClient } from './emailDelivery.js';
export interface ResendEmailClientOptions {
    apiKey?: string;
    from: string;
    logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}
export declare function createEmailClient(options: ResendEmailClientOptions): EmailClient;
