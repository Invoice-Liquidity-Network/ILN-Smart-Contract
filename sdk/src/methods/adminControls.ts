// @ts-nocheck
/**
 * pause / unpause — SDK helpers for the contract's emergency admin
 * controls (issue #470).
 */
import { Contract, SorobanRpc, TransactionBuilder, BASE_FEE } from "@stellar/stellar-sdk";
import type { ILNClient } from "../client.js";
import { ILNError } from "../errors.js";
import { retry } from "../utils/retry.js";

export interface PauseResult {
  txHash: string;
}

async function callAdminOp(client: ILNClient, methodName: string): Promise<PauseResult> {
  if (!client.signer) {
    throw new Error(`${methodName} requires a client configured with a signer (the contract admin)`);
  }

  const contract = new Contract(client.contractId);
  const op = contract.call(methodName);

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
 * Pause the contract, blocking all state-mutating calls (submissions,
 * funding, payments, etc.) until {@link unpause} is called.
 *
 * Wraps `pause()`. Requires the contract admin's signature —
 * `client.signer` must be the stored admin.
 *
 * @throws {ILNError.Unauthorized} If `client.signer` is not the contract admin
 */
export async function pause(client: ILNClient): Promise<PauseResult> {
  return callAdminOp(client, "pause");
}

/**
 * Unpause the contract, resuming normal operation.
 *
 * Wraps `unpause()`. Requires the contract admin's signature —
 * `client.signer` must be the stored admin.
 *
 * @throws {ILNError.Unauthorized} If `client.signer` is not the contract admin
 */
export async function unpause(client: ILNClient): Promise<PauseResult> {
  return callAdminOp(client, "unpause");
}
