/**
 * ILNClient — entry point for the Invoice Liquidity Network SDK.
 *
 * Provides factory methods for common environments so integrators can
 * get started with a one-liner:
 *
 * ```ts
 * import { ILNClient } from "@iln/sdk";
 *
 * const client = ILNClient.testnet(signer);
 * const reputation = await client.getReputation("G...");
 * ```
 *
 * ## Architecture
 *
 * `ILNClient` is a thin wrapper around the SDK's free functions. It holds
 * the RPC server, network passphrase, contract address, and signer so
 * every method call uses the same configuration automatically.
 */
import { SorobanRpc } from "@stellar/stellar-sdk";
import type { ISigner } from "./signers/ISigner.js";
/**
 * Public Soroban RPC endpoint for Stellar Testnet.
 */
export declare const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
/**
 * Public Soroban RPC endpoint for Stellar Mainnet (Pubnet).
 */
export declare const MAINNET_RPC_URL = "https://soroban.stellar.org";
/** Full configuration for a custom ILNClient. */
export interface ILNClientConfig {
    /** Soroban RPC endpoint URL. */
    rpcUrl: string;
    /** Stellar network passphrase (e.g. `Networks.TESTNET`). */
    networkPassphrase: string;
    /** Deployed invoice-liquidity contract address. */
    contractId: string;
    /**
     * Optional signer for methods that require authentication (e.g. fundInvoice).
     * Read-only methods like getReputation work without a signer.
     */
    signer?: ISigner;
}
/**
 * Configured SDK client bound to a specific network and contract.
 *
 * @example
 * ```ts
 * // Testnet
 * const client = ILNClient.testnet(mySigner);
 *
 * // Custom RPC (e.g. local validator node)
 * const client = ILNClient.custom({
 *   rpcUrl: "http://localhost:8000/soroban/rpc",
 *   networkPassphrase: Networks.STANDALONE,
 *   contractId: "CDEPLOYED...",
 *   signer: mySigner,
 * });
 * ```
 */
export declare class ILNClient {
    /** Soroban RPC server instance. */
    readonly rpc: SorobanRpc.Server;
    /** Stellar network passphrase. */
    readonly networkPassphrase: string;
    /** Deployed invoice-liquidity contract address. */
    readonly contractId: string;
    /** Optional signer for authenticated methods. */
    readonly signer?: ISigner | undefined;
    private _getReputation?;
    private _getContractStats?;
    constructor(config: ILNClientConfig);
    /**
     * Create a client pre-configured for Stellar Testnet.
     *
     * @param signer   - Optional signer for authenticated methods
     * @param options  - Override defaults (rpcUrl, contractId)
     *
     * @example
     * ```ts
     * const client = ILNClient.testnet(freighterSigner);
     * ```
     */
    static testnet(signer?: ISigner, options?: {
        rpcUrl?: string;
        contractId?: string;
    }): ILNClient;
    /**
     * Create a client pre-configured for Stellar Mainnet (Pubnet).
     *
     * @param signer   - Optional signer for authenticated methods
     * @param options  - Override defaults (rpcUrl, contractId)
     *
     * @example
     * ```ts
     * const client = ILNClient.mainnet(freighterSigner);
     * ```
     */
    static mainnet(signer?: ISigner, options?: {
        rpcUrl?: string;
        contractId?: string;
    }): ILNClient;
    /**
     * Create a client with fully custom configuration.
     *
     * Use this for local development (standalone network), Futurenet, or
     * private Stellar deployments.
     *
     * @param config - Full ILNClientConfig
     */
    static custom(config: ILNClientConfig): ILNClient;
    /**
     * Fetch the detailed reputation profile for an address.
     *
     * Read-only; does not require a signer.
     *
     * @param address - Stellar G… address to query
     * @returns ReputationProfile (zeroed for unknown addresses)
     */
    getReputation(address: string): Promise<import("./methods/reputation.js").ReputationProfile>;
    /**
     * Fetch protocol-wide statistics.
     *
     * Read-only; does not require a signer.
     *
     * @returns ContractStats
     */
    getContractStats(): Promise<import("./methods/stats.js").ContractStats>;
}
/**
 * Default ILNClient singleton.
 *
 * Must be initialised via `iln.configure(...)` before use.
 *
 * @example
 * ```ts
 * import { iln } from "@iln/sdk";
 *
 * iln.configure({ rpcUrl: "...", networkPassphrase: Networks.TESTNET, contractId: "..." });
 * await iln.getReputation("G...");
 * ```
 */
declare class ILNSingleton {
    private _client;
    configure(config: ILNClientConfig): void;
    /** Access the underlying client. Throws if not configured. */
    get client(): ILNClient;
    getReputation(address: string): Promise<import("./utils/xdrDecoder.js").ReputationProfile>;
    getContractStats(): Promise<import("./utils/xdrDecoder.js").ContractStats>;
}
export declare const iln: ILNSingleton;
export {};
//# sourceMappingURL=client.d.ts.map