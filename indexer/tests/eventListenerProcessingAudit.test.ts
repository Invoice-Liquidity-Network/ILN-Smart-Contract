import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createSqlEventRepository } from '../src/db/eventRepository.js';
import { initializeSchema } from '../src/db/schema.js';
import type {
  DecodedContractEvent,
  HorizonTransactionRecord,
} from '../src/ingestion/eventListener.js';
import { decodeTransactionEventsFromMeta, EventListener } from '../src/ingestion/eventListener.js';

const contractId = 'C_TEST_CONTRACT';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  return db;
}

function createRecord(
  hash: string,
  ledger: number,
  pagingToken: string,
  overrides: Partial<HorizonTransactionRecord> = {}
): HorizonTransactionRecord {
  return {
    hash,
    ledger,
    created_at: '2026-06-29T12:00:00Z',
    paging_token: pagingToken,
    result_meta_xdr: 'not-used-by-injected-decoder',
    ...overrides,
  };
}

function unknownEvent(index: number): DecodedContractEvent {
  return {
    contractId,
    rawEventType: 'future_event',
    contractEventType: 'FutureEvent',
    topics: ['future_event', index],
    data: { index },
  };
}

describe('EventListener transaction processing audit (Issues #1236 and #1237)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps duplicate transactions idempotent without rejecting overlapping event indexes', async () => {
    const db = createTestDb();
    try {
      const repository = createSqlEventRepository(db);
      const first = createRecord('duplicate-hash', 100, '100');
      const later = createRecord('later-hash', 101, '200');
      const listener = new EventListener({
        repository,
        horizonUrl: 'http://horizon.test',
        contractAddress: contractId,
        decodeTransactionEvents: (record) =>
          record.hash === 'duplicate-hash'
            ? [unknownEvent(0), unknownEvent(1), unknownEvent(2)]
            : [unknownEvent(0), unknownEvent(1)],
      });

      await listener.processTransaction(first);
      await listener.processTransaction(later);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await listener.processTransaction(first);
      }

      const events = db
        .prepare('SELECT transaction_hash, event_index FROM events ORDER BY transaction_hash, event_index')
        .all() as Array<{ transaction_hash: string; event_index: number }>;

      expect(events).toHaveLength(5);
      expect(events.filter((event) => event.transaction_hash === 'duplicate-hash')).toHaveLength(3);
      expect(events.filter((event) => event.transaction_hash === 'later-hash')).toHaveLength(2);
      expect(repository.getState('last_processed_cursor')).toBe('200');
      expect(repository.getState('last_processed_ledger')).toBe('101');
    } finally {
      db.close();
    }
  });

  it('stores unknown events and safely preserves events with missing topics', async () => {
    const db = createTestDb();
    try {
      const repository = createSqlEventRepository(db);
      const record = createRecord('unknown-events', 101, '101');
      const listener = new EventListener({
        repository,
        horizonUrl: 'http://horizon.test',
        contractAddress: contractId,
        decodeTransactionEvents: () => [
          unknownEvent(1),
          {
            contractId,
            rawEventType: '',
            contractEventType: '',
            topics: [],
            data: { retained: true },
          },
        ],
      });

      await listener.processTransaction(record);

      const events = db
        .prepare('SELECT event_type, contract_event_type, topics_json FROM events ORDER BY event_index')
        .all() as Array<{ event_type: string; contract_event_type: string; topics_json: string }>;
      expect(events).toEqual([
        { event_type: 'future_event', contract_event_type: 'FutureEvent', topics_json: '["future_event",1]' },
        { event_type: '', contract_event_type: '', topics_json: '[]' },
      ]);
    } finally {
      db.close();
    }
  });

  it('reports malformed result metadata and leaves its cursor unadvanced', async () => {
    const db = createTestDb();
    try {
      const repository = createSqlEventRepository(db);
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const listener = new EventListener({
        repository,
        horizonUrl: 'http://horizon.test',
        contractAddress: contractId,
        logger,
        failOnTransactionError: true,
      });

      await expect(
        listener.processTransaction(
          createRecord('malformed-meta', 102, '102', { result_meta_xdr: 'not-valid-xdr' })
        )
      ).rejects.toThrow();
      expect(repository.getState('last_processed_cursor')).toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('malformed-meta'));
      expect(db.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('does not decode failed transactions but advances the live cursor past them', async () => {
    const db = createTestDb();
    try {
      const repository = createSqlEventRepository(db);
      const decode = vi.fn(() => [unknownEvent(0)]);
      const listener = new EventListener({
        repository,
        horizonUrl: 'http://horizon.test',
        contractAddress: contractId,
        decodeTransactionEvents: decode,
      });

      await listener.processTransaction(
        createRecord('failed-transaction', 103, '103', {
          successful: false,
          result_meta_xdr: 'failed-transactions-need-not-have-decodable-events',
        })
      );

      expect(decode).not.toHaveBeenCalled();
      expect(db.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 0 });
      expect(repository.getState('last_processed_cursor')).toBe('103');
      expect(repository.getState('last_processed_ledger')).toBe('103');
    } finally {
      db.close();
    }
  });

  it('rejects malformed XDR when called through the production metadata decoder', () => {
    expect(() =>
      decodeTransactionEventsFromMeta(
        createRecord('malformed-xdr', 104, '104', { result_meta_xdr: 'not-valid-xdr' })
      )
    ).toThrow();
  });
});
