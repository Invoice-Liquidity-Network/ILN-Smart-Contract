import { createHmac, timingSafeEqual } from 'node:crypto';
export function createSubscriptionTokenService(options) {
    const now = options.now ?? Date.now;
    return {
        sign(input) {
            const issuedAt = now();
            const payload = {
                purpose: input.purpose,
                subscriptionId: input.subscriptionId,
                address: input.address,
                email: input.email,
                issuedAt,
                expiresAt: issuedAt + input.ttlMs,
            };
            return encodePayload(payload, options.secret);
        },
        verify(token) {
            return decodePayload(token, options.secret, now());
        },
    };
}
function encodePayload(payload, secret) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${signature}`;
}
function decodePayload(token, secret, now) {
    const [body, signature] = token.split('.');
    if (!body || !signature) {
        return null;
    }
    const expected = createHmac('sha256', secret).update(body).digest('base64url');
    const expectedBytes = Buffer.from(expected);
    const signatureBytes = Buffer.from(signature);
    if (expectedBytes.length !== signatureBytes.length) {
        return null;
    }
    if (!timingSafeEqual(expectedBytes, signatureBytes)) {
        return null;
    }
    try {
        const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (!parsed ||
            (parsed.purpose !== 'verify' && parsed.purpose !== 'unsubscribe') ||
            typeof parsed.subscriptionId !== 'string' ||
            typeof parsed.address !== 'string' ||
            typeof parsed.email !== 'string' ||
            typeof parsed.issuedAt !== 'number' ||
            typeof parsed.expiresAt !== 'number') {
            return null;
        }
        if (parsed.expiresAt < now) {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
