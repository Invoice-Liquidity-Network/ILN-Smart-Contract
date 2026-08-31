import { describe, expect, it, vi } from 'vitest';
import { EmailDeliveryService } from '../src/delivery/emailDelivery';

describe('EmailDeliveryService', () => {
  it('returns the provider id on success', async () => {
    const client = { send: vi.fn(async () => ({ id: 'm_1' })) };
    const svc = new EmailDeliveryService(client, 'noreply@iln.dev');
    const res = await svc.send({ to: 'a@b.com', subject: 's', html: '<p>hi</p>' });
    expect(res).toEqual({ ok: true, id: 'm_1' });
    expect(svc.getFrom()).toBe('noreply@iln.dev');
  });

  it('returns an error string on failure', async () => {
    const client = {
      send: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const svc = new EmailDeliveryService(client, 'noreply@iln.dev');
    const res = await svc.send({ to: 'a@b.com', subject: 's', html: '<p>hi</p>' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('boom');
  });

  it('stringifies non-Error rejections', async () => {
    const client = {
      send: vi.fn(async () => {
        throw 'oops';
      }),
    };
    const svc = new EmailDeliveryService(client, 'noreply@iln.dev');
    const res = await svc.send({ to: 'a@b.com', subject: 's', html: '<p>hi</p>' });
    expect(res.error).toBe('oops');
  });

  it('rate limits per recipient email address', async () => {
    const client = { send: vi.fn(async () => ({ id: 'm_1' })) };
    const svc = new EmailDeliveryService(client, 'noreply@iln.dev', {
      maxRequests: 2,
      windowMs: 1000,
      now: () => 0,
    });

    const msg = { to: 'noisy@example.com', subject: 's', html: '<p>hi</p>' };
    expect((await svc.send(msg)).ok).toBe(true);
    expect((await svc.send(msg)).ok).toBe(true);
    expect((await svc.send(msg))).toEqual({ ok: false, error: 'rate_limited' });

    // A different recipient is unaffected by the noisy one's limit.
    const other = { to: 'quiet@example.com', subject: 's', html: '<p>hi</p>' };
    expect((await svc.send(other)).ok).toBe(true);
    expect((await svc.send(other)).ok).toBe(true);
    expect((await svc.send(other)).ok).toBe(false);

    // 4 sends total: 2 for each recipient; the 5th and 6th were blocked.
    expect(client.send).toHaveBeenCalledTimes(4);
  });

  it('treats the same recipient with different casing as one budget', async () => {
    const client = { send: vi.fn(async () => ({ id: 'm_1' })) };
    const svc = new EmailDeliveryService(client, 'noreply@iln.dev', {
      maxRequests: 1,
      windowMs: 1000,
      now: () => 0,
    });

    expect((await svc.send({ to: 'User@Example.com', subject: 's', html: '<p>a</p>' })).ok).toBe(
      true,
    );
    expect(
      (await svc.send({ to: 'user@example.com', subject: 's', html: '<p>b</p>' })).ok,
    ).toBe(false);
  });
});
