import {
  Contract,
  TransactionBuilder,
  Account,
  BASE_FEE,
  scValToNative,
  nativeToScVal,
  SorobanRpc,
} from "@stellar/stellar-sdk";
import type { ILNClient } from "../client.js";
import { retry } from "../utils/retry.js";

/**
 * Fetch the registered decimal precision for a token.
 *
 * Calls the `get_token_decimals` view function.
 *
 * @param client - The configured ILNClient instance
 * @param tokenAddress - The Stellar address of the token
 * @returns The token decimals (e.g., 6) or null if the token is not registered
 * @throws An error if the simulation fails
 */
export async function getTokenDecimals(client: ILNClient, tokenAddress: string): Promise<number | null> {
  const contract = new Contract(client.contractId);
  const op = contract.call(
    "get_token_decimals",
    nativeToScVal(tokenAddress, { type: "address" })
  );

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
    throw new Error(`get_token_decimals simulation failed: ${sim.error}`);
  }

  if (!sim.result?.retval) {
    throw new Error("get_token_decimals returned empty result");
  }

  const raw = scValToNative(sim.result.retval);

  if (raw === undefined || raw === null) {
    return null;
  }

  if (typeof raw !== "number") {
    throw new Error(`get_token_decimals returned non-number value: ${typeof raw}`);
  }

  return raw;
}
