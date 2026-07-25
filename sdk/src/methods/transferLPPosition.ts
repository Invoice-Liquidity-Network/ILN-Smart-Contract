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
import { validateGAddress } from "../utils/validate.js";

/**
 * Transfer a funded LP position to another address.
 *
 * Allows a liquidity provider to exit a position they have funded by handing
 * it to a new LP, without unwinding the underlying invoice. The caller
 * (`sourceAccount`) must be the current LP of the position.
 *
 * @param server Soroban RPC server
 * @param contractAddress Contract address
 * @param invoiceId The ID of the funded invoice whose position is transferred
 * @param newLP The G-address of the LP receiving the position
 * @param sourceAccount The account of the current LP
 * @param signTransaction A function to sign the transaction (e.g. Freighter or Keypair)
 * @param networkPassphrase The network passphrase
 * @returns Object containing txHash
 * @throws {ILNError.InvalidAddress} If newLP is not a valid Stellar G-address
 * @throws {ILNError.InvalidTransfer} If newLP is the same as the current LP
 * @throws {ILNError} When simulation or execution fails
 * @example
 * ```ts
 * const { txHash } = await transferLPPosition(server, contractAddress, 42n, "G...", sourceAccount, signTx, Networks.TESTNET);
 * ```
 */
export async function transferLPPosition(
  server: SorobanRpc.Server,
  contractAddress: string,
  invoiceId: bigint,
  newLP: string,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<{ txHash: string }> {
  // Validate the destination address up-front.
  validateGAddress(newLP);

  const currentLP = sourceAccount.accountId();
  if (newLP === currentLP) {
    throw new ILNError.InvalidTransfer(
      "New LP must be different from the current LP"
    );
  }

  const contract = new Contract(contractAddress);

  const op = contract.call(
    "transfer_lp_position",
    nativeToScVal(invoiceId, { type: "u64" }),
    nativeToScVal(currentLP, { type: "address" }),
    nativeToScVal(newLP, { type: "address" })
  );

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  // Simulate to catch contract errors
  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw ILNError.fromError(sim.error);
  }

  const assembledTx = SorobanRpc.assembleTransaction(tx, sim).build();

  // Sign
  const signedTx = await signTransaction(assembledTx);

  // Submit
  const sendResult = await server.sendTransaction(signedTx);
  if (sendResult.errorResult) {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }

  // Wait for completion
  let status = await server.getTransaction(sendResult.hash);
  let retries = 0;
  while (status.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND && retries < 15) {
    await new Promise(r => setTimeout(r, 2000));
    status = await server.getTransaction(sendResult.hash);
    retries++;
  }

  if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw new Error("Transaction failed during execution");
  }

  return { txHash: sendResult.hash };
}
