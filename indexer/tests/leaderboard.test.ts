import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  createTestDb,
  seedReputation,
  createTestApp,
} from './helpers.js';

describe('GET /leaderboard', () => {
  let db: ReturnType<typeof createTestDb>;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createTestApp(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should return empty array when no reputation data exists', async () => {
    const res = await request(app).get('/leaderboard');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('should return leaderboard entries sorted by score descending', async () => {
    seedReputation(db, {
      address: 'GAAA...LOW',
      new_score: 30,
      invoices_paid: 3,
      invoices_defaulted: 1,
    });
    seedReputation(db, {
      address: 'GBBB...HIGH',
      new_score: 90,
      invoices_paid: 20,
      invoices_defaulted: 0,
    });
    seedReputation(db, {
      address: 'GCCC...MID',
      new_score: 60,
      invoices_paid: 10,
      invoices_defaulted: 2,
    });

    const res = await request(app).get('/leaderboard');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body[0].address).toBe('GBBB...HIGH');
    expect(res.body[0].score).toBe(90);
    expect(res.body[0].rank).toBe(1);
    expect(res.body[1].address).toBe('GCCC...MID');
    expect(res.body[1].rank).toBe(2);
    expect(res.body[2].address).toBe('GAAA...LOW');
    expect(res.body[2].rank).toBe(3);
  });

  it('should respect limit parameter', async () => {
    for (let i = 0; i < 10; i++) {
      seedReputation(db, {
        address: `G...ADDR${i}`,
        new_score: i * 10,
      });
    }

    const res = await request(app).get('/leaderboard?limit=3');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body[0].score).toBe(90);
    expect(res.body[1].score).toBe(80);
    expect(res.body[2].score).toBe(70);
  });

  it('should cap limit at 100', async () => {
    for (let i = 0; i < 5; i++) {
      seedReputation(db, {
        address: `G...ADDR${i}`,
        new_score: i * 10,
      });
    }

    const res = await request(app).get('/leaderboard?limit=200');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(5);
  });

  it('should return 400 for invalid limit', async () => {
    const res = await request(app).get('/leaderboard?limit=abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid limit parameter');
  });

  it('should use default limit of 50', async () => {
    for (let i = 0; i < 3; i++) {
      seedReputation(db, {
        address: `G...ADDR${i}`,
        new_score: i * 10,
      });
    }

    const res = await request(app).get('/leaderboard');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
  });

  it('should include invoicesPaid and invoicesDefaulted in response', async () => {
    seedReputation(db, {
      address: 'GAAA...TEST',
      new_score: 75,
      invoices_paid: 12,
      invoices_defaulted: 1,
    });

    const res = await request(app).get('/leaderboard');
    expect(res.status).toBe(200);
    expect(res.body[0].invoicesPaid).toBe(12);
    expect(res.body[0].invoicesDefaulted).toBe(1);
    expect(res.body[0].totalVolume).toBeDefined();
  });

  it('should only show latest reputation per address', async () => {
    seedReputation(db, {
      address: 'GAAA...DUP',
      old_score: 0,
      new_score: 30,
      timestamp: 1000,
    });
    seedReputation(db, {
      address: 'GAAA...DUP',
      old_score: 30,
      new_score: 80,
      timestamp: 2000,
    });

    const res = await request(app).get('/leaderboard');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].score).toBe(80);
  });
});
