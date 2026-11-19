// @ts-nocheck
/**
 * joinFundQueue / resolveFundQueue — SDK helpers for the LP priority queue
 * (issue #466).
 *
 * Flow: LPs register interest in funding a pending invoice via
 * `joinFundQueue`, snapshotting their reputation score. Once at least one
 * LP has joined, anyone can call `resolveFundQueue` to lock in the
 * highest-score LP as the approved funder.
 */
import { Contract, SorobanRpc, TransactionBuilder, BASE_FEE, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import type { ILNClient } from "../client.js";
import { ILNError } from "../errors.js";
import { retry } from "../utils/retry.js";

export interface JoinFundQueueResult {
  txHash: string;
}

export interface ResolveFundQueueResult {
  /** The approved LP's address. */
  approvedLp: string;
  txHash: string;
}

/**
 * Register an LP's intent to fund a pending invoice. The LP's current
 * reputation score is snapshotted on-chain for later ordering.
 *
 * Wraps `join_fund_queue(lp, invoice_id)`. Requires the LP's signature —
 * `client.signer` must be `lpAddress`.
 *
 * @param client Configured {@link ILNClient} — `client.signer` must be the LP
 * @param lpAddress The LP's Stellar address (must match `client.signer`)
 * @param invoiceId Invoice to queue for
 * @throws {ILNError.AlreadyInQueue} If this LP already joined the queue for this invoice
 * @throws {ILNError.NotApprovedFunder} If the queue for this invoice has already been resolved
 */
export async function joinFundQueue(
  client: ILNClient,
  lpAddress: string,
  invoiceId: bigint
): Promise<JoinFundQueueResult> {
  if (!client.signer) {
    throw new Error("joinFundQueue requires a client configured with a signer (the LP)");
  }

  const contract = new Contract(client.contractId);
  const op = contract.call(
    "join_fund_queue",
    nativeToScVal(lpAddress, { type: "address" }),
    nativeToScVal(invoiceId, { type: "u64" })
  );

  const account = await retry(() => client.rpc.getAccount(client.signer!.publicKey));
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: client.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await retry(() => client.rpc.simulateTransaction(tx));
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw ILNError.fromError(sim.error);
  }

  const assembledTx = SorobanRpc.assembleTransaction(tx, sim).build();
  const signed = await client.signer.signTransaction(assembledTx, client.rpc);
  const sendResult = await retry(() => client.rpc.sendTransaction(signed));
  if (sendResult.errorResult) {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }

  return { txHash: sendResult.hash };
}

/**
 * Resolve the fund queue for an invoice, locking in the highest-score LP
 * as the approved funder. Callable by anyone once at least one LP has
 * joined the queue.
 *
 * Wraps `resolve_fund_queue(invoice_id)`.
 *
 * @param client Configured {@link ILNClient} — any signer, since the contract allows anyone to call this
 * @param invoiceId Invoice whose queue should be resolved
 * @returns The approved LP's address and the transaction hash
 * @throws {ILNError.NotFunded} If no LP has joined the queue for this invoice
 */
export async function resolveFundQueue(
  client: ILNClient,
  invoiceId: bigint
): Promise<ResolveFundQueueResult> {
  if (!client.signer) {
    throw new Error("resolveFundQueue requires a client configured with a signer");
  }

  const contract = new Contract(client.contractId);
  const op = contract.call("resolve_fund_queue", nativeToScVal(invoiceId, { type: "u64" }));

  const account = await retry(() => client.rpc.getAccount(client.signer!.publicKey));
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: client.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await retry(() => client.rpc.simulateTransaction(tx));
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw ILNError.fromError(sim.error);
  }

  const assembledTx = SorobanRpc.assembleTransaction(tx, sim).build();
  const signed = await client.signer.signTransaction(assembledTx, client.rpc);
  const sendResult = await retry(() => client.rpc.sendTransaction(signed));
  if (sendResult.errorResult) {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }

  let status = await retry(() => client.rpc.getTransaction(sendResult.hash));
  let retries = 0;
  while (status.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND && retries < 15) {
    await new Promise((r) => setTimeout(r, 2000));
    status = await retry(() => client.rpc.getTransaction(sendResult.hash));
    retries++;
  }
  if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw new Error("Transaction failed during execution");
  }

  let approvedLp = "";
  if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS && status.returnValue) {
    approvedLp = String(scValToNative(status.returnValue));
  }

  return { approvedLp, txHash: sendResult.hash };
}
