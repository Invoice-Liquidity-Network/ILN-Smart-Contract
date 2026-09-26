import { SorobanRpc, Account, Transaction, Networks } from "@stellar/stellar-sdk";
import { simulateCall, submitCall } from "../utils/contract.js";
import { validateContractId, validateGAddress } from "../utils/validation.js";
import { scValToNative, nativeToScVal } from "@stellar/stellar-sdk";

export interface TwapConfig {
  window_size: number;
  min_updates: number;
}

/**
 * Get the current TWAP configuration.
 *
 * @param server              - Soroban RPC server for the target network
 * @param contractId          - Deployed contract address
 * @param networkPassphrase   - Stellar network passphrase (default: TESTNET)
 * @returns The TWAP configuration object
 */
export async function getTwapConfig(
  server: SorobanRpc.Server,
  contractId: string,
  networkPassphrase: string = Networks.TESTNET
): Promise<TwapConfig | null> {
  validateContractId(contractId);
  const retval = await simulateCall(server, contractId, "get_twap_config", [], networkPassphrase);
  if (!retval) {
    return null;
  }
  return scValToNative(retval) as TwapConfig;
}

/**
 * Set the TWAP configuration via governance.
 *
 * @param server              - Soroban RPC server for the target network
 * @param contractId          - Deployed contract address
 * @param config              - The new TWAP configuration
 * @param sourceAccount       - The governance/admin account
 * @param signTransaction     - Function to sign the assembled transaction
 * @param networkPassphrase   - Stellar network passphrase (default: TESTNET)
 * @returns The submitted transaction hash
 */
export async function setTwapConfigViaGovernance(
  server: SorobanRpc.Server,
  contractId: string,
  config: TwapConfig,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string = Networks.TESTNET
): Promise<{ txHash: string }> {
  validateContractId(contractId);
  const { txHash } = await submitCall(
    server,
    contractId,
    "set_twap_config_via_governance",
    [
      nativeToScVal(
        {
          window_size: nativeToScVal(config.window_size, { type: "u32" }),
          min_updates: nativeToScVal(config.min_updates, { type: "u32" })
        },
        { type: "map" }
      )
    ],
    sourceAccount,
    signTransaction,
    networkPassphrase
  );
  return { txHash };
}
