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
});
