import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  createTestDb,
  seedInvoice,
  seedStatsHistory,
  createTestApp,
} from './helpers.js';
import { clearStatsCache } from '../src/services/statsService.js';

describe('GET /stats', () => {
  let db: ReturnType<typeof createTestDb>;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    clearStatsCache();
    db = createTestDb();
    app = createTestApp(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should return zero stats when no invoices exist', async () => {
    const res = await request(app).get('/stats');
    expect(res.status).toBe(200);
    expect(res.body.totalInvoices).toBe(0);
    expect(res.body.totalFunded).toBe(0);
    expect(res.body.totalPaid).toBe(0);
    expect(res.body.totalCancelled).toBe(0);
    expect(res.body.totalExpired).toBe(0);
    expect(res.body.totalDisputed).toBe(0);
    expect(res.body.volumeByToken).toEqual({});
    expect(res.body.avgDiscountRateBps).toBe(0);
    expect(res.body.disputeRate).toBe(0);
    expect(res.body.lastUpdatedAt).toBeDefined();
  });

  it('should compute correct counts', async () => {
    seedInvoice(db, { id: 1, status: 'Pending', token: 'USDC', discount_rate: 300, amount_paid: '0' });
    seedInvoice(db, { id: 2, status: 'Funded', token: 'USDC', discount_rate: 400, amount_paid: '0' });
    seedInvoice(db, { id: 3, status: 'Paid', token: 'USDC', discount_rate: 500, amount_paid: '1000000' });
    seedInvoice(db, { id: 4, status: 'Cancelled', token: 'USDC', discount_rate: 350, amount_paid: '0' });
    seedInvoice(db, { id: 5, status: 'Expired', token: 'USDC', discount_rate: 600, amount_paid: '0' });
    seedInvoice(db, { id: 6, status: 'Disputed', token: 'USDC', discount_rate: 250, amount_paid: '0' });
    seedInvoice(db, { id: 7, status: 'Paid', token: 'EURC', discount_rate: 450, amount_paid: '2000000' });

    const res = await request(app).get('/stats');
    expect(res.status).toBe(200);
    expect(res.body.totalInvoices).toBe(7);
    expect(res.body.totalFunded).toBe(3);
    expect(res.body.totalPaid).toBe(2);
    expect(res.body.totalCancelled).toBe(1);
    expect(res.body.totalExpired).toBe(1);
    expect(res.body.totalDisputed).toBe(1);
    expect(res.body.avgDiscountRateBps).toBe(407);
  });

  it('should compute dispute rate correctly', async () => {
    seedInvoice(db, { id: 1, status: 'Paid', discount_rate: 500, amount_paid: '1000' });
    seedInvoice(db, { id: 2, status: 'Paid', discount_rate: 500, amount_paid: '1000' });
    seedInvoice(db, { id: 3, status: 'Disputed', discount_rate: 500, amount_paid: '0' });

    const res = await request(app).get('/stats');
    expect(res.status).toBe(200);
    expect(res.body.disputeRate).toBeCloseTo(0.3333, 3);
  });

  it('should compute volume by token', async () => {
    seedInvoice(db, { id: 1, status: 'Paid', token: 'USDC', amount_paid: '1000000' });
    seedInvoice(db, { id: 2, status: 'Paid', token: 'USDC', amount_paid: '2000000' });
    seedInvoice(db, { id: 3, status: 'Paid', token: 'EURC', amount_paid: '500000' });

    const res = await request(app).get('/stats');
    expect(res.status).toBe(200);
    expect(res.body.volumeByToken).toEqual({
      USDC: '3000000',
      EURC: '500000',
    });
  });

  it('should cache stats and return cached value', async () => {
    seedInvoice(db, { id: 1, status: 'Paid', discount_rate: 500, amount_paid: '1000' });

    const res1 = await request(app).get('/stats');
    const firstUpdatedAt = res1.body.lastUpdatedAt;

    const res2 = await request(app).get('/stats');
    expect(res2.body.lastUpdatedAt).toBe(firstUpdatedAt);
    expect(res2.body.totalInvoices).toBe(1);
  });

  it('should return 400 for invalid period', async () => {
    const res = await request(app).get('/stats/history?period=invalid');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid period');
  });

  it('should return stats history for 30d period', async () => {
    seedStatsHistory(db, { date: '2024-01-10', total_invoices: 5, total_funded: 3, total_paid: 2, total_volume: '1000000' });
    seedStatsHistory(db, { date: '2024-01-15', total_invoices: 10, total_funded: 8, total_paid: 5, total_volume: '3000000' });
    seedStatsHistory(db, { date: '2024-01-20', total_invoices: 15, total_funded: 12, total_paid: 9, total_volume: '5000000' });

    const res = await request(app).get('/stats/history?period=30d');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('should return all stats history when period=all', async () => {
    seedStatsHistory(db, { date: '2023-06-01', total_invoices: 1 });
    seedStatsHistory(db, { date: '2024-01-01', total_invoices: 10 });

    const res = await request(app).get('/stats/history?period=all');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('should include lastUpdatedAt timestamp', async () => {
    const before = Date.now();
    const res = await request(app).get('/stats');
    const after = Date.now();
    expect(res.body.lastUpdatedAt).toBeGreaterThanOrEqual(before);
    expect(res.body.lastUpdatedAt).toBeLessThanOrEqual(after);
  });
});
