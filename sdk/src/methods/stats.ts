/**
 * getContractStats — fetch protocol-wide statistics from the contract.
 *
 * Reads the single `get_contract_stats()` view call. No signer or
 * transaction fees required (read-only simulation).
 */

import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Account,
  BASE_FEE,
  scValToNative,
  Networks,
} from "@stellar/stellar-sdk";
import { retry } from "../utils/retry.js";
import { decodeContractStats, type ContractStats } from "../utils/xdrDecoder.js";


// ---------------------------------------------------------------------------
// getContractStats
// ---------------------------------------------------------------------------

/**
 * Query protocol-wide statistics from the contract.
 *
 * Read-only — no signer, no fees, no on-chain mutation.
 *
 * @param server              - Soroban RPC server for the target network
 * @param contractId          - Deployed invoice-liquidity contract address
 * @param networkPassphrase   - Stellar network passphrase (default: TESTNET)
 * @returns ContractStats
 *
 * @throws When the Soroban simulation fails (RPC unreachable, contract not found)
 *
 * @example
 * ```ts
 * const stats = await getContractStats(server, CONTRACT_ID);
 * console.log(`Total invoices: ${stats.totalInvoices}`);
 * console.log(`USDC volume:    ${stats.totalVolumeUsdc}`);
 * ```
 */
export async function getContractStats(
  server: SorobanRpc.Server,
  contractId: string,
  networkPassphrase: string = Networks.TESTNET
): Promise<ContractStats> {
  const contract = new Contract(contractId);
  const op = contract.call("get_contract_stats");

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
    throw new Error(`get_contract_stats simulation failed: ${sim.error}`);
  }

  if (!sim.result?.retval) {
    return {
      totalInvoices: 0n,
      totalFunded: 0n,
      totalPaid: 0n,
      totalVolumeUsdc: 0n,
      totalVolumeEurc: 0n,
      totalVolumeXlm: 0n,
      volumeByToken: {},
      totalVolumeUsdNormalized: 0n,
    };
  }

  const raw = scValToNative(sim.result.retval) as Record<string, unknown>;
  return decodeContractStats(raw);
}

export type { ContractStats };
