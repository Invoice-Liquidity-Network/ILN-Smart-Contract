import { Account, Keypair, Horizon, SorobanRpc } from "@stellar/stellar-sdk";
import { ILNClient } from "../../sdk/src/client.js";
import { submitInvoice } from "../../sdk/src/methods/submitInvoice.js";
import { fundInvoice } from "../../sdk/src/methods/fundInvoice.js";
import { markPaid } from "../../sdk/src/methods/markPaid.js";
import { getInvoice } from "../../sdk/src/methods/queries.js";
import { subscribe } from "../../sdk/src/events/subscribe.js";
import { createApp } from "../../indexer/src/app.js";
import { getDb } from "../../indexer/src/database/db.js";
import { initializeSchema } from "../../indexer/src/database/schema.js";
import request from "supertest";
import type Database from "better-sqlite3";
import type { Server } from "http";

const TEST_SUBMITTER_SECRET = process.env.TEST_SUBMITTER_SECRET || "SAX33OJKWNZK2KW6F7TNEZ4EEX4MXQ4P6V7T2JZ4W6XAJXN3NKCBJQPL";
const TEST_LP_SECRET = process.env.TEST_LP_SECRET || "SCD2Q6M76VFLHNHDNROENMX7PJ5OBYBMVPM73S4M6XAJXN3NKCBJQPL";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const RPC_URL = "https://soroban-testnet.stellar.org";
const CONTRACT_ID = "CD2Q6M76VFLHNHDNROENMX7PJ5OBYBMVPM73S4M6XAJXN3NKCBJQPLUC";

describe("E2E - Full Invoice Lifecycle", () => {
  let db: Database.Database;
  let appServer: Server;
  let unsubscribeEvents: () => void;
  const horizon = new Horizon.Server(HORIZON_URL);
  const server = new SorobanRpc.Server(RPC_URL);

  const submitter = Keypair.fromSecret(TEST_SUBMITTER_SECRET);
  const lp = Keypair.fromSecret(TEST_LP_SECRET);

  beforeAll(async () => {
    // Start indexer database and app
    db = getDb(":memory:");
    initializeSchema(db);
    const app = createApp(db);
    appServer = app.listen(3001);

    // Set up mock subscription that writes to SQLite to simulate indexer database updates
    unsubscribeEvents = subscribe(
      horizon,
      CONTRACT_ID,
      {},
      (event) => {
        try {
          if (event.type === "submitted") {
            db.prepare(
              `INSERT INTO invoices (id, freelancer, payer, token, amount, due_date, discount_rate, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
              Number(event.invoiceId),
              event.freelancer,
              event.payer,
              event.token,
              String(event.amount),
              Number(event.dueDate),
              event.discountRate,
              "Pending",
              Math.floor(Date.now() / 1000)
            );
            db.prepare(
              `INSERT INTO events (invoice_id, event_type, ledger, timestamp, data)
               VALUES (?, ?, ?, ?, ?)`
            ).run(Number(event.invoiceId), "submitted", 100, Math.floor(Date.now() / 1000), JSON.stringify(event));
          } else if (event.type === "funded") {
            db.prepare(
              `UPDATE invoices
               SET status = 'Funded', funder = ?, funded_at = ?, amount_funded = ?
               WHERE id = ?`
            ).run(event.funder, Math.floor(Date.now() / 1000), String(event.amountFunded), Number(event.invoiceId));
            db.prepare(
              `INSERT INTO events (invoice_id, event_type, ledger, timestamp, data)
               VALUES (?, ?, ?, ?, ?)`
            ).run(Number(event.invoiceId), "funded", 100, Math.floor(Date.now() / 1000), JSON.stringify(event));
          } else if (event.type === "paid") {
            db.prepare(
              `UPDATE invoices
               SET status = 'Paid', amount_paid = ?
               WHERE id = ?`
            ).run(String(event.amountPaid), Number(event.invoiceId));
            db.prepare(
              `INSERT INTO events (invoice_id, event_type, ledger, timestamp, data)
               VALUES (?, ?, ?, ?, ?)`
            ).run(Number(event.invoiceId), "paid", 100, Math.floor(Date.now() / 1000), JSON.stringify(event));
          }
        } catch (err) {
          console.error("Error processing contract event:", err);
        }
      }
    );
  }, 10000);

  afterAll((done) => {
    if (unsubscribeEvents) unsubscribeEvents();
    if (db) db.close();
    if (appServer) appServer.close(done);
    else done();
  });

  it("should successfully execute full invoice lifecycle and update indexer", async () => {
    // This test runs only when integration secrets are provided
    if (!process.env.TEST_SUBMITTER_SECRET || !process.env.TEST_LP_SECRET) {
      console.log("Skipping E2E lifecycle test because TEST_SUBMITTER_SECRET or TEST_LP_SECRET is missing");
      return;
    }

    const client = ILNClient.custom({
      rpcUrl: RPC_URL,
      networkPassphrase: NETWORK_PASSPHRASE,
      contractId: CONTRACT_ID,
    });

    const submitterRaw = await server.getAccount(submitter.publicKey());
    const submitterAccount = new Account(submitter.publicKey(), submitterRaw.sequenceNumber());

    // 1. Submit Invoice
    const dueDate = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    const submitRes = await submitInvoice(
      server,
      CONTRACT_ID,
      {
        payer: lp.publicKey(),
        amount: 1000000n,
        token: "USDC",
        discountRate: 300,
        dueDate,
      },
      submitterAccount,
      async (tx) => {
        const prepared = await server.prepareTransaction(tx);
        prepared.sign(submitter);
        return prepared;
      },
      NETWORK_PASSPHRASE
    );

    const invoiceId = submitRes.invoiceId;
    expect(invoiceId).toBeDefined();

    // Verify status via SDK
    let invoice = await getInvoice(server, CONTRACT_ID, invoiceId, submitterAccount, NETWORK_PASSPHRASE);
    expect(invoice.status).toBe("Pending");

    // Wait up to 10 seconds for indexer reflection
    await new Promise((resolve) => setTimeout(resolve, 8000));
    let indexerRes = await request("http://localhost:3001").get(`/invoices/${invoiceId}`);
    expect(indexerRes.status).toBe(200);
    expect(indexerRes.body.status).toBe("Pending");

    // 2. Fund Invoice
    const lpRaw = await server.getAccount(lp.publicKey());
    const lpAccount = new Account(lp.publicKey(), lpRaw.sequenceNumber());
    await fundInvoice(server, CONTRACT_ID, lp, invoiceId, {}, NETWORK_PASSPHRASE);

    // Verify status via SDK
    invoice = await getInvoice(server, CONTRACT_ID, invoiceId, lpAccount, NETWORK_PASSPHRASE);
    expect(invoice.status).toBe("Funded");

    // Wait for indexer reflection
    await new Promise((resolve) => setTimeout(resolve, 8000));
    indexerRes = await request("http://localhost:3001").get(`/invoices/${invoiceId}`);
    expect(indexerRes.body.status).toBe("Funded");

    // 3. Pay Invoice
    await markPaid(
      server,
      CONTRACT_ID,
      invoiceId,
      undefined,
      lpAccount,
      async (tx) => {
        const prepared = await server.prepareTransaction(tx);
        prepared.sign(lp);
        return prepared;
      },
      NETWORK_PASSPHRASE
    );

    // Verify status via SDK
    invoice = await getInvoice(server, CONTRACT_ID, invoiceId, lpAccount, NETWORK_PASSPHRASE);
    expect(invoice.status).toBe("Paid");

    // Wait for indexer reflection
    await new Promise((resolve) => setTimeout(resolve, 8000));
    indexerRes = await request("http://localhost:3001").get(`/invoices/${invoiceId}`);
    expect(indexerRes.body.status).toBe("Paid");
  }, 240000);
});
