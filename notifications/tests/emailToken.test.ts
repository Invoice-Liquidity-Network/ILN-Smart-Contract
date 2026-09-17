import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSubscriptionTokenService, type SubscriptionTokenPayload } from '../src/subscriptions/emailToken';

function encode(payload: SubscriptionTokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

describe('createSubscriptionTokenService', () => {
  it('signs and verifies tokens', () => {
    const now = 1_700_000_000_000;
    const svc = createSubscriptionTokenService({
      secret: 'test-secret',
      now: () => now,
    });

    const token = svc.sign({
      purpose: 'verify',
      subscriptionId: 'sub_1',
      address: 'GABC123',
      email: 'user@example.com',
      ttlMs: 60_000,
    });

    const payload = svc.verify(token);
    expect(payload).toMatchObject({
      purpose: 'verify',
      subscriptionId: 'sub_1',
      address: 'GABC123',
      email: 'user@example.com',
      issuedAt: now,
      expiresAt: now + 60_000,
    });
  });

  it('returns null for malformed or tampered tokens', () => {
    const svc = createSubscriptionTokenService({
      secret: 'test-secret',
      now: () => 1_700_000_000_000,
    });

    expect(svc.verify('malformed-token')).toBeNull();
    expect(svc.verify('body.only')).toBeNull();
    expect(
      svc.verify(
        encode(
          {
            purpose: 'verify',
            subscriptionId: 'sub_1',
            address: 'GABC123',
            email: 'user@example.com',
            issuedAt: 1_700_000_000_000,
            expiresAt: 1_700_000_060_000,
          },
          'wrong-secret',
        ),
      ),
    ).toBeNull();
  });

  it('returns null for expired or unsupported-purpose tokens', () => {
    const svc = createSubscriptionTokenService({
      secret: 'test-secret',
      now: () => 1_700_000_000_000,
    });

    const expired = svc.sign({
      purpose: 'unsubscribe',
      subscriptionId: 'sub_1',
      address: 'GABC123',
      email: 'user@example.com',
      ttlMs: -1,
    });
    expect(svc.verify(expired)).toBeNull();

    const unsupportedPurpose = encode(
      {
        purpose: 'verify' as any,
        subscriptionId: 'sub_1',
        address: 'GABC123',
        email: 'user@example.com',
        issuedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_060_000,
      },
      'test-secret',
    );
    const body = unsupportedPurpose.split('.')[0];
    const tamperedBody = Buffer.from(
      JSON.stringify({
        purpose: 'unknown',
        subscriptionId: 'sub_1',
        address: 'GABC123',
        email: 'user@example.com',
        issuedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_060_000,
      }),
      'utf8',
    ).toString('base64url');
    const signature = createHmac('sha256', 'test-secret').update(tamperedBody).digest('base64url');
    expect(svc.verify(`${tamperedBody}.${signature}`)).toBeNull();
    expect(body).toBeTruthy();
  });
});

