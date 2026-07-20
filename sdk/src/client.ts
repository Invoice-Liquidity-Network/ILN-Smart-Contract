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

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Public Soroban RPC endpoint for Stellar Testnet.
 */
export const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";

/**
 * Public Soroban RPC endpoint for Stellar Mainnet (Pubnet).
 */
export const MAINNET_RPC_URL = "https://soroban.stellar.org";

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ILNClient
// ---------------------------------------------------------------------------

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
export class ILNClient {
  /** Soroban RPC server instance. */
  readonly rpc: SorobanRpc.Server;
  /** Stellar network passphrase. */
  readonly networkPassphrase: string;
  /** Deployed invoice-liquidity contract address. */
  readonly contractId: string;
  /** Optional signer for authenticated methods. */
  readonly signer?: ISigner | undefined;

  // Cached imports (lazy-loaded for tree-shaking)
  private _getReputation?: typeof import("./methods/reputation.js").getReputation;
  private _getContractStats?: typeof import("./methods/stats.js").getContractStats;
  private _getTopPayers?: typeof import("./methods/topPayers.js").getTopPayers;
  private _queryNftMetadata?: typeof import("./methods/nft.js").queryNftMetadata;
  private _queryNftOwner?: typeof import("./methods/nft.js").queryNftOwner;
  private _getPoolBalance?: typeof import("./methods/insurance.js").getPoolBalance;
  private _getCoverage?: typeof import("./methods/insurance.js").getCoverage;
  private _isEnrolled?: typeof import("./methods/insurance.js").isEnrolled;
  private _getPremiumsPaid?: typeof import("./methods/insurance.js").getPremiumsPaid;
  private _getInsurancePoolInfo?: typeof import("./methods/insurance.js").getInsurancePoolInfo;
  private _getDistributionAccrual?: typeof import("./methods/distribution.js").getDistributionAccrual;

  constructor(config: ILNClientConfig) {
    this.rpc = new SorobanRpc.Server(config.rpcUrl);
    this.networkPassphrase = config.networkPassphrase;
    this.contractId = config.contractId;
    this.signer = config.signer;
  }

  // --------------------------------------------------------------------------
  // Factory methods
  // --------------------------------------------------------------------------

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
  static testnet(
    signer?: ISigner,
    options?: { rpcUrl?: string; contractId?: string }
  ): ILNClient {
    return new ILNClient({
      rpcUrl: options?.rpcUrl ?? TESTNET_RPC_URL,
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId:
        options?.contractId ??
        // Published testnet deployment: the canonical contract ID from
        // the latest testnet CI/CD deployment. Update here when redeploying.
        "CCVXGPKFAN374T62PLZAHWIS4UKUVTOYRD72HT36SGWWX7LRD5VFUUJD",
      ...(signer ? { signer } : {}),
    });
  }

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
  static mainnet(
    signer?: ISigner,
    options?: { rpcUrl?: string; contractId?: string }
  ): ILNClient {
    // Future-proof: we allow configuring mainnet ahead of deployment
    // so integrators can test their integration code against the API shape.
    return new ILNClient({
      rpcUrl: options?.rpcUrl ?? MAINNET_RPC_URL,
      networkPassphrase: "Public Global Stellar Network ; September 2015",
      contractId:
        options?.contractId ??
        // TODO: replace with actual mainnet contract ID after mainnet deployment
        "",
      ...(signer ? { signer } : {}),
    });
  }

  /**
   * Create a client with fully custom configuration.
   *
   * Use this for local development (standalone network), Futurenet, or
   * private Stellar deployments.
   *
   * @param config - Full ILNClientConfig
   */
  static custom(config: ILNClientConfig): ILNClient {
    return new ILNClient(config);
  }

  // --------------------------------------------------------------------------
  // Methods
  // --------------------------------------------------------------------------

  /**
   * Fetch the detailed reputation profile for an address.
   *
   * Read-only; does not require a signer.
   *
   * @param address - Stellar G… address to query
   * @returns ReputationProfile (zeroed for unknown addresses)
   */
  async getReputation(
    address: string
  ): Promise<import("./methods/reputation.js").ReputationProfile> {
    if (!this._getReputation) {
      this._getReputation = (await import("./methods/reputation.js"))
        .getReputation;
    }
    return this._getReputation(this.rpc, this.contractId, address, this.networkPassphrase);
  }

  /**
   * Fetch protocol-wide statistics.
   *
   * Read-only; does not require a signer.
   *
   * @returns ContractStats
   */
  async getContractStats(): Promise<
    import("./methods/stats.js").ContractStats
  > {
    if (!this._getContractStats) {
      this._getContractStats = (await import("./methods/stats.js"))
        .getContractStats;
    }
    return this._getContractStats(this.rpc, this.contractId, this.networkPassphrase);
  }

  /**
   * Fetch the top payers leaderboard.
   *
   * Read-only; does not require a signer.
   *
   * @param limit - Maximum number of entries to return (default 10)
   * @returns Array of TopPayerEntry sorted by descending score
   */
  async getTopPayers(
    limit: number = 10
  ): Promise<import("./methods/topPayers.js").TopPayerEntry[]> {
    if (!this._getTopPayers) {
      this._getTopPayers = (await import("./methods/topPayers.js"))
        .getTopPayers;
    }
    return this._getTopPayers(this.rpc, this.contractId, limit, this.networkPassphrase);
  }

  async queryNftMetadata(invoiceId: bigint) {
    if (!this._queryNftMetadata) {
      this._queryNftMetadata = (await import("./methods/nft.js")).queryNftMetadata;
    }
    return this._queryNftMetadata(
      this.rpc,
      this.contractId,
      invoiceId,
      this.networkPassphrase,
    );
  }

  async queryNftOwner(invoiceId: bigint) {
    if (!this._queryNftOwner) {
      this._queryNftOwner = (await import("./methods/nft.js")).queryNftOwner;
    }
    return this._queryNftOwner(
      this.rpc,
      this.contractId,
      invoiceId,
      this.networkPassphrase,
    );
  }

  /**
   * Fetch the current insurance pool balance.
   *
   * @param insurancePoolContractId - Deployed insurance pool contract address
   */
  async getInsurancePoolBalance(
    insurancePoolContractId: string
  ): Promise<bigint> {
    if (!this._getPoolBalance) {
      this._getPoolBalance = (await import("./methods/insurance.js")).getPoolBalance;
    }
    return this._getPoolBalance(this.rpc, insurancePoolContractId, this.networkPassphrase);
  }

  /**
   * Fetch the configured insurance coverage cap.
   *
   * @param insurancePoolContractId - Deployed insurance pool contract address
   */
  async getInsurancePoolCoverage(
    insurancePoolContractId: string
  ): Promise<bigint> {
    if (!this._getCoverage) {
      this._getCoverage = (await import("./methods/insurance.js")).getCoverage;
    }
    return this._getCoverage(this.rpc, insurancePoolContractId, this.networkPassphrase);
  }

  /**
   * Check if a liquidity provider is enrolled in the insurance pool.
   *
   * @param insurancePoolContractId - Deployed insurance pool contract address
   * @param lpAddress - LP's Stellar address
   */
  async isInsurancePoolEnrolled(
    insurancePoolContractId: string,
    lpAddress: string
  ): Promise<boolean> {
    if (!this._isEnrolled) {
      this._isEnrolled = (await import("./methods/insurance.js")).isEnrolled;
    }
    return this._isEnrolled(this.rpc, insurancePoolContractId, lpAddress, this.networkPassphrase);
  }

  /**
   * Fetch the total premiums paid by an LP.
   *
   * @param insurancePoolContractId - Deployed insurance pool contract address
   * @param lpAddress - LP's Stellar address
   */
  async getInsurancePoolPremiumsPaid(
    insurancePoolContractId: string,
    lpAddress: string
  ): Promise<bigint> {
    if (!this._getPremiumsPaid) {
      this._getPremiumsPaid = (await import("./methods/insurance.js")).getPremiumsPaid;
    }
    return this._getPremiumsPaid(this.rpc, insurancePoolContractId, lpAddress, this.networkPassphrase);
  }

  /**
   * Fetch all insurance pool info for an LP.
   *
   * @param insurancePoolContractId - Deployed insurance pool contract address
   * @param lpAddress - LP's Stellar address
   */
  async getInsurancePoolInfo(
    insurancePoolContractId: string,
    lpAddress: string
  ): Promise<import("@invoice-liquidity/types").InsurancePoolInfo> {
    if (!this._getInsurancePoolInfo) {
      this._getInsurancePoolInfo = (await import("./methods/insurance.js")).getInsurancePoolInfo;
    }
    return this._getInsurancePoolInfo(this.rpc, insurancePoolContractId, lpAddress, this.networkPassphrase);
  }

  /**
   * Fetch a participant's accrued distribution tokens.
   *
   * @param distributionContractId - Deployed distribution contract address
   * @param participantAddress - Stellar address of the participant
   */
  async getDistributionAccrual(
    distributionContractId: string,
    participantAddress: string
  ): Promise<number> {
    if (!this._getDistributionAccrual) {
      this._getDistributionAccrual = (await import("./methods/distribution.js")).getDistributionAccrual;
    }
    return this._getDistributionAccrual(this.rpc, distributionContractId, participantAddress, this.networkPassphrase);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

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
class ILNSingleton {
  private _client: ILNClient | null = null;

  configure(config: ILNClientConfig): void {
    this._client = new ILNClient(config);
  }

  /** Access the underlying client. Throws if not configured. */
  get client(): ILNClient {
    if (!this._client) {
      throw new Error(
        "ILN singleton not configured. Call iln.configure({...}) first."
      );
    }
    return this._client;
  }

  async getReputation(address: string) {
    return this.client.getReputation(address);
  }

  async getContractStats() {
    return this.client.getContractStats();
  }

  async getTopPayers(limit: number = 10) {
    return this.client.getTopPayers(limit);
  }

  async getInsurancePoolBalance(insurancePoolContractId: string) {
    return this.client.getInsurancePoolBalance(insurancePoolContractId);
  }

  async getInsurancePoolCoverage(insurancePoolContractId: string) {
    return this.client.getInsurancePoolCoverage(insurancePoolContractId);
  }

  async isInsurancePoolEnrolled(insurancePoolContractId: string, lpAddress: string) {
    return this.client.isInsurancePoolEnrolled(insurancePoolContractId, lpAddress);
  }

  async getInsurancePoolPremiumsPaid(insurancePoolContractId: string, lpAddress: string) {
    return this.client.getInsurancePoolPremiumsPaid(insurancePoolContractId, lpAddress);
  }

  async getInsurancePoolInfo(insurancePoolContractId: string, lpAddress: string) {
    return this.client.getInsurancePoolInfo(insurancePoolContractId, lpAddress);
  }

  async getDistributionAccrual(distributionContractId: string, participantAddress: string) {
    return this.client.getDistributionAccrual(distributionContractId, participantAddress);
  }
}

export const iln = new ILNSingleton();
