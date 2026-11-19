import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  Account,
  Transaction,
} from "@stellar/stellar-sdk";
import { ILNError } from "../errors.js";
import { getInvoice } from "./queries.js";
import { retry } from "../utils/retry.js";

/**
 * Cancel a pending invoice.
 * @param server Soroban RPC server
 * @param contractAddress Contract address
 * @param invoiceId The ID of the invoice to cancel
 * @param sourceAccount The account of the freelancer/submitter
 * @param signTransaction A function to sign the transaction (e.g. Freighter or Keypair)
 * @param networkPassphrase The network passphrase
 * @returns Object containing txHash
 * @throws {ILNError.InvoiceNotCancellable} When the invoice is not in a Pending state
 * @throws {ILNError.Unauthorized} When caller is not the invoice submitter
 * @throws {ILNError} When simulation or execution fails
 * @example
 * ```ts
 * const { txHash } = await cancelInvoice(server, contractAddress, 42n, sourceAccount, signTx, Networks.TESTNET);
 * console.log(txHash);
 * ```
 */
export async function cancelInvoice(
  server: SorobanRpc.Server,
  contractAddress: string,
  invoiceId: bigint,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<{ txHash: string }> {
  // Read state first to validate
  const invoice = await getInvoice(
    server,
    contractAddress,
    invoiceId,
    sourceAccount,
    networkPassphrase
  );

  if (invoice.status !== "Pending") {
    throw new ILNError.InvoiceNotCancellable(`Invoice is in ${invoice.status} state, not Pending`);
  }

  const submitterAddress = sourceAccount.accountId();
  if (invoice.freelancer !== submitterAddress) {
    throw new ILNError.Unauthorized("Only the invoice submitter can cancel it");
  }

  const contract = new Contract(contractAddress);

  const op = contract.call(
    "cancel_invoice",
    nativeToScVal(submitterAddress, { type: "address" }),
    nativeToScVal(invoiceId, { type: "u64" })
  );

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  // Simulate to catch contract errors
  const sim = await retry(() => server.simulateTransaction(tx));
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw ILNError.fromError(sim.error);
  }

  const assembledTx = SorobanRpc.assembleTransaction(tx, sim).build();
  
  // Sign
  const signedTx = await signTransaction(assembledTx);
  
  // Submit
  const sendResult = await retry(() => server.sendTransaction(signedTx));
  if (sendResult.errorResult) {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }

  // Wait for completion
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

  return { txHash: sendResult.hash };
}
