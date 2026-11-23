/**
 * Shared helpers for the mutation smoke suite.
 *
 * A smoke test is only meaningful if it asserts *confirmed* on-chain state.
 * Several SDK mutations (e.g. `transferInvoice`, `transferLPPosition`) return as soon as
 * `sendTransaction` is accepted (status PENDING) and do not wait for ledger inclusion, so
 * a returned `txHash` proves nothing. Tests must therefore poll the contract's read API
 * with {@link waitForInvoice} before asserting.
 */

import { Account, Keypair } from "@stellar/stellar-sdk";
import type { Invoice } from "@invoice-liquidity/types";
import { ILNClient } from "../../../src/client.js";
import { KeypairSigner } from "../../../src/signers/KeypairSigner.js";
import { getInvoice } from "../../../src/methods/queries.js";
import { submitInvoice } from "../../../src/methods/submitInvoice.js";
import { fundInvoice } from "../../../src/methods/fundInvoice.js";
import {
  NETWORK_PASSPHRASE,
  keypairSignTx,
  testnetServer,
} from "../setup.js";

/** Testnet USDC SAC address (same token the lifecycle suite uses). */
export const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

export const POLL_INTERVAL_MS = 2_000;
export const POLL_TIMEOUT_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Build a fresh simulation-source account (sequence number is read live). */
export async function freshAccount(keypair: Keypair): Promise<Account> {
  const raw = await testnetServer().getAccount(keypair.publicKey());
  return new Account(keypair.publicKey(), raw.sequenceNumber());
}

/** An ILNClient on testnet whose signer is `keypair`. */
export function clientFor(keypair: Keypair): ILNClient {
  return ILNClient.testnet(new KeypairSigner(keypair), {
    rpcUrl: process.env["TEST_RPC_URL"],
  });
}

/** Read an invoice from chain using `reader` as the simulation source. */
export async function readInvoice(reader: Keypair, invoiceId: bigint): Promise<Invoice> {
  const server = testnetServer();
  return getInvoice(
    server,
    ILNClient.testnet().contractId,
    invoiceId,
    await freshAccount(reader),
    NETWORK_PASSPHRASE
  );
}

/**
 * Poll the invoice until `predicate` holds, then return it. Throws with the last observed
 * state on timeout so a failing smoke test shows what the chain actually contained.
 */
export async function waitForInvoice(
  reader: Keypair,
  invoiceId: bigint,
  predicate: (invoice: Invoice) => boolean,
  description: string,
  timeoutMs = POLL_TIMEOUT_MS
): Promise<Invoice> {
  const deadline = Date.now() + timeoutMs;
  let last: Invoice | undefined;
  while (Date.now() < deadline) {
    last = await readInvoice(reader, invoiceId);
    if (predicate(last)) return last;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Timed out waiting for invoice ${invoiceId} to satisfy "${description}". ` +
      `Last observed: status=${last?.status} freelancer=${last?.freelancer} funder=${last?.funder}`
  );
}

/** Submit a Pending invoice owned by `submitter` and wait until it is readable on chain. */
export async function submitPendingInvoice(
  submitter: Keypair,
  payer: string,
  amount = 1_000_000n
): Promise<bigint> {
  const server = testnetServer();
  const dueDate = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
  const { invoiceId } = await submitInvoice(
    server,
    ILNClient.testnet().contractId,
    { payer, amount, token: USDC_SAC, discountRate: 300, dueDate },
    await freshAccount(submitter),
    keypairSignTx(submitter, server),
    NETWORK_PASSPHRASE
  );
  await waitForInvoice(submitter, invoiceId, (i) => i.status === "Pending", "status=Pending");
  return invoiceId;
}

/** Fund `invoiceId` in full as `lp` and wait until the chain reports it Funded by `lp`. */
export async function fundAsLp(lp: Keypair, invoiceId: bigint): Promise<void> {
  await fundInvoice(
    testnetServer(),
    ILNClient.testnet().contractId,
    lp,
    invoiceId,
    {},
    NETWORK_PASSPHRASE
  );
  await waitForInvoice(
    lp,
    invoiceId,
    (i) => i.status === "Funded" && i.funder === lp.publicKey(),
    "status=Funded && funder=lp"
  );
}
