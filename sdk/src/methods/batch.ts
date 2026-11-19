/**
 * Batch transaction support — combine multiple contract calls into a single transaction.
 *
 * Improves UX and reduces gas costs by allowing several operations to be submitted
 * as a single atomic unit on-chain. Partial failures (one operation fails while others
 * succeed) are not possible; the entire batch succeeds or fails as a unit.
 */

import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Account,
  BASE_FEE,
  scValToNative,
  nativeToScVal,
  Address,
  Networks,
  Transaction,
  xdr,
  FeeBumpTransaction,
  TransactionEnvelope,
  scVal,
} from "@stellar/stellar-sdk";
import type { ISigner } from "../signers/ISigner.js";

export interface BatchContractCall {
  contractId: string;
  method: string;
  args: (scVal.SCVal | string | number | bigint | boolean | Address)[];
}

export interface BatchTransactionOptions {
  networkPassphrase?: string;
  fee?: number;
  timeout?: number;
}

export interface BatchTransactionResult {
  transaction: Transaction;
  sourceAccount: Account;
}

/**
 * Build a batch transaction from multiple contract calls.
 *
 * Combines multiple contract invocations into a single Soroban transaction.
 * All operations succeed or fail together; partial success is not possible.
 *
 * @param calls - Array of contract call specifications
 * @param sourceAccountId - Stellar account public key that will sign
 * @param sequenceNumber - Current sequence number of the source account
 * @param options - Network, fee, and timeout configuration
 *
 * @returns Unsigned transaction and source account object for simulations
 *
 * @example
 * ```ts
 * const batch = await buildBatchTransaction([
 *   {
 *     contractId: "CXXXX...",
 *     method: "submit_invoice",
 *     args: [freelancer, payer, token, amount, dueDate, discountRate],
 *   },
 *   {
 *     contractId: "CXXXX...",
 *     method: "join_fund_queue",
 *     args: [invoiceId],
 *   },
 * ], "GXXXX...", 100n);
 *
 * const signed = await signer.signTransaction(batch.transaction);
 * const result = await server.sendTransaction(signed);
 * ```
 */
export function buildBatchTransaction(
  calls: BatchContractCall[],
  sourceAccountId: string,
  sequenceNumber: bigint,
  options: BatchTransactionOptions = {}
): BatchTransactionResult {
  if (!calls || calls.length === 0) {
    throw new Error("Batch transaction requires at least one contract call");
  }

  const networkPassphrase = options.networkPassphrase ?? Networks.TESTNET;
  const fee = options.fee ?? BASE_FEE;
  const timeout = options.timeout ?? 30;

  const sourceAccount = new Account(sourceAccountId, sequenceNumber.toString());

  const builder = new TransactionBuilder(sourceAccount, {
    fee: fee * calls.length,
    networkPassphrase,
  });

  for (const call of calls) {
    const contract = new Contract(call.contractId);

    const scaledArgs = call.args.map((arg) => {
      if (arg instanceof Address) {
        return arg.toScVal();
      }
      if (typeof arg === "string") {
        return nativeToScVal(arg, { type: "string" });
      }
      if (typeof arg === "number") {
        return nativeToScVal(BigInt(arg), { type: "i128" });
      }
      if (typeof arg === "bigint") {
        return nativeToScVal(arg, { type: "i128" });
      }
      if (typeof arg === "boolean") {
        return nativeToScVal(arg, { type: "bool" });
      }
      if (arg && typeof arg === "object" && "type" in arg) {
        return arg as scVal.SCVal;
      }
      throw new Error(`Unsupported argument type: ${typeof arg}`);
    });

    const op = contract.call(call.method, ...scaledArgs);
    builder.addOperation(op);
  }

  const transaction = builder.setTimeout(timeout).build();

  return { transaction, sourceAccount };
}

/**
 * Prepare and submit a batch transaction.
 *
 * Simulates the transaction, applies fee adjustments if needed, and optionally
 * signs and submits it to the network. If a signer is provided, the transaction
 * is automatically signed and submitted.
 *
 * @param calls - Array of contract call specifications
 * @param server - Soroban RPC server
 * @param sourceAccountId - Stellar account public key that will sign
 * @param signer - Optional signer for automatic signing and submission
 * @param options - Network, fee, and timeout configuration
 *
 * @returns Transaction hash if submitted, or unsigned transaction if no signer
 *
 * @example
 * ```ts
 * const txHash = await submitBatchTransaction(
 *   calls,
 *   server,
 *   "GXXXX...",
 *   freighterSigner,
 *   { networkPassphrase: "Test SDF Network ; September 2015" }
 * );
 * ```
 */
export async function submitBatchTransaction(
  calls: BatchContractCall[],
  server: SorobanRpc.Server,
  sourceAccountId: string,
  signer?: ISigner,
  options: BatchTransactionOptions = {}
): Promise<string> {
  const networkPassphrase = options.networkPassphrase ?? Networks.TESTNET;

  const accountInfo = await server.getAccount(sourceAccountId);
  const { transaction } = buildBatchTransaction(calls, sourceAccountId, BigInt(accountInfo.sequence), {
    ...options,
    networkPassphrase,
  });

  const simResult = await server.simulateTransaction(transaction);

  if (SorobanRpc.isSimulationSuccess(simResult)) {
    const prepared = SorobanRpc.assembleTransaction(transaction, simResult).build();

    if (signer) {
      const signed = await signer.signTransaction(prepared, networkPassphrase);
      const sent = await server.sendTransaction(signed);
      return sent.hash;
    }

    return prepared.hash();
  } else if (SorobanRpc.isSimulationRestore(simResult)) {
    throw new Error("Archive restoration required; cannot submit batch transaction");
  } else {
    throw new Error(`Batch transaction simulation failed: ${simResult.error}`);
  }
}
