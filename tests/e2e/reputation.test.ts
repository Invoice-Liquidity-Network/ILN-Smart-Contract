import { createApp } from "../../indexer/src/app.js";
import { getDb } from "../../indexer/src/database/db.js";
import { initializeSchema } from "../../indexer/src/database/schema.js";
import { seedReputation } from "../../indexer/tests/helpers.js";
import request from "supertest";
import type Database from "better-sqlite3";
import type { Server } from "http";

describe("E2E - Reputation System Lifecycle", () => {
  let db: Database.Database;
  let appServer: Server;

  beforeAll(() => {
    db = getDb(":memory:");
    initializeSchema(db);
    const app = createApp(db);
    appServer = app.listen(3002);
  });

  afterAll((done) => {
    if (db) db.close();
    if (appServer) appServer.close(done);
    else done();
  });

  it("should reflect correct score and history for 5 paid invoices", async () => {
    const address = "GBBB...PAYER1";
    seedReputation(db, {
      address,
      old_score: 0,
      new_score: 100,
      invoices_submitted: 5,
      invoices_paid: 5,
      invoices_defaulted: 0,
      ledger: 100,
      timestamp: Math.floor(Date.now() / 1000),
    });

    const res = await request("http://localhost:3002").get(`/reputation/${address}`);
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(100);
    expect(res.body.invoicesPaid).toBe(5);
    expect(res.body.invoicesDefaulted).toBe(0);
  });

  it("should calculate score correctly after 3 submitted and 2 expired", async () => {
    const address = "GBBB...PAYER2";
    seedReputation(db, {
      address,
      old_score: 0,
      new_score: 33,
      invoices_submitted: 3,
      invoices_paid: 1,
      invoices_defaulted: 2,
      ledger: 200,
      timestamp: Math.floor(Date.now() / 1000),
    });

    const res = await request("http://localhost:3002").get(`/reputation/${address}`);
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(33);
    expect(res.body.invoicesSubmitted).toBe(3);
    expect(res.body.invoicesDefaulted).toBe(2);
  });
});
