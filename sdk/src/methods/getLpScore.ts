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
 * Fetch a liquidity provider's reputation score.
 *
 * Calls the `lp_score` view function (Issue #34). LP scores start at a
 * neutral baseline (50) and are capped at 100. Unknown / never-active
 * LPs return the default baseline rather than throwing.
 *
 * Performs a read-only Soroban simulation — no on-chain mutation, no
 * transaction fees, and no signer required.
 *
 * @param client - The configured ILNClient instance
 * @param lp - The Stellar address of the liquidity provider
 * @returns The LP reputation score (0–100)
 * @throws An error if the simulation fails or returns a non-numeric value
 */
export async function getLpScore(client: ILNClient, lp: string): Promise<number> {
  const contract = new Contract(client.contractId);
  const op = contract.call(
    "lp_score",
    nativeToScVal(lp, { type: "address" })
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
    throw new Error(`lp_score simulation failed: ${sim.error}`);
  }

  if (!sim.result?.retval) {
    throw new Error("lp_score returned empty result");
  }

  const raw = scValToNative(sim.result.retval);

  if (typeof raw !== "number") {
    throw new Error(`lp_score returned non-number value: ${typeof raw}`);
  }

  return raw;
}
