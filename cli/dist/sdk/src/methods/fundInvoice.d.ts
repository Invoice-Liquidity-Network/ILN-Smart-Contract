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
import { SorobanRpc, Keypair } from "@stellar/stellar-sdk";
import type { FundOptions, FundResult } from "../types.js";
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
export declare function computeEffectiveYieldBps(discountRateBps: number, dueDateUnix: number, nowUnix?: number): number;
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
export declare function fundInvoice(server: SorobanRpc.Server, contractAddress: string, lpKeypair: Keypair, invoiceId: bigint, options?: FundOptions, networkPassphrase?: string): Promise<FundResult>;
//# sourceMappingURL=fundInvoice.d.ts.map