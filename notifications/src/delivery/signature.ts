import { createHmac, timingSafeEqual } from 'node:crypto';

export function signPayload(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifySignature(
  secret: string,
  payload: string,
  signature: string,
): boolean {
  const expected = signPayload(secret, payload);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
