import type { Transaction, SorobanRpc } from "@stellar/stellar-sdk";
/**
 * Common signer interface for all SDK signing adapters.
 *
 * Implement this interface to plug in browser wallets (Freighter, Albedo)
 * or server-side signers (KeypairSigner) without changing call-site code.
 */
export interface ISigner {
    /** Stellar public key (G…) of the signing account. */
    readonly publicKey: string;
    /**
     * Simulate the transaction against a Soroban RPC node to obtain the
     * Soroban footprint, then sign the prepared transaction and return the
     * signed XDR envelope as a base-64 string.
     *
     * Implementations must:
     *   1. Call `server.prepareTransaction(tx)` to attach the footprint.
     *   2. Sign the prepared transaction with the underlying credentials.
     *   3. Return `signedTx.toEnvelope().toXDR("base64")`.
     *
     * @param tx     - Unsigned Stellar transaction (already has operations)
     * @param server - Soroban RPC server used for simulation
     * @returns Base-64 XDR of the signed transaction envelope
     */
    signTransaction(tx: Transaction, server: SorobanRpc.Server): Promise<string>;
}
//# sourceMappingURL=ISigner.d.ts.map