/**
 * Token decimal precision queries.
 *
 * Reads the registered decimal precision for a token from the
 * Invoice Liquidity contract. Mirrors the on-chain
 * `get_token_decimals(env, token) -> Option<u32>` method. The two bootstrap
 * tokens (USDC at 6 decimals, XLM at 7 decimals) are registered automatically
 * during `initialize`; any other token must be registered via `add_token`.
 */

import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Account,
  BASE_FEE,
  scValToNative,
  Address,
  Networks,
} from "@stellar/stellar-sdk";
import { retry } from "../utils/retry.js";
import { validateContractId, validateGAddress } from "../utils/validate.js";

/**
 * Get the registered decimal precision for a token.
 *
 * @param server              - Soroban RPC server for the target network
 * @param contractId          - Deployed Invoice Liquidity contract address
 * @param token               - The token's Stellar address (G… for Stellar
 *                              assets, C… for custom / contract tokens)
 * @param networkPassphrase   - Stellar network passphrase (default: TESTNET)
 * @returns The token's decimal precision as a number, or `null` if the token
 *          has never been registered with the contract.
 * @throws {ILNError} On invalid contract/token address or simulation error
 */
export async function getTokenDecimals(
  server: SorobanRpc.Server,
  contractId: string,
  token: string,
  networkPassphrase: string = Networks.TESTNET
): Promise<number | null> {
  validateContractId(contractId);
  validateGAddress(token);

  const contract = new Contract(contractId);
  const op = contract.call(
    "get_token_decimals",
    new Address(token).toScVal()
  );

  // A read-only query does not consume a real sequence number, so a dummy
  // source account is adequate for simulation.
  const sourceAccount = new Account(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "0"
  );
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await retry(() => server.simulateTransaction(tx));

  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`get_token_decimals simulation failed: ${sim.error}`);
  }

  // No return value (e.g. empty simulation) → treat as unregistered.
  if (!sim.result?.retval) {
    return null;
  }

  // On-chain return type is Option<u32>; scValToNative yields `null` for
  // `None` (token not registered) and a number for `Some(decimals)`.
  const decoded = scValToNative(sim.result.retval) as number | null;
  return decoded === null ? null : decoded;
}
