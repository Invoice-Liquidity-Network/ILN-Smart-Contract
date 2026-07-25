/**
 * FreighterSigner — ISigner adapter for the Freighter browser extension.
 *
 * Intended for browser-based dApps where a Stellar wallet extension is
 * available. Detects whether Freighter is installed, requests network
 * access on first use, and delegates transaction signing to the wallet.
 *
 * ## Flow
 *
 *   1. `constructor` — stores configuration; does NOT touch the wallet.
 *   2. `publicKey` getter — triggers detection + access request, then caches
 *      the public key for the session.
 *   3. `signTransaction()` — hands the prepared XDR envelope to Freighter
 *      and returns the signed envelope as a base-64 string.
 *
 * ## Error handling
 *
 *   - `ILNError.WalletNotInstalled` — `window.freighterApi` is undefined
 *   - `ILNError.UserRejected`        — the user dismissed the Freighter prompt
 *   - `ILNError.NetworkMismatch`     — the wallet network differs from the
 *       configured network (e.g. wallet on mainnet but SDK on testnet)
 *
 * ## Network-mismatch detection
 *
 * Freighter returns the active network via `getNetwork()` (or
 * `getNetworkDetails()`). Before signing we compare it against the
 * configured `networkPassphrase` and throw `NetworkMismatch` when they
 * differ, avoiding hard-to-debug simulation failures downstream.
 */

import { Networks, SorobanRpc } from "@stellar/stellar-sdk";
import type { ISigner } from "./ISigner.js";
import type { Transaction } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Freighter browser API (subset of @stellar/freighter-api)
// ---------------------------------------------------------------------------

interface FreighterApi {
  isConnected(): Promise<boolean>;
  getPublicKey(): Promise<string>;
  getNetwork(): Promise<string>;
  signTransaction(
    xdr: string,
    opts?: { network?: string; networkPassphrase?: string }
  ): Promise<string>;
}

declare global {
  interface Window {
    freighterApi?: FreighterApi;
  }
}

// ---------------------------------------------------------------------------
// ILNError
// ---------------------------------------------------------------------------

/** SDK-level error with a machine-readable code. */
export class ILNError extends Error {
  public readonly code: ILNErrorCode;

  constructor(code: ILNErrorCode, message: string) {
    super(message);
    this.name = "ILNError";
    this.code = code;
  }

  static WalletNotInstalled(): ILNError {
    return new ILNError(
      ILNErrorCode.WalletNotInstalled,
      "Freighter is not installed. Please install the Freighter browser extension."
    );
  }

  static UserRejected(): ILNError {
    return new ILNError(
      ILNErrorCode.UserRejected,
      "The user rejected the Freighter request."
    );
  }

  static NetworkMismatch(expected: string, actual: string): ILNError {
    return new ILNError(
      ILNErrorCode.NetworkMismatch,
      `Network mismatch: SDK expects "${expected}" but Freighter is on "${actual}". Please switch your wallet network.`
    );
  }

  static NotConnected(): ILNError {
    return new ILNError(
      ILNErrorCode.NotConnected,
      "Freighter is locked or not connected. Please unlock the extension."
    );
  }
}

/** Error codes for programmatic handling. */
export enum ILNErrorCode {
  WalletNotInstalled = "WALLET_NOT_INSTALLED",
  UserRejected = "USER_REJECTED",
  NetworkMismatch = "NETWORK_MISMATCH",
  NotConnected = "NOT_CONNECTED",
  SigningFailed = "SIGNING_FAILED",
}

// ---------------------------------------------------------------------------
// Network passphrase ↔ Freighter network name mapping
// ---------------------------------------------------------------------------

const PASSPHRASE_TO_FREIGHTER: Record<string, string> = {
  [Networks.PUBLIC]: "PUBLIC",
  [Networks.TESTNET]: "TESTNET",
};

const FREIGHTER_TO_PASSPHRASE: Record<string, string> = {
  PUBLIC: Networks.PUBLIC,
  TESTNET: Networks.TESTNET,
  FUTURENET: "Test SDF Future Network ; October 2022",
};

// ---------------------------------------------------------------------------
// FreighterSigner
// ---------------------------------------------------------------------------

/**
 * Browser wallet signer backed by the Freighter extension.
 *
 * @example
 * ```ts
 * // Testnet
 * const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
 * console.log(signer.publicKey); // triggers Freighter access prompt
 *
 * // Mainnet
 * const signer = new FreighterSigner({ networkPassphrase: Networks.PUBLIC });
 *
 * // Sign a transaction
 * const signedXdr = await signer.signTransaction(tx, rpcServer);
 * ```
 */
export class FreighterSigner implements ISigner {
  private readonly _networkPassphrase: string;
  private _publicKey: string | null = null;
  private _accessRequested = false;

  /**
   * @param opts.networkPassphrase - Stellar network passphrase the SDK is
   *   targeting (e.g. `Networks.TESTNET`). Used to verify Freighter's active
   *   network before signing.
   */
  constructor(opts: { networkPassphrase: string }) {
    this._networkPassphrase = opts.networkPassphrase;
  }

  // --------------------------------------------------------------------------
  // ISigner
  // --------------------------------------------------------------------------

  /**
   * The Freighter account's G… public key.
   *
   * Returns an empty string `""` until `connect()` has been called
   * successfully. Use `isConnected` to check whether the public key is
   * available, or call `connect()` early (e.g. on page load) so the
   * key is populated before it's needed.
   */
  get publicKey(): string {
    return this._publicKey ?? "";
  }

  /**
   * Explicitly connect to Freighter, request access, and cache the public key.
   *
   * Call this early (e.g. on page load) so `publicKey` is available
   * synchronously afterwards.
   *
   * @returns The public key (G…)
   * @throws {ILNError} WalletNotInstalled | NotConnected | UserRejected | NetworkMismatch
   */
  async connect(): Promise<string> {
    this._ensureInstalled();

    if (!(await this._api().isConnected())) {
      // Freighter is installed but locked / not connected
      throw ILNError.NotConnected();
    }

    // Request access (shows Freighter prompt). Freighter's getPublicKey also
    // triggers the access prompt if not yet granted.
    const pk = await this._api().getPublicKey();

    if (!pk || pk.length === 0) {
      throw ILNError.UserRejected();
    }

    // Verify network
    await this._verifyNetwork();

    this._publicKey = pk;
    this._accessRequested = true;
    return pk;
  }

  /**
   * Simulate the transaction, then sign with Freighter and return the
   * signed XDR envelope.
   *
   * Steps:
   *  1. `server.prepareTransaction(tx)` — attaches Soroban footprint
   *  2. Serialize to base-64 XDR
   *  3. Pass to Freighter's `signTransaction`
   *  4. Return the signed XDR
   *
   * @param tx     - Unsigned transaction with Soroban operations
   * @param server - Soroban RPC server for simulation
   * @returns Signed base-64 XDR envelope
   * @throws {ILNError} WalletNotInstalled | NotConnected | UserRejected | NetworkMismatch
   */
  async signTransaction(
    tx: Transaction,
    server: SorobanRpc.Server
  ): Promise<string> {
    // Ensure we are connected
    if (!this._publicKey) {
      await this.connect();
    }

    // Step 1: simulate to get the footprint
    const preparedTx = await server.prepareTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(preparedTx as unknown as SorobanRpc.Api.SimulateTransactionResponse)) {
      throw new Error(
        `Soroban simulation failed: ${(preparedTx as unknown as { error: string }).error}`
      );
    }

    // Step 2: serialise to base-64 XDR
    const envelopeXdr = (preparedTx as unknown as { toEnvelope: () => { toXDR: (f: string) => string } }).toEnvelope()
      .toXDR("base64") as string;

    // Step 3: ask Freighter to sign
    const freighterNetwork = PASSPHRASE_TO_FREIGHTER[this._networkPassphrase];
    if (!freighterNetwork) {
      throw new Error(
        `Unknown network passphrase: ${this._networkPassphrase}`
      );
    }

    let signedXdr: string;
    try {
      signedXdr = await this._api().signTransaction(envelopeXdr, {
        network: freighterNetwork,
      });
    } catch (err: unknown) {
      throw this._classifySignError(err);
    }

    if (!signedXdr || signedXdr.length === 0) {
      throw ILNError.UserRejected();
    }

    return signedXdr;
  }

  // --------------------------------------------------------------------------
  // Accessors
  // --------------------------------------------------------------------------

  /** The configured network passphrase. */
  get networkPassphrase(): string {
    return this._networkPassphrase;
  }

  /** True once `connect()` has succeeded. */
  get isConnected(): boolean {
    return this._accessRequested && this._publicKey !== null;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /** Throw if the Freighter extension isn't installed. */
  private _ensureInstalled(): void {
    // Use a two-step type assertion to safely access the browser global.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (typeof g.window === "undefined" || !g.window.freighterApi) {
      throw ILNError.WalletNotInstalled();
    }
  }

  /** Return the Freighter API object (asserts it's installed). */
  private _api(): FreighterApi {
    this._ensureInstalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion
    return (globalThis as unknown as { window: any }).window.freighterApi!;
  }

  /**
   * Compare the wallet's active network against the configured passphrase.
   * Throws `NetworkMismatch` when they diverge.
   */
  private async _verifyNetwork(): Promise<void> {
    let walletNetwork: string;
    try {
      walletNetwork = await this._api().getNetwork();
    } catch {
      // Some older Freighter versions don't support getNetwork; skip check
      return;
    }

    const expectedPassphrase = FREIGHTER_TO_PASSPHRASE[walletNetwork];
    if (!expectedPassphrase) return; // unknown network; skip

    if (expectedPassphrase !== this._networkPassphrase) {
      throw ILNError.NetworkMismatch(
        this._networkPassphrase,
        expectedPassphrase
      );
    }
  }

  /** Classify a raw error from Freighter into a typed ILNError. */
  private _classifySignError(err: unknown): ILNError {
    const msg = typeof err === "string" ? err : (err as Error)?.message ?? "";

    const lowered = msg.toLowerCase();

    if (
      lowered.includes("rejected") ||
      lowered.includes("denied") ||
      lowered.includes("cancelled") ||
      lowered.includes("canceled")
    ) {
      return ILNError.UserRejected();
    }

    if (
      lowered.includes("network mismatch") ||
      (lowered.includes("network") && lowered.includes("switch"))
    ) {
      return ILNError.NetworkMismatch(this._networkPassphrase, "unknown");
    }

    return new ILNError(ILNErrorCode.SigningFailed, msg || "Freighter signing failed");
  }
}
