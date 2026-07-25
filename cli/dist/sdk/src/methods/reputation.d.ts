/**
 * getReputation — read an address's detailed reputation profile from
 * the on-chain invoice-liquidity contract.
 *
 * Wraps the `get_reputation(address)` view function. Unknown addresses
 * return a zeroed profile (matching the contract's lazy-init behaviour).
 */
import { SorobanRpc } from "@stellar/stellar-sdk";
import { type ReputationProfile } from "../utils/xdrDecoder.js";
/**
 * Query the reputation profile for a Stellar address.
 *
 * Performs a read-only Soroban simulation — no on-chain mutation, no
 * transaction fees, and no signer required.
 *
 * @param server              - Soroban RPC server for the target network
 * @param contractId          - Deployed invoice-liquidity contract address
 * @param address             - Stellar G… address to look up
 * @param networkPassphrase   - Stellar network passphrase (default: TESTNET)
 * @returns ReputationProfile (zeroed for unknown / never-active addresses)
 *
 * @throws When `address` is not a valid Stellar G-address
 * @throws When the Soroban simulation fails (RPC unreachable, contract not found)
 *
 * @example
 * ```ts
 * const rep = await getReputation(server, CONTRACT_ID, "GAA...");
 * console.log(`Score: ${rep.score}, Submitted: ${rep.invoicesSubmitted}`);
 * ```
 */
export declare function getReputation(server: SorobanRpc.Server, contractId: string, address: string, networkPassphrase?: string): Promise<ReputationProfile>;
export type { ReputationProfile };
//# sourceMappingURL=reputation.d.ts.map