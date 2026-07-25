/**
 * getVersion — fetch the deployed contract version from the on-chain invoice-liquidity contract.
 *
 * Calls the `get_version` view function.
 */

import {
  Contract,
  TransactionBuilder,
  Account,
  BASE_FEE,
  scValToNative,
  SorobanRpc,
} from "@stellar/stellar-sdk";
import type { ILNClient } from "../client.js";
import { retry } from "../utils/retry.js";

/**
 * Fetch the deployed contract version from the on-chain invoice-liquidity contract.
 *
 * Performs a read-only Soroban simulation — no on-chain mutation, no
 * transaction fees, and no signer required.
 *
 * @param client - The configured ILNClient instance
 * @returns The version string (e.g. "1.0.0")
 * @throws An error if the simulation fails (e.g., if the contract is not deployed)
 *
 * @example
 * ```ts
 * const version = await getVersion(client);
 * console.log(`Contract version: ${version}`);
 * ```
 */
export async function getVersion(client: ILNClient): Promise<string> {
  const contract = new Contract(client.contractId);
  const op = contract.call("get_version");

  const sourceAccount = new Account(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "0"
  );

  const simTx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: client.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await retry(() => client.rpc.simulateTransaction(simTx));

  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`get_version simulation failed: ${sim.error}`);
  }

  if (!sim.result?.retval) {
    throw new Error("get_version returned empty result");
  }

  const raw = scValToNative(sim.result.retval);
  if (typeof raw !== "string") {
    throw new Error(`get_version returned non-string value: ${typeof raw}`);
  }

  return raw;
}
