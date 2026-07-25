"use strict";
/**
 * getContractStats — fetch protocol-wide statistics from the contract.
 *
 * Reads the single `get_contract_stats()` view call. No signer or
 * transaction fees required (read-only simulation).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getContractStats = getContractStats;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const retry_js_1 = require("../utils/retry.js");
const xdrDecoder_js_1 = require("../utils/xdrDecoder.js");
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
async function getContractStats(server, contractId, networkPassphrase = stellar_sdk_1.Networks.TESTNET) {
    const contract = new stellar_sdk_1.Contract(contractId);
    const op = contract.call("get_contract_stats");
    const sourceAccount = new stellar_sdk_1.Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0");
    const simTx = new stellar_sdk_1.TransactionBuilder(sourceAccount, {
        fee: stellar_sdk_1.BASE_FEE,
        networkPassphrase,
    })
        .addOperation(op)
        .setTimeout(30)
        .build();
    const sim = await (0, retry_js_1.retry)(() => server.simulateTransaction(simTx));
    if (stellar_sdk_1.SorobanRpc.Api.isSimulationError(sim)) {
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
    const raw = (0, stellar_sdk_1.scValToNative)(sim.result.retval);
    return (0, xdrDecoder_js_1.decodeContractStats)(raw);
}
//# sourceMappingURL=stats.js.map