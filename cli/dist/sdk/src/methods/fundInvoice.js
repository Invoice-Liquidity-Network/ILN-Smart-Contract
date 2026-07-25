"use strict";
// @ts-nocheck
/**
 * fundInvoice — LP-facing SDK method for the Invoice Liquidity Network.
 *
 * Handles the full two-step allowance + funding flow automatically:
 *   1. Fetch the invoice to determine the token and amount required.
 *   2. Query the LP's current token allowance for the contract.
 *   3. If insufficient, build, sign and submit an `approve` transaction.
 *   4. Build, sign and submit the `fund_invoice` contract call.
 *   5. Return `{ txHash, effectiveYieldBps }`.
 *
 * Progress is surfaced via optional callbacks on FundOptions so integrators
 * can update UI without polling.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeEffectiveYieldBps = computeEffectiveYieldBps;
exports.fundInvoice = fundInvoice;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const allowance_js_1 = require("../utils/allowance.js");
const retry_js_1 = require("../utils/retry.js");
// ---------------------------------------------------------------------------
// computeEffectiveYieldBps (exported for consumers and tests)
// ---------------------------------------------------------------------------
/**
 * Compute the annualised effective yield in basis points for an LP position.
 *
 *   effectiveYieldBps = discountRate × daysToMaturity / 365
 *
 * Returns `0` when the due date is already in the past.
 *
 * @param discountRateBps - Invoice discount rate in basis points (e.g. 300 = 3%)
 * @param dueDateUnix     - Invoice due date as Unix timestamp (seconds)
 * @param nowUnix         - Current time as Unix timestamp; defaults to Date.now()
 */
function computeEffectiveYieldBps(discountRateBps, dueDateUnix, nowUnix = Math.floor(Date.now() / 1000)) {
    const secondsToMaturity = Math.max(0, dueDateUnix - nowUnix);
    const daysToMaturity = secondsToMaturity / 86400;
    return Math.round((discountRateBps * daysToMaturity) / 365);
}
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
/** Simulate get_invoice and decode the result into InvoiceView. */
async function fetchInvoice(server, contractAddress, invoiceId, sourceAccount, networkPassphrase) {
    const contract = new stellar_sdk_1.Contract(contractAddress);
    const op = contract.call("get_invoice", (0, stellar_sdk_1.nativeToScVal)(invoiceId, { type: "u64" }));
    const tx = new stellar_sdk_1.TransactionBuilder(sourceAccount, {
        fee: stellar_sdk_1.BASE_FEE,
        networkPassphrase,
    })
        .addOperation(op)
        .setTimeout(30)
        .build();
    const sim = await (0, retry_js_1.retry)(() => server.simulateTransaction(tx));
    if (stellar_sdk_1.SorobanRpc.Api.isSimulationError(sim)) {
        throw new Error(`get_invoice simulation failed: ${sim.error}`);
    }
    if (!sim.result?.retval) {
        throw new Error(`Invoice ${invoiceId} not found`);
    }
    const raw = (0, stellar_sdk_1.scValToNative)(sim.result.retval);
    return {
        id: BigInt(String(raw["id"])),
        token: String(raw["token"]),
        amount: BigInt(String(raw["amount"])),
        dueDate: Number(raw["due_date"]),
        discountRate: Number(raw["discount_rate"]),
        status: String(raw["status"]),
    };
}
/**
 * Sign a base64-XDR transaction envelope with `signer` and submit it.
 * Returns the transaction hash on success.
 *
 * @throws When the network returns `status: "ERROR"`.
 */
async function signAndSubmit(server, envelopeXdr, signer, networkPassphrase) {
    const tx = new stellar_sdk_1.Transaction(envelopeXdr, networkPassphrase);
    tx.sign(signer);
    const result = await server.sendTransaction(tx);
    if (result.status === "ERROR") {
        throw new Error(`Transaction failed: ${JSON.stringify(result.errorResult)}`);
    }
    return result.hash;
}
/**
 * Verify that the contract has a price oracle configured and that the
 * simulation does not error. Acts as a guard when
 * `requireOracleVerification: true`.
 */
async function verifyOracle(server, contractAddress, sourceAccount, networkPassphrase) {
    const contract = new stellar_sdk_1.Contract(contractAddress);
    const op = contract.call("get_price_oracle");
    const tx = new stellar_sdk_1.TransactionBuilder(sourceAccount, {
        fee: stellar_sdk_1.BASE_FEE,
        networkPassphrase,
    })
        .addOperation(op)
        .setTimeout(30)
        .build();
    const sim = await (0, retry_js_1.retry)(() => server.simulateTransaction(tx));
    if (stellar_sdk_1.SorobanRpc.Api.isSimulationError(sim)) {
        throw new Error(`Oracle verification failed: ${sim.error}`);
    }
    if (!sim.result?.retval) {
        throw new Error("Oracle verification required but no price oracle is configured on the contract");
    }
    const oracleAddress = (0, stellar_sdk_1.scValToNative)(sim.result.retval);
    if (!oracleAddress) {
        throw new Error("Oracle verification required but no price oracle is configured on the contract");
    }
}
// ---------------------------------------------------------------------------
// fundInvoice
// ---------------------------------------------------------------------------
/**
 * Fund an invoice as a liquidity provider.
 *
 * Automatically manages the token allowance before calling `fund_invoice`
 * on-chain. When an `approve` transaction is needed, `onApprovalRequired`
 * fires first (so the UI can show a prompt), and `onApprovalSent` fires
 * after the approval is submitted. `onFunded` fires once the fund transaction
 * is sent.
 *
 * @param server              - Soroban RPC server connected to the target network
 * @param contractAddress     - Deployed invoice-liquidity contract address
 * @param lpKeypair           - Keypair of the liquidity provider (signs all txs)
 * @param invoiceId           - ID of the invoice to fund
 * @param options             - Optional configuration and progress callbacks:
 *   - `requireOracleVerification` — reject if the contract has no price oracle
 *   - `onApprovalRequired`        — fired before the approve tx is built
 *   - `onApprovalSent`            — fired after the approve tx is submitted
 *   - `onFunded`                  — fired after the fund tx is submitted
 * @param networkPassphrase   - Stellar network passphrase (default: TESTNET)
 *
 * @returns `{ txHash, effectiveYieldBps }` on success
 *
 * @throws When the invoice is not fundable (wrong status, not found, etc.)
 * @throws When the approve or fund transaction is rejected by the network
 * @throws When oracle verification is required but fails
 *
 * @example
 * ```ts
 * const result = await fundInvoice(server, CONTRACT_ID, lpKeypair, 42n, {
 *   onApprovalRequired: ({ requiredAmount, currentAllowance }) =>
 *     console.log(`Need to approve ${requiredAmount}, have ${currentAllowance}`),
 *   onApprovalSent: ({ approveTxHash }) =>
 *     console.log(`Approval submitted: ${approveTxHash}`),
 *   onFunded: ({ effectiveYieldBps, invoiceId }) =>
 *     console.log(`Invoice ${invoiceId} funded! Yield: ${effectiveYieldBps} bps`),
 * });
 * ```
 */
async function fundInvoice(server, contractAddress, lpKeypair, invoiceId, options = {}, networkPassphrase = stellar_sdk_1.Networks.TESTNET) {
    const { requireOracleVerification = false, onApprovalRequired, onApprovalSent, onFunded, } = options;
    // 1. Load the LP's on-chain account (for sequence numbers)
    const lpAddress = lpKeypair.publicKey();
    const accountData = await (0, retry_js_1.retry)(() => server.getAccount(lpAddress));
    let sequence = accountData.sequence;
    const makeAccount = (seq) => new stellar_sdk_1.Account(lpAddress, seq);
    // 2. Fetch the invoice
    const invoice = await fetchInvoice(server, contractAddress, invoiceId, makeAccount(sequence), networkPassphrase);
    if (invoice.status !== "Pending" && invoice.status !== "PartiallyFunded") {
        throw new Error(`Invoice ${invoiceId} cannot be funded (status: ${invoice.status})`);
    }
    // 3. Oracle guard (optional)
    if (requireOracleVerification) {
        await verifyOracle(server, contractAddress, makeAccount(sequence), networkPassphrase);
    }
    // 4. Allowance check
    const ledgerInfo = await (0, retry_js_1.retry)(() => server.getLatestLedger());
    const currentLedger = ledgerInfo.sequence;
    const allowance = await (0, allowance_js_1.getAllowance)(server, { tokenAddress: invoice.token, owner: lpAddress, spender: contractAddress }, makeAccount(sequence));
    const needsApproval = !(0, allowance_js_1.isAllowanceSufficient)(allowance, invoice.amount, currentLedger + 10 // require at least 10 ledgers validity remaining
    );
    if (needsApproval) {
        // 5a. Notify caller
        onApprovalRequired?.({
            requiredAmount: invoice.amount,
            currentAllowance: allowance.amount,
        });
        // 5b. Build, sign and submit the approve tx
        const approveXdr = await (0, allowance_js_1.buildApproveTransaction)(server, invoice.token, makeAccount(sequence), contractAddress, invoice.amount, networkPassphrase);
        const approveTxHash = await signAndSubmit(server, approveXdr, lpKeypair, networkPassphrase);
        onApprovalSent?.({ approveTxHash });
        // Bump sequence: the approve tx consumed one number
        sequence = String(BigInt(sequence) + 1n);
    }
    // 6. Build the fund_invoice call
    const contract = new stellar_sdk_1.Contract(contractAddress);
    const fundOp = contract.call("fund_invoice", new stellar_sdk_1.Address(lpAddress).toScVal(), (0, stellar_sdk_1.nativeToScVal)(invoiceId, { type: "u64" }), (0, stellar_sdk_1.nativeToScVal)(invoice.amount, { type: "i128" }));
    const fundTx = new stellar_sdk_1.TransactionBuilder(makeAccount(sequence), {
        fee: stellar_sdk_1.BASE_FEE,
        networkPassphrase,
    })
        .addOperation(fundOp)
        .setTimeout(30)
        .build();
    const preparedFundTx = await (0, retry_js_1.retry)(() => server.prepareTransaction(fundTx));
    preparedFundTx.sign(lpKeypair);
    const fundSendResult = await (0, retry_js_1.retry)(() => server.sendTransaction(preparedFundTx));
    if (fundSendResult.status === "ERROR") {
        throw new Error(`fund_invoice failed: ${JSON.stringify(fundSendResult.errorResult)}`);
    }
    // 7. Compute annualised yield and notify
    const effectiveYieldBps = computeEffectiveYieldBps(invoice.discountRate, invoice.dueDate);
    onFunded?.({ effectiveYieldBps, invoiceId });
    return { txHash: fundSendResult.hash, effectiveYieldBps };
}
//# sourceMappingURL=fundInvoice.js.map