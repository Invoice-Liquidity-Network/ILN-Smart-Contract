import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  createTestDb,
  seedReputation,
  createTestApp,
} from './helpers.js';

describe('GET /reputation/:address', () => {
  let db: ReturnType<typeof createTestDb>;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createTestApp(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should return zero-score result for unknown address', async () => {
    const res = await request(app).get('/reputation/GUNKNOWN...ADDRESS');
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(0);
    expect(res.body.invoicesPaid).toBe(0);
    expect(res.body.invoicesDefaulted).toBe(0);
    expect(res.body.invoicesSubmitted).toBe(0);
    expect(res.body.lastActivityLedger).toBe(0);
    expect(res.body.history).toEqual([]);
  });

  it('should return reputation profile for known address', async () => {
    seedReputation(db, {
      address: 'GAAA...USER',
      old_score: 0,
      new_score: 50,
      invoices_submitted: 5,
      invoices_paid: 3,
      invoices_defaulted: 1,
      ledger: 500,
      timestamp: 1700000000,
    });

    const res = await request(app).get('/reputation/GAAA...USER');
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(50);
    expect(res.body.invoicesPaid).toBe(3);
    expect(res.body.invoicesDefaulted).toBe(1);
    expect(res.body.invoicesSubmitted).toBe(5);
    expect(res.body.lastActivityLedger).toBe(500);
  });

  it('should return score history', async () => {
    seedReputation(db, {
      address: 'GAAA...USER',
      old_score: 0,
      new_score: 20,
      ledger: 100,
      timestamp: 1700000000,
    });
    seedReputation(db, {
      address: 'GAAA...USER',
      old_score: 20,
      new_score: 50,
      ledger: 200,
      timestamp: 1700100000,
    });
    seedReputation(db, {
      address: 'GAAA...USER',
      old_score: 50,
      new_score: 80,
      ledger: 300,
      timestamp: 1700200000,
    });

    const res = await request(app).get('/reputation/GAAA...USER');
    expect(res.status).toBe(200);
    expect(res.body.history).toHaveLength(3);
    expect(res.body.history[0].score).toBe(20);
    expect(res.body.history[0].ledger).toBe(100);
    expect(res.body.history[1].score).toBe(50);
    expect(res.body.history[2].score).toBe(80);
  });

  it('should filter history by 30d period', async () => {
    const now = Math.floor(Date.now() / 1000);

    seedReputation(db, {
      address: 'GAAA...USER',
      old_score: 0,
      new_score: 20,
      ledger: 100,
      timestamp: now - 60 * 24 * 60 * 60,
    });
    seedReputation(db, {
      address: 'GAAA...USER',
      old_score: 20,
      new_score: 50,
      ledger: 200,
      timestamp: now - 10 * 24 * 60 * 60,
    });
    seedReputation(db, {
      address: 'GAAA...USER',
      old_score: 50,
      new_score: 80,
      ledger: 300,
      timestamp: now - 2 * 24 * 60 * 60,
    });

    const res = await request(app).get('/reputation/GAAA...USER?historyPeriod=30d');
    expect(res.status).toBe(200);
    expect(res.body.history).toHaveLength(2);
    expect(res.body.history[0].score).toBe(50);
    expect(res.body.history[1].score).toBe(80);
  });

  it('should filter history by 90d period', async () => {
    const now = Math.floor(Date.now() / 1000);

    seedReputation(db, {
      address: 'GAAA...USER',
      old_score: 0,
      new_score: 20,
      ledger: 100,
      timestamp: now - 100 * 24 * 60 * 60,
    });
    seedReputation(db, {
      address: 'GAAA...USER',
      old_score: 20,
      new_score: 50,
      ledger: 200,
      timestamp: now - 50 * 24 * 60 * 60,
    });

    const res = await request(app).get('/reputation/GAAA...USER?historyPeriod=90d');
    expect(res.status).toBe(200);
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0].score).toBe(50);
  });

  it('should return all history by default', async () => {
    seedReputation(db, {
      address: 'GAAA...USER',
      old_score: 0,
      new_score: 20,
      ledger: 100,
      timestamp: 1700000000,
    });
    seedReputation(db, {
      address: 'GAAA...USER',
      old_score: 20,
      new_score: 50,
      ledger: 200,
      timestamp: 1700100000,
    });

    const res = await request(app).get('/reputation/GAAA...USER?historyPeriod=all');
    expect(res.status).toBe(200);
    expect(res.body.history).toHaveLength(2);
  });

  it('should return latest score for multiple updates', async () => {
    seedReputation(db, {
      address: 'GAAA...USER',
      old_score: 0,
      new_score: 30,
      ledger: 100,
    });
    seedReputation(db, {
      address: 'GAAA...USER',
      old_score: 30,
      new_score: 70,
      ledger: 200,
    });

    const res = await request(app).get('/reputation/GAAA...USER');
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(70);
    expect(res.body.lastActivityLedger).toBe(200);
  });

  it('should handle separate addresses independently', async () => {
    seedReputation(db, {
      address: 'GAAA...USER1',
      new_score: 50,
      invoices_paid: 5,
    });
    seedReputation(db, {
      address: 'GBBB...USER2',
      new_score: 80,
      invoices_paid: 10,
    });

    const res1 = await request(app).get('/reputation/GAAA...USER1');
    expect(res1.body.score).toBe(50);
    expect(res1.body.invoicesPaid).toBe(5);

    const res2 = await request(app).get('/reputation/GBBB...USER2');
    expect(res2.body.score).toBe(80);
    expect(res2.body.invoicesPaid).toBe(10);
  });
});
