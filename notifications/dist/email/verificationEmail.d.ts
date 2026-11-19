export interface VerificationEmailInput {
    address: string;
    email: string;
    eventTypes: string[];
    verifyUrl: string;
    unsubscribeUrl: string;
}
export interface VerificationEmailContent {
    subject: string;
    html: string;
    text: string;
}
export declare function buildVerificationEmail(input: VerificationEmailInput): VerificationEmailContent;
