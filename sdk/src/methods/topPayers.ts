/**
 * getTopPayers — fetch the top payers leaderboard from the on-chain
 * invoice-liquidity contract.
 *
 * Wraps the `get_top_payers(limit)` view function. Returns up to `limit`
 * entries sorted by descending score.
 */

import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Account,
  BASE_FEE,
  scValToNative,
  nativeToScVal,
  Networks,
} from "@stellar/stellar-sdk";
import { retry } from "../utils/retry.js";
import { decodeTopPayerEntry, type TopPayerEntry } from "../utils/xdrDecoder.js";

// ---------------------------------------------------------------------------
// getTopPayers
// ---------------------------------------------------------------------------

/**
 * Query the top payers leaderboard from the contract.
 *
 * Performs a read-only Soroban simulation — no on-chain mutation, no
 * transaction fees, and no signer required.
 *
 * @param server              - Soroban RPC server for the target network
 * @param contractId          - Deployed invoice-liquidity contract address
 * @param limit               - Maximum number of entries to return (default 10)
 * @param networkPassphrase   - Stellar network passphrase (default: TESTNET)
 * @returns Array of TopPayerEntry sorted by descending score
 *
 * @throws When the Soroban simulation fails (RPC unreachable, contract not found)
 *
 * @example
 * ```ts
 * const topPayers = await getTopPayers(server, CONTRACT_ID);
 * console.log(`#1 payer: ${topPayers[0].address} (${topPayers[0].score})`);
 * ```
 */
export async function getTopPayers(
  server: SorobanRpc.Server,
  contractId: string,
  limit: number = 10,
  networkPassphrase: string = Networks.TESTNET
): Promise<TopPayerEntry[]> {
  const contract = new Contract(contractId);
  const op = contract.call(
    "get_top_payers",
    nativeToScVal(limit, { type: "u32" })
  );

  const sourceAccount = new Account(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "0"
  );

  const simTx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await retry(() => server.simulateTransaction(simTx));

  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`get_top_payers simulation failed: ${sim.error}`);
  }

  if (!sim.result?.retval) {
    return [];
  }

  const rawArr = scValToNative(sim.result.retval) as Record<string, unknown>[];
  return rawArr.map((raw) => decodeTopPayerEntry(raw));
}

export type { TopPayerEntry };
