/**
 * Testnet smoke tests for the invoice-lifecycle mutations that
 * `invoiceLifecycle.integration.test.ts` does not exercise:
 *
 *   cancelInvoice, transferInvoice, transferLPPosition, submitInvoicesBatch, disputeInvoice
 *
 * (submitInvoice, fundInvoice and markPaid are covered there.)
 *
 * Every test asserts CONFIRMED on-chain state by re-reading the invoice from the contract
 * after the call, polling until the ledger reflects it. A returned txHash alone never passes.
 * Each mutation also has a negative case: the contract/SDK must refuse the caller who is not
 * authorised, and the refused call must leave chain state unchanged.
 *
 * Requires TEST_SUBMITTER_SECRET and TEST_LP_SECRET (Friendbot-funded, LP holding testnet USDC).
 * Skipped when they are absent. See docs/sdk-mutation-smoke-coverage.md.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { ILNClient } from "../../../src/client.js";
import { cancelInvoice } from "../../../src/methods/cancelInvoice.js";
import { transferInvoice } from "../../../src/methods/transferInvoice.js";
import { transferLPPosition } from "../../../src/methods/transferLPPosition.js";
import { submitInvoicesBatch } from "../../../src/methods/submitInvoicesBatch.js";
import { disputeInvoice } from "../../../src/methods/disputeInvoice.js";
import { KeypairSigner } from "../../../src/signers/KeypairSigner.js";
import {
  NETWORK_PASSPHRASE,
  fundWithFriendbot,
  hasIntegrationSecrets,
  keypairSignTx,
  requireSecret,
  testnetServer,
} from "../setup.js";
import {
  USDC_SAC,
  clientFor,
  freshAccount,
  fundAsLp,
  readInvoice,
  submitPendingInvoice,
  waitForInvoice,
} from "./helpers.js";

const describeOrSkip = hasIntegrationSecrets() ? describe : describe.skip;

describeOrSkip("invoice mutations smoke (testnet)", () => {
  const server = testnetServer();
  const contractId = ILNClient.testnet().contractId;

  const submitter = hasIntegrationSecrets()
    ? Keypair.fromSecret(requireSecret("TEST_SUBMITTER_SECRET"))
    : (null as unknown as Keypair);
  const lp = hasIntegrationSecrets()
    ? Keypair.fromSecret(requireSecret("TEST_LP_SECRET"))
    : (null as unknown as Keypair);

  /** Invoices this suite leaves Pending; cancelled best-effort on teardown. */
  const cleanup: bigint[] = [];

  beforeAll(async () => {
    await Promise.all([
      fundWithFriendbot(submitter.publicKey()),
      fundWithFriendbot(lp.publicKey()),
    ]);
  }, 60_000);

  afterAll(async () => {
    for (const id of cleanup) {
      try {
        const inv = await readInvoice(submitter, id);
        if (inv.status === "Pending" && inv.freelancer === submitter.publicKey()) {
          await cancelInvoice(
            server,
            contractId,
            id,
            await freshAccount(submitter),
            keypairSignTx(submitter, server),
            NETWORK_PASSPHRASE
          );
        }
      } catch {
        // Best-effort cleanup — never fail the suite on teardown.
      }
    }
  }, 180_000);

  it("cancelInvoice: Pending -> Cancelled on chain; a repeat cancel is refused", async () => {
    const id = await submitPendingInvoice(submitter, lp.publicKey());

    const { txHash } = await cancelInvoice(
      server,
      contractId,
      id,
      await freshAccount(submitter),
      keypairSignTx(submitter, server),
      NETWORK_PASSPHRASE
    );
    expect(txHash).toBeTruthy();

    // Confirmed state, not just submission.
    const after = await waitForInvoice(submitter, id, (i) => i.status === "Cancelled", "status=Cancelled");
    expect(after.freelancer).toBe(submitter.publicKey());

    // Repeated: second cancel must be rejected and leave the state untouched.
    await expect(
      cancelInvoice(
        server,
        contractId,
        id,
        await freshAccount(submitter),
        keypairSignTx(submitter, server),
        NETWORK_PASSPHRASE
      )
    ).rejects.toThrow();
    expect((await readInvoice(submitter, id)).status).toBe("Cancelled");
  }, 300_000);

  it("cancelInvoice: a non-submitter cannot cancel and the invoice stays Pending", async () => {
    const id = await submitPendingInvoice(submitter, lp.publicKey());
    cleanup.push(id);

    await expect(
      cancelInvoice(
        server,
        contractId,
        id,
        await freshAccount(lp),
        keypairSignTx(lp, server),
        NETWORK_PASSPHRASE
      )
    ).rejects.toThrow();

    expect((await readInvoice(submitter, id)).status).toBe("Pending");
  }, 300_000);

  it("transferInvoice: freelancer changes on chain; the old owner can no longer transfer it", async () => {
    const id = await submitPendingInvoice(submitter, lp.publicKey());
    const newFreelancer = Keypair.random().publicKey();

    // Unauthorised first: the LP is not the freelancer, so the contract must refuse.
    await expect(transferInvoice(clientFor(lp), id, newFreelancer)).rejects.toThrow();
    expect((await readInvoice(submitter, id)).freelancer).toBe(submitter.publicKey());

    const { txHash } = await transferInvoice(clientFor(submitter), id, newFreelancer);
    expect(txHash).toBeTruthy();

    // transferInvoice returns on PENDING, so poll for the ledger to reflect it.
    const after = await waitForInvoice(
      submitter,
      id,
      (i) => i.freelancer === newFreelancer,
      "freelancer=newFreelancer"
    );
    expect(after.status).toBe("Pending");

    // Stale: the previous owner has lost authority.
    await expect(transferInvoice(clientFor(submitter), id, submitter.publicKey())).rejects.toThrow();
    expect((await readInvoice(submitter, id)).freelancer).toBe(newFreelancer);
  }, 300_000);

  it("transferLPPosition: funder changes on chain; the old LP cannot transfer again", async () => {
    const id = await submitPendingInvoice(submitter, lp.publicKey());
    await fundAsLp(lp, id);
    const newLp = Keypair.random().publicKey();

    // Unauthorised first: only the current LP may move the position.
    await expect(
      transferLPPosition(
        server,
        contractId,
        id,
        newLp,
        await freshAccount(submitter),
        keypairSignTx(submitter, server),
        NETWORK_PASSPHRASE
      )
    ).rejects.toThrow();
    expect((await readInvoice(lp, id)).funder).toBe(lp.publicKey());

    const { txHash } = await transferLPPosition(
      server,
      contractId,
      id,
      newLp,
      await freshAccount(lp),
      keypairSignTx(lp, server),
      NETWORK_PASSPHRASE
    );
    expect(txHash).toBeTruthy();

    const after = await waitForInvoice(lp, id, (i) => i.funder === newLp, "funder=newLp");
    expect(after.status).toBe("Funded");

    // Stale: the old LP no longer owns the position.
    await expect(
      transferLPPosition(
        server,
        contractId,
        id,
        lp.publicKey(),
        await freshAccount(lp),
        keypairSignTx(lp, server),
        NETWORK_PASSPHRASE
      )
    ).rejects.toThrow();
    expect((await readInvoice(lp, id)).funder).toBe(newLp);
  }, 400_000);

  it("submitInvoicesBatch: every item exists on chain as Pending with the submitted terms", async () => {
    const dueDate = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    const items = [1_000_000n, 2_000_000n].map((amount) => ({
      freelancer: submitter.publicKey(),
      payer: lp.publicKey(),
      amount,
      token: USDC_SAC,
      discountRate: 300,
      dueDate,
    }));

    const { invoiceIds, txHash } = await submitInvoicesBatch(clientFor(submitter), items);
    expect(txHash).toBeTruthy();
    expect(invoiceIds).toHaveLength(items.length);
    expect(new Set(invoiceIds).size).toBe(items.length);
    cleanup.push(...invoiceIds);

    for (const [index, id] of invoiceIds.entries()) {
      const onChain = await waitForInvoice(submitter, id, (i) => i.status === "Pending", "status=Pending");
      expect(onChain.freelancer).toBe(submitter.publicKey());
      expect(onChain.payer).toBe(lp.publicKey());
      expect(onChain.amount).toBe(items[index]!.amount);
      expect(onChain.discountRate).toBe(300);
    }
  }, 300_000);

  it("submitInvoicesBatch: an oversized batch is refused before anything is submitted", async () => {
    const dueDate = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    const items = Array.from({ length: 11 }, () => ({
      freelancer: submitter.publicKey(),
      payer: lp.publicKey(),
      amount: 1_000_000n,
      token: USDC_SAC,
      discountRate: 300,
      dueDate,
    }));
    await expect(submitInvoicesBatch(clientFor(submitter), items)).rejects.toThrow();
  }, 60_000);

  it("disputeInvoice: only the payer can dispute; the invoice becomes Disputed on chain", async () => {
    const id = await submitPendingInvoice(submitter, lp.publicKey());
    cleanup.push(id);
    const evidence = `smoke-test dispute ${id}`;

    // Unauthorised: the submitter is not the payer, so the contract must refuse.
    await expect(
      disputeInvoice({
        rpc: server,
        contractAddress: contractId,
        signer: new KeypairSigner(submitter),
        invoiceId: id,
        evidence,
      })
    ).rejects.toThrow();
    expect((await readInvoice(lp, id)).status).toBe("Pending");

    const result = await disputeInvoice({
      rpc: server,
      contractAddress: contractId,
      signer: new KeypairSigner(lp),
      invoiceId: id,
      evidence,
    });
    expect(result.txHash).toBeTruthy();
    expect(result.evidenceHash).toMatch(/^[0-9a-f]{64}$/);

    await waitForInvoice(lp, id, (i) => i.status === "Disputed", "status=Disputed");

    // Repeated: disputing an already-Disputed invoice is refused client-side.
    await expect(
      disputeInvoice({
        rpc: server,
        contractAddress: contractId,
        signer: new KeypairSigner(lp),
        invoiceId: id,
        evidence,
      })
    ).rejects.toThrow();
  }, 300_000);
});
