import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { RetryQueue } from '../src/queue/retryQueue';

describe('RetryQueue', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('queues, retries, and marks delivery logs', () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const db = new Database(':memory:');
    db.exec('CREATE TABLE subscriptions (id TEXT PRIMARY KEY)');
    db.exec("INSERT INTO subscriptions (id) VALUES ('webhook_1')");
    const queue = new RetryQueue(db);

    const log = queue.enqueue('webhook_1', 'invoice.funded', 42, { hello: 'world' });
    expect(log.status).toBe('pending');
    expect(log.attempts).toBe(0);
    expect(queue.getPending()).toHaveLength(1);

    queue.recordFailure(log.id, 'first failure');
    const afterFirstFailure = queue.get(log.id)!;
    expect(afterFirstFailure.status).toBe('pending');
    expect(afterFirstFailure.attempts).toBe(1);
    expect(afterFirstFailure.lastError).toBe('first failure');
    expect(afterFirstFailure.nextRetryAt).toBe(now + 1000);

    now += 1000;
    expect(queue.getPending()).toHaveLength(1);

    queue.recordFailure(log.id, 'second failure');
    const afterSecondFailure = queue.get(log.id)!;
    expect(afterSecondFailure.attempts).toBe(2);
    expect(afterSecondFailure.nextRetryAt).toBe(now + 5000);

    now += 5000;
    queue.recordFailure(log.id, 'third failure');
    const failed = queue.get(log.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.attempts).toBe(3);
    expect(failed.nextRetryAt).toBe(now);

    queue.recordSkipped(log.id, 'circuit_open');
    const skipped = queue.get(log.id)!;
    expect(skipped.status).toBe('skipped');
    expect(skipped.lastError).toBe('circuit_open');

    queue.recordSuccess(log.id);
    const delivered = queue.get(log.id)!;
    expect(delivered.status).toBe('delivered');

    db.close();
  });

  it('returns undefined for missing logs and ignores missing updates', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE subscriptions (id TEXT PRIMARY KEY)');
    const queue = new RetryQueue(db);

    expect(queue.get(999)).toBeUndefined();
    expect(queue.getPending()).toEqual([]);

    expect(() => queue.recordSuccess(999)).not.toThrow();
    expect(() => queue.recordFailure(999, 'boom')).not.toThrow();
    expect(() => queue.recordSkipped(999, 'skip')).not.toThrow();

    db.close();
  });
});
