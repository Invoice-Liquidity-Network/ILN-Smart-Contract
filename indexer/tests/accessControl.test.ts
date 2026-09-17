import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { createApp } from '../src/app.js';

describe('indexer access control', () => {
  const db = {} as Database.Database;

  it('rate limits public requests after 100 per minute per IP', async () => {
    const app = createApp(db);

    for (let i = 0; i < 100; i += 1) {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
    }

    const rateLimitedResponse = await request(app).get('/health');
    expect(rateLimitedResponse.status).toBe(429);
    expect(rateLimitedResponse.headers['retry-after']).toBeDefined();
    expect(rateLimitedResponse.body.error).toContain('Too many requests');
  });

  it('accepts a known API key and bypasses rate limiting', async () => {
    const app = createApp(db, { apiKeys: ['known-client-key'] });

    for (let i = 0; i < 101; i += 1) {
      const res = await request(app)
        .get('/health')
        .set('X-API-Key', 'known-client-key');

      expect(res.status).toBe(200);
    }
  });

  it('rejects an unknown API key', async () => {
    const app = createApp(db, { apiKeys: ['known-client-key'] });

    const res = await request(app)
      .get('/health')
      .set('X-API-Key', 'wrong-key');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid API key');
  });
});
