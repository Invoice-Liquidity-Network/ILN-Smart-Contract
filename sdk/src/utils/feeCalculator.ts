import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  Account,
  Address,
  nativeToScVal,
} from "@stellar/stellar-sdk";

/** Conversion factor: 1 XLM = 10,000,000 stroops */
const STROOPS_PER_XLM = 10_000_000n;

/** Result of a fee estimation call. */
export interface FeeEstimate {
  /** Fee in XLM, formatted to 7 decimal places. */
  feeXLM: string;
  /** Fee in stroops after applying the buffer multiplier. */
  feeStroops: bigint;
}

/** Options shared across all fee estimation functions. */
export interface FeeEstimateOptions {
  /**
   * Multiplier applied on top of the simulated `minResourceFee` to give
   * headroom against ledger-state changes between estimation and submission.
   * Defaults to `1.2` (20% buffer).
   */
  feeBuffer?: number;
}

/**
 * A Soroban operation produced by `Contract.call(...)`.
 * Typed as the return of `addOperation` so it integrates cleanly with
 * `TransactionBuilder`.
 */
export type SorobanOperation = ReturnType<Contract["call"]>;

// ---------------------------------------------------------------------------
// Core estimator
// ---------------------------------------------------------------------------

/**
 * Estimate the transaction fee for a single Soroban operation.
 *
 * Internally simulates the operation against the network to obtain the
 * `minResourceFee` (in stroops), then multiplies by `feeBuffer` (default 1.2×)
 * to avoid under-budget failures caused by ledger state changes between
 * estimation and submission.
 *
 * @param operation         - A Soroban contract call operation
 * @param server            - Soroban RPC server connected to the target network
 * @param sourceAccount     - Account used as the simulation source
 * @param networkPassphrase - Stellar network passphrase (defaults to TESTNET)
 * @param options           - Optional: `feeBuffer` multiplier (default 1.2)
 * @returns `{ feeXLM, feeStroops }` with the buffered fee
 *
 * @throws When the simulation returns an error response
 */
export async function estimateFee(
  operation: SorobanOperation,
  server: SorobanRpc.Server,
  sourceAccount: Account,
  networkPassphrase: string = Networks.TESTNET,
  options: FeeEstimateOptions = {}
): Promise<FeeEstimate> {
  const { feeBuffer = 1.2 } = options;

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);

  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Fee simulation failed: ${sim.error}`);
  }

  const baseFeeStroops = BigInt(sim.minResourceFee ?? "0");
  const bufferedStroops = BigInt(Math.ceil(Number(baseFeeStroops) * feeBuffer));

  const xlm = Number(bufferedStroops) / Number(STROOPS_PER_XLM);

  return {
    feeStroops: bufferedStroops,
    feeXLM: xlm.toFixed(7),
  };
}

// ---------------------------------------------------------------------------
// Convenience: estimate submit_invoice fee
// ---------------------------------------------------------------------------

/** Parameters accepted by `estimateSubmitFee`. */
export interface EstimateSubmitFeeParams {
  /** G-address of the invoice payer. */
  payer: string;
  /** Invoice amount in token base units. */
  amount: bigint;
  /** Token contract address (C…). */
  token: string;
  /** Discount rate in basis points (1–5000). */
  discountRate: number;
  /** Invoice due date as Unix timestamp (seconds). */
  dueDate: number;
  /** Optional referral code. */
  referralCode?: string;
}

/**
 * Estimate the fee for a `submit_invoice` contract call.
 *
 * @param params            - Invoice parameters mirroring `submitInvoice()`
 * @param server            - Soroban RPC server
 * @param contractAddress   - Deployed invoice-liquidity contract address
 * @param sourceAccount     - Account of the freelancer / submitter
 * @param networkPassphrase - Stellar network passphrase (defaults to TESTNET)
 * @param options           - Optional: `feeBuffer` multiplier (default 1.2)
 * @returns `{ feeXLM, feeStroops }` with the buffered fee
 */
export async function estimateSubmitFee(
  params: EstimateSubmitFeeParams,
  server: SorobanRpc.Server,
  contractAddress: string,
  sourceAccount: Account,
  networkPassphrase: string = Networks.TESTNET,
  options: FeeEstimateOptions = {}
): Promise<FeeEstimate> {
  const contract = new Contract(contractAddress);

  const op = contract.call(
    "submit_invoice",
    new Address(params.payer).toScVal(),
    nativeToScVal(params.amount, { type: "i128" }),
    new Address(params.token).toScVal(),
    nativeToScVal(params.discountRate, { type: "u32" }),
    nativeToScVal(params.dueDate, { type: "u64" }),
    nativeToScVal(params.referralCode ?? null, { type: "string" })
  );

  return estimateFee(op, server, sourceAccount, networkPassphrase, options);
}

// ---------------------------------------------------------------------------
// Convenience: estimate fund_invoice fee
// ---------------------------------------------------------------------------

/**
 * Estimate the fee for a `fund_invoice` contract call.
 *
 * @param invoiceId         - ID of the invoice to fund
 * @param lpAddress         - G-address of the liquidity provider
 * @param amount            - Amount to fund in token base units
 * @param server            - Soroban RPC server
 * @param contractAddress   - Deployed invoice-liquidity contract address
 * @param sourceAccount     - Account of the LP
 * @param networkPassphrase - Stellar network passphrase (defaults to TESTNET)
 * @param options           - Optional: `feeBuffer` multiplier (default 1.2)
 * @returns `{ feeXLM, feeStroops }` with the buffered fee
 */
export async function estimateFundFee(
  invoiceId: bigint,
  lpAddress: string,
  amount: bigint,
  server: SorobanRpc.Server,
  contractAddress: string,
  sourceAccount: Account,
  networkPassphrase: string = Networks.TESTNET,
  options: FeeEstimateOptions = {}
): Promise<FeeEstimate> {
  const contract = new Contract(contractAddress);

  const op = contract.call(
    "fund_invoice",
    new Address(lpAddress).toScVal(),
    nativeToScVal(invoiceId, { type: "u64" }),
    nativeToScVal(amount, { type: "i128" })
  );

  return estimateFee(op, server, sourceAccount, networkPassphrase, options);
}
