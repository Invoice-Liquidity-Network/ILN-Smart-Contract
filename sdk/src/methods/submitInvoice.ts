import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  Account,
  Transaction,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { SubmitInvoiceParams, SubmitInvoiceResult } from "../types/params.js";
import { ILNError } from "../errors.js";
import { validateDiscountRate, validateGAddress } from "../utils/validate.js";
import { retry } from "../utils/retry.js";

/**
 * Submit a new invoice to the contract.
 * @param server Soroban RPC server
 * @param contractAddress Contract address
 * @param params Invoice parameters
 * @param sourceAccount The account of the freelancer/submitter
 * @param signTransaction A function to sign the transaction (e.g. Freighter or Keypair)
 * @param networkPassphrase The network passphrase
 * @returns Object containing invoiceId and txHash
 * @throws {ILNError.InvalidAmount} If amount is <= 0
 * @throws {ILNError.InvalidDiscountRate} If discount rate is not between 1 and 5000 bps
 * @throws {ILNError.DueDateTooSoon} If due date is < 24h
 * @throws {ILNError.DueDateTooFar} If due date is > 365 days
 * @throws {ILNError} If payer address is invalid or transaction fails
 * @example
 * ```ts
 * const { invoiceId, txHash } = await submitInvoice(server, contractAddress, {
 *   payer: "G...", amount: 1000n, dueDate: Date.now() / 1000 + 86400 * 30, discountRate: 300, token: "C..."
 * }, sourceAccount, signTx, Networks.TESTNET);
 * ```
 */
export async function submitInvoice(
  server: SorobanRpc.Server,
  contractAddress: string,
  params: SubmitInvoiceParams,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<SubmitInvoiceResult> {
  // Validation
  if (params.amount <= 0n) {
    throw new ILNError.InvalidAmount("Invoice amount must be greater than 0");
  }
  validateDiscountRate(params.discountRate);

  const dueDateUnix = params.dueDate instanceof Date ? Math.floor(params.dueDate.getTime() / 1000) : params.dueDate;
  const nowUnix = Math.floor(Date.now() / 1000);
  const minDuration = 24 * 60 * 60;
  const maxDuration = 365 * 24 * 60 * 60;
  
  if (dueDateUnix < nowUnix + minDuration) {
    throw new ILNError.DueDateTooSoon("Due date is too soon (minimum 24 hours)");
  }
  if (dueDateUnix > nowUnix + maxDuration) {
    throw new ILNError.DueDateTooFar("Due date is too far (maximum 365 days)");
  }
  
  validateGAddress(params.payer);

  const contract = new Contract(contractAddress);
  const submitterAddress = sourceAccount.accountId();
  
  const tokenArg = nativeToScVal(params.token, { type: "address" });
  // ReferralCode is a Soroban enum: Vec[U32(0), Void] for None, Vec[U32(1), BytesN<32>] for Present
  let refArg: xdr.ScVal;
  if (params.referralCode) {
    const refBuffer = Buffer.from(params.referralCode, 'hex');
    refArg = xdr.ScVal.scvVec([
      xdr.ScVal.scvU32(1),
      nativeToScVal(refBuffer, { type: "bytes" }),
    ]);
  } else {
    refArg = xdr.ScVal.scvVec([
      xdr.ScVal.scvU32(0),
      xdr.ScVal.scvVoid(),
    ]);
  }

  const op = contract.call(
    "submit_invoice",
    nativeToScVal(submitterAddress, { type: "address" }),
    nativeToScVal(params.payer, { type: "address" }),
    nativeToScVal(params.amount, { type: "i128" }),
    nativeToScVal(dueDateUnix, { type: "u64" }),
    nativeToScVal(params.discountRate, { type: "u32" }),
    tokenArg,
    refArg
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

  let invoiceId = 0n;
  if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS && status.returnValue) {
    invoiceId = BigInt(String(scValToNative(status.returnValue)));
  }

  return { invoiceId, txHash: sendResult.hash };
}
