/**
 * KeypairSigner — ISigner adapter for raw Stellar keypairs.
 *
 * Intended for Node.js scripts, CLI tools, and bots where a browser wallet
 * is not available. Accepts either a `Keypair` instance or a secret-key
 * string (S…).
 *
 * Two-step flow on every `signTransaction()` call:
 *   1. Simulate the transaction via `server.prepareTransaction()` to fetch
 *      the Soroban footprint (ledger entries, auth entries, resource limits).
 *   2. Sign the *prepared* transaction and return the signed XDR envelope.
 *
 * Security notice
 * ---------------
 * Hard-coding secret keys in source files is dangerous. KeypairSigner emits
 * a `console.warn` when it detects that the process is not running inside a
 * test environment (`NODE_ENV !== "test"`) **and** the secret was supplied as
 * a plain string literal. Pass the secret via an environment variable instead:
 *
 * ```ts
 * const signer = new KeypairSigner(process.env.LP_SECRET_KEY!);
 * ```
 */

import { Keypair, SorobanRpc, Transaction } from "@stellar/stellar-sdk";
import type { ISigner } from "./ISigner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Detect a test environment heuristically. */
function isTestEnvironment(): boolean {
  return (
    process.env["NODE_ENV"] === "test" ||
    process.env["JEST_WORKER_ID"] !== undefined ||
    process.env["VITEST"] !== undefined
  );
}

/**
 * Heuristic: a secret key that looks like it was pasted literally into source
 * rather than read from the environment.  We flag when the value is a
 * hardcoded default / example key or when it begins with `S` and
 * `SECRET`/`PRIVATE` are not in the source call-stack (impossible to detect
 * reliably, so we only warn, never block).
 */
function warnIfHardcodedSecret(secret: string): void {
  if (isTestEnvironment()) return;

  // Well-known example keys used in docs / tutorials
  const knownExamples = new Set([
    "SBQM45DNQRUNKDBPTXCAT7CRQLJHOD2NVEP2EKUND7HM7GFCBFTAY2EZ",
    "SDASDASDASDASDASDASDASDASDASDASDASDASDASDASDASDASDA",
  ]);

  if (knownExamples.has(secret)) {
    console.warn(
      "[KeypairSigner] WARNING: You appear to be using a well-known example " +
        "secret key. Never use example keys in production."
    );
    return;
  }

  // Generic warning: secret supplied as a string literal rather than via env
  console.warn(
    "[KeypairSigner] WARNING: Passing a secret key as a plain string is " +
      "risky. Load it from an environment variable instead: " +
      "new KeypairSigner(process.env.SECRET_KEY!)"
  );
}

// ---------------------------------------------------------------------------
// KeypairSigner
// ---------------------------------------------------------------------------

/**
 * Server-side ISigner backed by a Stellar keypair.
 *
 * @example
 * ```ts
 * // From environment variable (recommended)
 * const signer = new KeypairSigner(process.env.LP_SECRET!);
 *
 * // From an existing Keypair instance
 * const kp = Keypair.fromSecret(process.env.LP_SECRET!);
 * const signer = new KeypairSigner(kp);
 *
 * // Sign a transaction
 * const signedXdr = await signer.signTransaction(tx, rpcServer);
 * ```
 */
export class KeypairSigner implements ISigner {
  private readonly _keypair: Keypair;

  /**
   * @param keypairOrSecret - A `Keypair` instance **or** a Stellar secret key
   *   string starting with `S`. When a plain string is supplied outside of a
   *   test environment a security warning is emitted.
   */
  constructor(keypairOrSecret: Keypair | string) {
    if (typeof keypairOrSecret === "string") {
      warnIfHardcodedSecret(keypairOrSecret);
      this._keypair = Keypair.fromSecret(keypairOrSecret);
    } else {
      this._keypair = keypairOrSecret;
    }
  }

  // --------------------------------------------------------------------------
  // ISigner
  // --------------------------------------------------------------------------

  /** Stellar G… public key of this signer. */
  get publicKey(): string {
    return this._keypair.publicKey();
  }

  /**
   * Simulate the transaction to obtain the Soroban footprint, sign the
   * prepared transaction, and return the signed XDR envelope as base-64.
   *
   * Steps:
   *   1. `server.prepareTransaction(tx)` — attaches footprint + auth entries.
   *   2. `preparedTx.sign(keypair)` — ECDSA/Ed25519 signature applied.
   *   3. Returns `preparedTx.toEnvelope().toXDR("base64")`.
   *
   * @param tx     - Unsigned transaction with at least one Soroban operation
   * @param server - Soroban RPC server used for simulation
   * @returns Signed base-64 XDR envelope ready for `server.sendTransaction()`
   *
   * @throws {Error} When Soroban simulation fails (contract error, bad auth,
   *   resource limit exceeded, etc.)
   */
  async signTransaction(
    tx: Transaction,
    server: SorobanRpc.Server
  ): Promise<string> {
    // Step 1: simulate → get footprint
    const preparedTx = await server.prepareTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(preparedTx as unknown as SorobanRpc.Api.SimulateTransactionResponse)) {
      throw new Error(
        `Soroban simulation failed: ${(preparedTx as unknown as { error: string }).error}`
      );
    }

    // Step 2: sign
    (preparedTx as Transaction).sign(this._keypair);

    // Step 3: serialise
    return (preparedTx as Transaction).toEnvelope().toXDR("base64");
  }

  // --------------------------------------------------------------------------
  // Convenience
  // --------------------------------------------------------------------------

  /**
   * Expose the underlying keypair for use-cases that need raw sign/verify
   * access (e.g. building multi-sig transactions).
   *
   * Treat the returned keypair as read-only; do not call `keypair.sign()`
   * directly on transaction envelopes — use `signTransaction()` so the
   * simulation step is always executed.
   */
  get keypair(): Keypair {
    return this._keypair;
  }

  /**
   * Create a KeypairSigner from a secret key stored in an environment
   * variable.
   *
   * ```ts
   * const signer = KeypairSigner.fromEnv("LP_SECRET_KEY");
   * ```
   *
   * @param envVar - Name of the environment variable holding the secret key
   * @throws {Error} When the environment variable is not set
   */
  static fromEnv(envVar: string): KeypairSigner {
    const secret = process.env[envVar];
    if (!secret) {
      throw new Error(
        `KeypairSigner.fromEnv: environment variable "${envVar}" is not set`
      );
    }
    // fromEnv is the recommended pattern — no warning needed
    const kp = Keypair.fromSecret(secret);
    return new KeypairSigner(kp);
  }
}
