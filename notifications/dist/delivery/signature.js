import { createHmac, timingSafeEqual } from 'node:crypto';
export function signPayload(secret, payload) {
    return createHmac('sha256', secret).update(payload).digest('hex');
}
export function verifySignature(secret, payload, signature) {
    const expected = signPayload(secret, payload);
    if (expected.length !== signature.length)
        return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
