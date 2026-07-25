/**
 * Insurance pool queries — read status and configuration of the
 * default-protection insurance pool.
 */

import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Account,
  BASE_FEE,
  scValToNative,
  nativeToScVal,
  Address,
  Networks,
  Transaction,
} from "@stellar/stellar-sdk";
import { retry } from "../utils/retry.js";
import { validateGAddress, validateContractId } from "../utils/validate.js";
import type { InsurancePoolInfo } from "@invoice-liquidity/types";

/**
 * insurance_pool has its own `InsuranceError` enum (contracts/insurance_pool/src/lib.rs),
 * whose numeric codes are NOT the same as invoice_liquidity's error codes in
 * errors.ts — e.g. code 2 means AlreadyClaimed here but AlreadyFunded there.
 * Do not reuse `ILNError.fromError` for insurance pool calls; it would
 * silently attach the wrong message to a real error.
 */
export class InsuranceContractError extends Error {
  constructor(message: string, public readonly code?: number) {
    super(message);
    this.name = "InsuranceContractError";
  }

  static NotInitialized = class NotInitialized extends InsuranceContractError {
    constructor(msg = "Insurance pool not initialized") { super(msg, 1); }
  };
  static AlreadyClaimed = class AlreadyClaimed extends InsuranceContractError {
    constructor(msg = "Claim already processed for this invoice") { super(msg, 2); }
  };
  static InvalidAmount = class InvalidAmount extends InsuranceContractError {
    constructor(msg = "Premium/coverage amount must be positive") { super(msg, 3); }
  };
  static PoolEmpty = class PoolEmpty extends InsuranceContractError {
    constructor(msg = "Insurance pool has no balance to pay a claim") { super(msg, 4); }
  };
  static AlreadyInitialized = class AlreadyInitialized extends InsuranceContractError {
    constructor(msg = "Insurance pool already initialized") { super(msg, 5); }
  };

  static fromError(error: unknown): Error {
    const match = String(error).match(/Error\(Contract, (\d+)\)/);
    if (!match) return error instanceof Error ? error : new Error(String(error));
    switch (parseInt(match[1] || "", 10)) {
      case 1: return new InsuranceContractError.NotInitialized();
      case 2: return new InsuranceContractError.AlreadyClaimed();
      case 3: return new InsuranceContractError.InvalidAmount();
      case 4: return new InsuranceContractError.PoolEmpty();
      case 5: return new InsuranceContractError.AlreadyInitialized();
      default: return new InsuranceContractError(`Insurance pool error: ${String(error)}`);
    }
  }
}

/**
 * Build, simulate, sign, and submit a write operation against the insurance
 * pool contract.
 */
async function submitCall(
  server: SorobanRpc.Server,
  contractId: string,
  methodName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[],
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<{ txHash: string; retval: unknown }> {
  const contract = new Contract(contractId);
  const op = contract.call(methodName, ...args);

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await retry(() => server.simulateTransaction(tx));
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw InsuranceContractError.fromError(sim.error);
  }

  const assembledTx = SorobanRpc.assembleTransaction(tx, sim).build();
  const signedTx = await signTransaction(assembledTx);
  const sendResult = await retry(() => server.sendTransaction(signedTx));

  if (sendResult.errorResult) {
    throw new Error(`${methodName} transaction failed: ${sendResult.errorResult}`);
  }

  let status = await retry(() => server.getTransaction(sendResult.hash));
  let retries = 0;
  while (
    status.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND &&
    retries < 15
  ) {
    await new Promise((r) => setTimeout(r, 2000));
    status = await retry(() => server.getTransaction(sendResult.hash));
    retries++;
  }

  if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw new Error(`${methodName} transaction failed during execution`);
  }

  const retval =
    status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS && sim.result?.retval
      ? scValToNative(sim.result.retval)
      : undefined;

  return { txHash: sendResult.hash, retval };
}

/**
 * Helper to execute a read-only contract simulation call.
 */
async function simulateCall(
  server: SorobanRpc.Server,
  contractId: string,
  methodName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[] = [],
  networkPassphrase: string = Networks.TESTNET
) {
  const contract = new Contract(contractId);
  const op = contract.call(methodName, ...args);
  const sourceAccount = new Account(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "0"
  );
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await retry(() => server.simulateTransaction(tx));

  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw InsuranceContractError.fromError(sim.error);
  }

  return sim.result?.retval;
}

/**
 * Get the current insurance pool balance.
 *
 * @param server              - Soroban RPC server for the target network
 * @param contractId          - Deployed insurance pool contract address
 * @param networkPassphrase   - Stellar network passphrase (default: TESTNET)
 * @returns The current pool balance as a bigint
 */
export async function getPoolBalance(
  server: SorobanRpc.Server,
  contractId: string,
  networkPassphrase: string = Networks.TESTNET
): Promise<bigint> {
  validateContractId(contractId);
  const retval = await simulateCall(server, contractId, "get_pool_balance", [], networkPassphrase);
  if (!retval) {
    return 0n;
  }
  return scValToNative(retval) as bigint;
}

/**
 * Get the configured coverage cap.
 *
 * @param server              - Soroban RPC server for the target network
 * @param contractId          - Deployed insurance pool contract address
 * @param networkPassphrase   - Stellar network passphrase (default: TESTNET)
 * @returns The configured coverage cap as a bigint
 */
export async function getCoverage(
  server: SorobanRpc.Server,
  contractId: string,
  networkPassphrase: string = Networks.TESTNET
): Promise<bigint> {
  validateContractId(contractId);
  const retval = await simulateCall(server, contractId, "get_coverage", [], networkPassphrase);
  if (!retval) {
    return 0n;
  }
  return scValToNative(retval) as bigint;
}

/**
 * Check if a liquidity provider is enrolled in the insurance pool.
 *
 * @param server              - Soroban RPC server for the target network
 * @param contractId          - Deployed insurance pool contract address
 * @param lpAddress           - The LP's Stellar G... address
 * @param networkPassphrase   - Stellar network passphrase (default: TESTNET)
 * @returns True if enrolled, false otherwise
 */
export async function isEnrolled(
  server: SorobanRpc.Server,
  contractId: string,
  lpAddress: string,
  networkPassphrase: string = Networks.TESTNET
): Promise<boolean> {
  validateContractId(contractId);
  validateGAddress(lpAddress);
  const retval = await simulateCall(
    server,
    contractId,
    "is_enrolled",
    [new Address(lpAddress).toScVal()],
    networkPassphrase
  );
  if (!retval) {
    return false;
  }
  return scValToNative(retval) as boolean;
}

/**
 * Get total premiums paid by an LP.
 *
 * @param server              - Soroban RPC server for the target network
 * @param contractId          - Deployed insurance pool contract address
 * @param lpAddress           - The LP's Stellar G... address
 * @param networkPassphrase   - Stellar network passphrase (default: TESTNET)
 * @returns The total premiums paid as a bigint
 */
export async function getPremiumsPaid(
  server: SorobanRpc.Server,
  contractId: string,
  lpAddress: string,
  networkPassphrase: string = Networks.TESTNET
): Promise<bigint> {
  validateContractId(contractId);
  validateGAddress(lpAddress);
  const retval = await simulateCall(
    server,
    contractId,
    "get_premiums_paid",
    [new Address(lpAddress).toScVal()],
    networkPassphrase
  );
  if (!retval) {
    return 0n;
  }
  return scValToNative(retval) as bigint;
}

/**
 * Get all insurance pool info for an LP in a single call.
 *
 * @param server              - Soroban RPC server for the target network
 * @param contractId          - Deployed insurance pool contract address
 * @param lpAddress           - The LP's Stellar G... address
 * @param networkPassphrase   - Stellar network passphrase (default: TESTNET)
 * @returns Combined InsurancePoolInfo object
 */
export async function getInsurancePoolInfo(
  server: SorobanRpc.Server,
  contractId: string,
  lpAddress: string,
  networkPassphrase: string = Networks.TESTNET
): Promise<InsurancePoolInfo> {
  validateContractId(contractId);
  validateGAddress(lpAddress);
  const [poolBalance, coverage, isEnrolledVal, premiumsPaid] = await Promise.all([
    getPoolBalance(server, contractId, networkPassphrase),
    getCoverage(server, contractId, networkPassphrase),
    isEnrolled(server, contractId, lpAddress, networkPassphrase),
    getPremiumsPaid(server, contractId, lpAddress, networkPassphrase),
  ]);

  return {
    poolBalance,
    coverage,
    isEnrolled: isEnrolledVal,
    premiumsPaid,
  };
}

// ---------------------------------------------------------------------------
// Write operations (#475)
// ---------------------------------------------------------------------------

/**
 * Enroll a liquidity provider in the insurance pool.
 *
 * Wraps the `enroll(lp)` write function. Requires `lp`'s signature —
 * `sourceAccount` must be `lp`'s account.
 *
 * @param server              - Soroban RPC server for the target network
 * @param contractId          - Deployed insurance pool contract address
 * @param lpAddress           - The LP's Stellar G... address (must match sourceAccount)
 * @param sourceAccount       - The LP's account (signs and pays the tx fee)
 * @param signTransaction     - Function to sign the assembled transaction
 * @param networkPassphrase   - Stellar network passphrase (default: TESTNET)
 * @returns The submitted transaction hash
 */
export async function enrollInsurancePool(
  server: SorobanRpc.Server,
  contractId: string,
  lpAddress: string,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string = Networks.TESTNET
): Promise<{ txHash: string }> {
  validateContractId(contractId);
  validateGAddress(lpAddress);
  const { txHash } = await submitCall(
    server,
    contractId,
    "enroll",
    [new Address(lpAddress).toScVal()],
    sourceAccount,
    signTransaction,
    networkPassphrase
  );
  return { txHash };
}

/**
 * Deposit a premium payment into the insurance pool, auto-enrolling the LP
 * on first payment.
 *
 * Wraps the `deposit_premium(lp, amount)` write function. Requires `lp`'s
 * signature — `sourceAccount` must be `lp`'s account.
 *
 * @param server              - Soroban RPC server for the target network
 * @param contractId          - Deployed insurance pool contract address
 * @param lpAddress           - The LP's Stellar G... address (must match sourceAccount)
 * @param amount              - Premium amount (must be > 0); throws InsuranceContractError.InvalidAmount otherwise
 * @param sourceAccount       - The LP's account (signs and pays the tx fee)
 * @param signTransaction     - Function to sign the assembled transaction
 * @param networkPassphrase   - Stellar network passphrase (default: TESTNET)
 * @returns The submitted transaction hash
 */
export async function depositInsurancePremium(
  server: SorobanRpc.Server,
  contractId: string,
  lpAddress: string,
  amount: bigint,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string = Networks.TESTNET
): Promise<{ txHash: string }> {
  validateContractId(contractId);
  validateGAddress(lpAddress);
  if (amount <= 0n) {
    throw new InsuranceContractError.InvalidAmount();
  }
  const { txHash } = await submitCall(
    server,
    contractId,
    "deposit_premium",
    [new Address(lpAddress).toScVal(), nativeToScVal(amount, { type: "i128" })],
    sourceAccount,
    signTransaction,
    networkPassphrase
  );
  return { txHash };
}

/**
 * File an insurance claim for a defaulted invoice, compensating the LP from
 * the pool balance (up to the configured coverage cap).
 *
 * Wraps the `claim(invoice_id)` write function. **Admin-only**: the
 * contract's `require_admin` check means `sourceAccount` must be the
 * address the pool was `initialize`d with — not the affected LP or any
 * arbitrary caller. In production this is expected to be the
 * invoice_liquidity contract acting on a confirmed default.
 *
 * @param server              - Soroban RPC server for the target network
 * @param contractId          - Deployed insurance pool contract address
 * @param invoiceId           - The defaulted invoice's ID
 * @param sourceAccount       - The pool admin's account (signs and pays the tx fee)
 * @param signTransaction     - Function to sign the assembled transaction
 * @param networkPassphrase   - Stellar network passphrase (default: TESTNET)
 * @returns The submitted transaction hash and the payout amount
 * @throws {InsuranceContractError.AlreadyClaimed} If a claim was already processed for this invoice
 * @throws {InsuranceContractError.PoolEmpty} If the pool has no balance
 */
export async function claimInsurance(
  server: SorobanRpc.Server,
  contractId: string,
  invoiceId: bigint,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string = Networks.TESTNET
): Promise<{ txHash: string; payout: bigint }> {
  validateContractId(contractId);
  const { txHash, retval } = await submitCall(
    server,
    contractId,
    "claim",
    [nativeToScVal(invoiceId, { type: "u64" })],
    sourceAccount,
    signTransaction,
    networkPassphrase
  );
  return { txHash, payout: (retval as bigint | undefined) ?? 0n };
}
