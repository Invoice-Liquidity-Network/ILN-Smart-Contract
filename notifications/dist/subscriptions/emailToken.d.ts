export type SubscriptionTokenPurpose = 'verify' | 'unsubscribe';
export interface SubscriptionTokenPayload {
    purpose: SubscriptionTokenPurpose;
    subscriptionId: string;
    address: string;
    email: string;
    issuedAt: number;
    expiresAt: number;
}
export interface SubscriptionTokenServiceOptions {
    secret: string;
    now?: () => number;
}
export interface TokenInput {
    purpose: SubscriptionTokenPurpose;
    subscriptionId: string;
    address: string;
    email: string;
    ttlMs: number;
}
export declare function createSubscriptionTokenService(options: SubscriptionTokenServiceOptions): {
    sign(input: TokenInput): string;
    verify(token: string): SubscriptionTokenPayload | null;
};
