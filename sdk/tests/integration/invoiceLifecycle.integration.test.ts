/**
 * End-to-end integration test for the invoice lifecycle against Stellar testnet.
 *
 * Verifies that the SDK's XDR encoding, contract addresses and signing flows
 * work against real Soroban: submit an invoice, fund it with the LP keypair,
 * mark it paid, and assert every state transition matches expected values.
 *
 * The test cleans up after itself by cancelling any invoice it leaves unpaid.
 */

import { Account, Keypair } from "@stellar/stellar-sdk";
import { ILNClient } from "../../src/client.js";
import { submitInvoice } from "../../src/methods/submitInvoice.js";
import { fundInvoice } from "../../src/methods/fundInvoice.js";
import { markPaid } from "../../src/methods/markPaid.js";
import { cancelInvoice } from "../../src/methods/cancelInvoice.js";
import { getInvoice } from "../../src/methods/queries.js";
import {
  NETWORK_PASSPHRASE,
  fundWithFriendbot,
  hasIntegrationSecrets,
  keypairSignTx,
  requireSecret,
  testnetServer,
} from "./setup.js";

// Testnet USDC SAC address
const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

// Skip the entire suite locally when secrets are absent; CI provides them.
const describeOrSkip = hasIntegrationSecrets() ? describe : describe.skip;

describeOrSkip("invoice lifecycle (testnet)", () => {
  const server = testnetServer();
  const contractId = ILNClient.testnet().contractId;

  const submitter = hasIntegrationSecrets()
    ? Keypair.fromSecret(requireSecret("TEST_SUBMITTER_SECRET"))
    : (null as unknown as Keypair);
  const lp = hasIntegrationSecrets()
    ? Keypair.fromSecret(requireSecret("TEST_LP_SECRET"))
    : (null as unknown as Keypair);

  const signAsSubmitter = keypairSignTx(submitter, server);
  const signAsLp = keypairSignTx(lp, server);

  let invoiceId: bigint | undefined;

  beforeAll(async () => {
    await Promise.all([
      fundWithFriendbot(submitter.publicKey()),
      fundWithFriendbot(lp.publicKey()),
    ]);
  }, 60_000);

  afterAll(async () => {
    // Clean up: cancel the invoice if it never reached a paid/funded terminal state.
    if (invoiceId === undefined) return;
    try {
      const submitterAccount = await server.getAccount(submitter.publicKey());
      const acc = new Account(submitter.publicKey(), submitterAccount.sequenceNumber());
      const invoice = await getInvoice(server, contractId, invoiceId, acc, NETWORK_PASSPHRASE);
      if (invoice.status === "Pending") {
        await cancelInvoice(server, contractId, invoiceId, acc, signAsSubmitter, NETWORK_PASSPHRASE);
      }
    } catch {
      // Best-effort cleanup — never fail the suite on teardown.
    }
  }, 120_000);

  it("submits, funds and marks an invoice paid", async () => {
    const submitterRaw = await server.getAccount(submitter.publicKey());
    const submitterAccount = new Account(submitter.publicKey(), submitterRaw.sequenceNumber());

    const dueDate = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    const submitRes = await submitInvoice(
      server,
      contractId,
      {
        payer: lp.publicKey(),
        amount: 1_000_000n,
        token: USDC_SAC,
        discountRate: 300,
        dueDate,
      },
      submitterAccount,
      signAsSubmitter,
      NETWORK_PASSPHRASE
    );
    invoiceId = submitRes.invoiceId;
    expect(submitRes.txHash).toBeTruthy();

    // State after submit: Pending.
    let invoice = await getInvoice(server, contractId, invoiceId, submitterAccount, NETWORK_PASSPHRASE);
    expect(invoice.status).toBe("Pending");

    // Fund as the LP (fundInvoice manages its own signing via the keypair).
    const lpRaw = await server.getAccount(lp.publicKey());
    const lpAccount = new Account(lp.publicKey(), lpRaw.sequenceNumber());
    await fundInvoice(server, contractId, lp, invoiceId, {}, NETWORK_PASSPHRASE);

    invoice = await getInvoice(server, contractId, invoiceId, lpAccount, NETWORK_PASSPHRASE);
    expect(invoice.status).toBe("Funded");

    // Mark paid in full as the payer.
    const payRes = await markPaid(server, contractId, invoiceId, undefined, lpAccount, signAsLp, NETWORK_PASSPHRASE);
    expect(payRes.fullySettled).toBe(true);

    invoice = await getInvoice(server, contractId, invoiceId, lpAccount, NETWORK_PASSPHRASE);
    expect(invoice.status).toBe("Paid");

    // Invoice reached a terminal paid state — nothing for cleanup to cancel.
    invoiceId = undefined;
  }, 300_000);
});
