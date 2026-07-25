import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  clearAnalyticsCache,
  getDisputeRateTrend,
  getTokenMarketShare,
  getTopLPsByEarnings,
  getYieldTrend,
} from '../src/services/analyticsService.js';
import {
  createTestApp,
  createTestDb,
  seedEvent,
  seedInvoice,
} from './helpers.js';

function daysAgo(days: number): number {
  return Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
}

describe('analyticsService', () => {
  let db: ReturnType<typeof createTestDb>;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    clearAnalyticsCache();
    db = createTestDb();
    app = createTestApp(db);
  });

  afterEach(() => {
    db.close();
  });

  it('computes daily yield trend for paid invoices', () => {
    seedInvoice(db, {
      id: 1,
      status: 'Paid',
      funder: 'LP_A',
      amount_funded: '1000',
      amount_paid: '1100',
      created_at: daysAgo(10),
    });
    seedInvoice(db, {
      id: 2,
      status: 'Paid',
      funder: 'LP_B',
      amount_funded: '2000',
      amount_paid: '2400',
      created_at: daysAgo(9),
    });
    seedInvoice(db, {
      id: 3,
      status: 'Paid',
      funder: 'LP_C',
      amount_funded: '1500',
      amount_paid: '1575',
      created_at: daysAgo(9),
    });

    seedEvent(db, { invoice_id: 1, event_type: 'InvoicePaid', timestamp: daysAgo(7) });
    seedEvent(db, { invoice_id: 2, event_type: 'InvoicePaid', timestamp: daysAgo(6) });
    seedEvent(db, { invoice_id: 3, event_type: 'InvoicePaid', timestamp: daysAgo(6) });

    const trend = getYieldTrend(db, 30);

    expect(trend).toHaveLength(2);
    expect(trend[0]).toMatchObject({ averageEffectiveYield: 10 });
    expect(trend[1]).toMatchObject({ averageEffectiveYield: 12.5 });
  });

  it('computes weekly dispute rate trend from invoice cohorts', () => {
    seedInvoice(db, { id: 1, status: 'Disputed', created_at: daysAgo(20) });
    seedInvoice(db, { id: 2, status: 'Paid', created_at: daysAgo(20) });
    seedInvoice(db, { id: 3, status: 'Paid', created_at: daysAgo(8) });
    seedInvoice(db, { id: 4, status: 'Disputed', created_at: daysAgo(8) });
    seedInvoice(db, { id: 5, status: 'Disputed', created_at: daysAgo(8) });

    const trend = getDisputeRateTrend(db, 30);

    expect(trend).toHaveLength(2);
    expect(trend[0]).toMatchObject({ disputedInvoices: 1, totalInvoices: 2, disputeRate: 0.5 });
    expect(trend[1]).toMatchObject({ disputedInvoices: 2, totalInvoices: 3, disputeRate: 0.666667 });
  });

  it('computes token market share by settled volume', () => {
    seedInvoice(db, { id: 1, status: 'Paid', token: 'USDC', amount_paid: '3000' });
    seedInvoice(db, { id: 2, status: 'Paid', token: 'EURC', amount_paid: '1000' });
    seedInvoice(db, { id: 3, status: 'Paid', token: 'USDC', amount_paid: '1000' });

    const shares = getTokenMarketShare(db);

    expect(shares).toEqual([
      { token: 'USDC', volume: '4000', share: 0.8 },
      { token: 'EURC', volume: '1000', share: 0.2 },
    ]);
  });

  it('computes top LPs by earnings', () => {
    seedInvoice(db, {
      id: 1,
      status: 'Paid',
      funder: 'LP_ALPHA',
      amount_funded: '1000',
      amount_paid: '1100',
    });
    seedInvoice(db, {
      id: 2,
      status: 'Paid',
      funder: 'LP_ALPHA',
      amount_funded: '2000',
      amount_paid: '2500',
    });
    seedInvoice(db, {
      id: 3,
      status: 'Paid',
      funder: 'LP_BETA',
      amount_funded: '5000',
      amount_paid: '5200',
    });
    seedInvoice(db, {
      id: 4,
      status: 'Funded',
      funder: 'LP_GAMMA',
      amount_funded: '9000',
      amount_paid: '0',
    });

    const earnings = getTopLPsByEarnings(db, 2);

    expect(earnings).toEqual([
      {
        lp: 'LP_ALPHA',
        earnings: '600',
        fundedVolume: '3000',
        settledVolume: '3600',
      },
      {
        lp: 'LP_BETA',
        earnings: '200',
        fundedVolume: '5000',
        settledVolume: '5200',
      },
    ]);
  });

  it('serves analytics from /stats/analytics', async () => {
    seedInvoice(db, {
      id: 1,
      status: 'Paid',
      token: 'USDC',
      funder: 'LP_ALPHA',
      amount_funded: '1000',
      amount_paid: '1100',
      created_at: daysAgo(12),
    });
    seedInvoice(db, {
      id: 2,
      status: 'Disputed',
      token: 'EURC',
      amount_funded: '500',
      amount_paid: '0',
      created_at: daysAgo(5),
    });
    seedEvent(db, { invoice_id: 1, event_type: 'InvoicePaid', timestamp: daysAgo(4) });

    const res = await request(app).get('/stats/analytics?limit=1');

    expect(res.status).toBe(200);
    expect(res.body.lastUpdatedAt).toBeTypeOf('number');
    expect(res.body.yieldTrend30d).toHaveLength(1);
    expect(res.body.disputeRateTrend30d.length).toBeGreaterThan(0);
    expect(res.body.tokenMarketShare).toEqual([{ token: 'USDC', volume: '1100', share: 1 }]);
    expect(res.body.topLPsByEarnings).toEqual([
      {
        lp: 'LP_ALPHA',
        earnings: '100',
        fundedVolume: '1000',
        settledVolume: '1100',
      },
    ]);
  });

  it('rejects invalid analytics limit', async () => {
    const res = await request(app).get('/stats/analytics?limit=0');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid limit');
  });
});
