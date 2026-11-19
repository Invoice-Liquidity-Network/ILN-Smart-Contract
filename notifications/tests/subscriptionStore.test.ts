import { describe, expect, it } from 'vitest';
import { SubscriptionStore } from '../src/subscriptions/subscriptionStore';

describe('SubscriptionStore', () => {
  it('creates and lists subscriptions', () => {
    const s = new SubscriptionStore();
    const a = s.create({ endpointId: 'e1', url: 'https://x', secret: 'k', eventTypes: ['A'] });
    const b = s.create({ endpointId: 'e2', url: 'https://y', secret: 'k', eventTypes: ['B'] });
    expect(s.list()).toHaveLength(2);
    expect(s.get(a.id)).toEqual(a);
    expect(s.get(b.id)?.eventTypes).toEqual(['B']);
  });

  it('updates fields when provided', () => {
    const s = new SubscriptionStore();
    const sub = s.create({ endpointId: 'e1', url: 'https://x', secret: 'k', eventTypes: ['A'] });
    const updated = s.update(sub.id, { url: 'https://z', eventTypes: ['A', 'B'] });
    expect(updated?.url).toBe('https://z');
    expect(updated?.eventTypes).toEqual(['A', 'B']);
  });

  it('returns undefined when updating a missing subscription', () => {
    const s = new SubscriptionStore();
    expect(s.update('nope', { url: 'x' })).toBeUndefined();
  });

  it('deletes subscriptions', () => {
    const s = new SubscriptionStore();
    const sub = s.create({ endpointId: 'e1', url: 'https://x', secret: 'k', eventTypes: ['A'] });
    expect(s.delete(sub.id)).toBe(true);
    expect(s.delete(sub.id)).toBe(false);
    expect(s.get(sub.id)).toBeUndefined();
  });
});
