import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  Account,
  Transaction,
} from "@stellar/stellar-sdk";
import { getInvoice } from "./queries.js";
import { ILNError } from "../errors.js";
import type { MarkPaidResult } from "../types/params.js";
import { retry } from "../utils/retry.js";

/**
 * Mark an invoice as paid (supports partial payments).
 * @param server Soroban RPC server
 * @param contractAddress Contract address
 * @param invoiceId The invoice ID
 * @param amount Optional amount to pay. If omitted, pays the full remaining balance.
 * @param sourceAccount The account of the payer
 * @param signTransaction A function to sign the transaction
 * @param networkPassphrase The network passphrase
 * @returns Object with txHash, remainingBalance and fullySettled flag
 * @throws {ILNError.InsufficientAmount} If payment amount is <= 0 or exceeds outstanding balance
 * @throws {ILNError} When simulation or execution fails
 * @example
 * ```ts
 * const result = await markPaid(server, contractAddress, 42n, 100n, sourceAccount, signTx, Networks.TESTNET);
 * console.log(`Remaining balance: ${result.remainingBalance}`);
 * ```
 */
export async function markPaid(
  server: SorobanRpc.Server,
  contractAddress: string,
  invoiceId: bigint,
  amount: bigint | undefined,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<MarkPaidResult> {
  // Fetch invoice to get outstanding balance
  const invoice = await getInvoice(server, contractAddress, invoiceId, sourceAccount, networkPassphrase);
  const outstanding = invoice.amount - invoice.amountPaid;

  const paymentAmount = amount !== undefined ? amount : outstanding;

  if (paymentAmount <= 0n) {
    throw new ILNError.InsufficientAmount("Payment amount must be greater than 0");
  }
  if (paymentAmount > outstanding) {
    throw new ILNError.InsufficientAmount("Payment amount exceeds outstanding balance");
  }

  const contract = new Contract(contractAddress);
  const payerAddress = sourceAccount.accountId();

  const op = contract.call(
    "mark_paid",
    nativeToScVal(invoiceId, { type: "u64" }),
    nativeToScVal(payerAddress, { type: "address" }),
    nativeToScVal(paymentAmount, { type: "i128" })
  );

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await retry(() => server.simulateTransaction(tx));
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw ILNError.fromError(sim.error);
  }

  const assembledTx = SorobanRpc.assembleTransaction(tx, sim).build();
  const signedTx = await signTransaction(assembledTx);
  const sendResult = await retry(() => server.sendTransaction(signedTx));
  
  if (sendResult.errorResult) {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }

  // Poll for completion
  let status = await retry(() => server.getTransaction(sendResult.hash));
  let retries = 0;
  while (status.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND && retries < 15) {
    await new Promise(r => setTimeout(r, 2000));
    status = await retry(() => server.getTransaction(sendResult.hash));
    retries++;
  }

  if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw new Error("Transaction failed during execution");
  }

  const remainingBalance = outstanding - paymentAmount;
  return {
    txHash: sendResult.hash,
    remainingBalance,
    fullySettled: remainingBalance === 0n,
  };
}
