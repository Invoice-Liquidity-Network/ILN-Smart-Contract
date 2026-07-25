"use strict";
// @ts-nocheck
/**
 * Allowance utilities for SEP-41 / Stellar Asset Contract tokens.
 *
 * Abstracts the "check allowance → approve if needed" pattern so callers
 * (e.g. fundInvoice) don't need to deal with raw XDR or Soroban operation
 * building directly.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAllowance = getAllowance;
exports.buildApproveTransaction = buildApproveTransaction;
exports.isAllowanceSufficient = isAllowanceSufficient;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
// ---------------------------------------------------------------------------
// getAllowance
// ---------------------------------------------------------------------------
/**
 * Query the current SEP-41 token allowance granted by `owner` to `spender`.
 *
 * Calls `allowance(from, spender)` on the token contract and decodes the
 * return value. Both the struct form `{ amount, expiration_ledger }` (SEP-41)
 * and plain `i128` (older SAC) are handled.
 *
 * @param server         - Soroban RPC server instance
 * @param params         - Token address, owner, and spender addresses
 * @param sourceAccount  - Account used as the simulation source (sequence consumed)
 * @returns AllowanceResult with `amount` (bigint) and `expirationLedger`
 *
 * @throws When the RPC simulation returns an error response
 */
async function getAllowance(server, params, sourceAccount) {
    const tokenContract = new stellar_sdk_1.Contract(params.tokenAddress);
    const op = tokenContract.call("allowance", new stellar_sdk_1.Address(params.owner).toScVal(), new stellar_sdk_1.Address(params.spender).toScVal());
    const tx = new stellar_sdk_1.TransactionBuilder(sourceAccount, {
        fee: stellar_sdk_1.BASE_FEE,
        networkPassphrase: stellar_sdk_1.Networks.TESTNET,
    })
        .addOperation(op)
        .setTimeout(30)
        .build();
    const simResult = await server.simulateTransaction(tx);
    if (stellar_sdk_1.SorobanRpc.Api.isSimulationError(simResult)) {
        throw new Error(`Allowance simulation failed: ${simResult.error}`);
    }
    if (!simResult.result?.retval) {
        return { amount: 0n, expirationLedger: 0 };
    }
    const native = (0, stellar_sdk_1.scValToNative)(simResult.result.retval);
    // SEP-41: allowance returns { amount: i128, expiration_ledger: u32 }
    if (typeof native === "object" && native !== null && "amount" in native) {
        const obj = native;
        return {
            amount: BigInt(String(obj["amount"])),
            expirationLedger: Number(obj["expiration_ledger"] ?? 0),
        };
    }
    // Older SAC: plain i128
    return {
        amount: BigInt(String(native)),
        expirationLedger: 0,
    };
}
// ---------------------------------------------------------------------------
// buildApproveTransaction
// ---------------------------------------------------------------------------
/**
 * Build a prepared (but unsigned) `approve` transaction envelope for a
 * SEP-41 token contract.
 *
 * The returned base64-XDR string must be signed by the token owner's keypair
 * before submission.
 *
 * Expiration is set to `currentLedger + 720` (≈ 1 hour at ~2s/ledger).
 *
 * @param server             - Soroban RPC server instance
 * @param tokenAddress       - Token contract address
 * @param ownerAccount       - Account object for the token owner (the LP)
 * @param spenderAddress     - Address to approve (the invoice-liquidity contract)
 * @param amount             - Amount to approve in token base units
 * @param networkPassphrase  - Stellar network passphrase (defaults to TESTNET)
 * @returns Base64-encoded XDR of the prepared transaction envelope
 *
 * @throws When the Soroban RPC `prepareTransaction` call fails
 */
async function buildApproveTransaction(server, tokenAddress, ownerAccount, spenderAddress, amount, networkPassphrase = stellar_sdk_1.Networks.TESTNET) {
    const tokenContract = new stellar_sdk_1.Contract(tokenAddress);
    // expiration_ledger ≈ now + 1 hour (720 ledgers @ ~5s/ledger)
    const ledgerInfo = await server.getLatestLedger();
    const expirationLedger = ledgerInfo.sequence + 720;
    const op = tokenContract.call("approve", new stellar_sdk_1.Address(ownerAccount.accountId()).toScVal(), new stellar_sdk_1.Address(spenderAddress).toScVal(), (0, stellar_sdk_1.nativeToScVal)(amount, { type: "i128" }), (0, stellar_sdk_1.nativeToScVal)(expirationLedger, { type: "u32" }));
    const tx = new stellar_sdk_1.TransactionBuilder(ownerAccount, {
        fee: stellar_sdk_1.BASE_FEE,
        networkPassphrase,
    })
        .addOperation(op)
        .setTimeout(30)
        .build();
    const preparedTx = await server.prepareTransaction(tx);
    return preparedTx.toEnvelope().toXDR("base64");
}
// ---------------------------------------------------------------------------
// isAllowanceSufficient
// ---------------------------------------------------------------------------
/**
 * Returns `true` when the given allowance satisfies both requirements:
 *   1. `allowance.amount >= required`
 *   2. The allowance will not expire before `minExpirationLedger` (when
 *      provided). An `expirationLedger` of `0` is treated as "no expiry
 *      stored" and always passes the expiry check.
 *
 * @param allowance           - Current allowance from getAllowance()
 * @param required            - Minimum amount needed (in token base units)
 * @param minExpirationLedger - Optional: require the allowance to remain
 *                              valid at least until this ledger sequence
 */
function isAllowanceSufficient(allowance, required, minExpirationLedger) {
    if (allowance.amount < required)
        return false;
    if (minExpirationLedger !== undefined &&
        allowance.expirationLedger > 0 &&
        allowance.expirationLedger < minExpirationLedger) {
        return false;
    }
    return true;
}
//# sourceMappingURL=allowance.js.map