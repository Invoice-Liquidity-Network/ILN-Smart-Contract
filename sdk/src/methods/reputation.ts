/**
 * getReputation — read an address's detailed reputation profile from
 * the on-chain invoice-liquidity contract.
 *
 * Wraps the `get_reputation(address)` view function. Unknown addresses
 * return a zeroed profile (matching the contract's lazy-init behaviour).
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
import { decodeReputationScore, type ReputationProfile } from "../utils/xdrDecoder.js";

/**
 * reputation_bonus has its own `ContractError` enum
 * (contracts/reputation_bonus/src/errors.rs) whose numeric codes are NOT the
 * same as invoice_liquidity's error codes in errors.ts or insurance_pool's —
 * e.g. code 2 means InvoiceNotFound here. Don't reuse the other contracts'
 * error mappers for reputation_bonus calls.
 */
export class ReputationContractError extends Error {
  constructor(message: string, public readonly code?: number) {
    super(message);
    this.name = "ReputationContractError";
  }

  static ArithmeticError = class ArithmeticError extends ReputationContractError {
    constructor(msg = "Arithmetic error") { super(msg, 1); }
  };
  static InvoiceNotFound = class InvoiceNotFound extends ReputationContractError {
    constructor(msg = "Invoice not found") { super(msg, 2); }
  };
  static IllegalState = class IllegalState extends ReputationContractError {
    constructor(msg = "Invoice is not in a state that allows this operation") { super(msg, 3); }
  };
  static ConfigErrorUnauthorized = class ConfigErrorUnauthorized extends ReputationContractError {
    constructor(msg = "Unauthorized config change") { super(msg, 4); }
  };
  static ConfigErrorInvalidBonusBps = class ConfigErrorInvalidBonusBps extends ReputationContractError {
    constructor(msg = "Invalid bonus bps in config") { super(msg, 5); }
  };
  static ConfigErrorInvalidMinDiscountRate = class ConfigErrorInvalidMinDiscountRate extends ReputationContractError {
    constructor(msg = "Invalid minimum discount rate in config") { super(msg, 6); }
  };
  static RateErrorArithmeticUnderflow = class RateErrorArithmeticUnderflow extends ReputationContractError {
    constructor(msg = "Rate calculation underflow") { super(msg, 7); }
  };
  static RateErrorArithmeticOverflow = class RateErrorArithmeticOverflow extends ReputationContractError {
    constructor(msg = "Rate calculation overflow") { super(msg, 8); }
  };

  static fromError(error: unknown): Error {
    const match = String(error).match(/Error\(Contract, (\d+)\)/);
    if (!match) return error instanceof Error ? error : new Error(String(error));
    switch (parseInt(match[1] || "", 10)) {
      case 1: return new ReputationContractError.ArithmeticError();
      case 2: return new ReputationContractError.InvoiceNotFound();
      case 3: return new ReputationContractError.IllegalState();
      case 4: return new ReputationContractError.ConfigErrorUnauthorized();
      case 5: return new ReputationContractError.ConfigErrorInvalidBonusBps();
      case 6: return new ReputationContractError.ConfigErrorInvalidMinDiscountRate();
      case 7: return new ReputationContractError.RateErrorArithmeticUnderflow();
      case 8: return new ReputationContractError.RateErrorArithmeticOverflow();
      default: return new ReputationContractError(`reputation_bonus error: ${String(error)}`);
    }
  }
}

/**
 * Build, simulate, sign, and submit a write operation against the
 * reputation_bonus contract.
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
    throw ReputationContractError.fromError(sim.error);
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


// ---------------------------------------------------------------------------
// G-address validation
// ---------------------------------------------------------------------------

const G_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

function isValidGAddress(address: string): boolean {
  return G_ADDRESS_RE.test(address);
}

// ---------------------------------------------------------------------------
// getReputation
// ---------------------------------------------------------------------------

/**
 * Query the reputation profile for a Stellar address.
 *
 * Performs a read-only Soroban simulation — no on-chain mutation, no
 * transaction fees, and no signer required.
 *
 * @param server              - Soroban RPC server for the target network
 * @param contractId          - Deployed invoice-liquidity contract address
 * @param address             - Stellar G… address to look up
 * @param networkPassphrase   - Stellar network passphrase (default: TESTNET)
 * @returns ReputationProfile (zeroed for unknown / never-active addresses)
 *
 * @throws When `address` is not a valid Stellar G-address
 * @throws When the Soroban simulation fails (RPC unreachable, contract not found)
 *
 * @example
 * ```ts
 * const rep = await getReputation(server, CONTRACT_ID, "GAA...");
 * console.log(`Score: ${rep.score}, Submitted: ${rep.invoicesSubmitted}`);
 * ```
 */
export async function getReputation(
  server: SorobanRpc.Server,
  contractId: string,
  address: string,
  networkPassphrase: string = Networks.TESTNET
): Promise<ReputationProfile> {
  if (!isValidGAddress(address)) {
    throw new Error(
      `Invalid Stellar address: "${address}". Must be a G… public key.`
    );
  }

  const contract = new Contract(contractId);
  const op = contract.call(
    "get_reputation",
    new Address(address).toScVal()
  );

  const sourceAccount = new Account(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "0"
  );

  const simTx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await retry(() => server.simulateTransaction(simTx));

  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`get_reputation simulation failed: ${sim.error}`);
  }

  // The contract returns a zeroed ReputationProfile for unknown addresses
  if (!sim.result?.retval) {
    return decodeReputationScore({}, address);
  }

  const raw = scValToNative(sim.result.retval) as Record<string, unknown>;
  return decodeReputationScore(raw, address);
}

export type { ReputationProfile };

// ---------------------------------------------------------------------------
// reputation_bonus write operations (#477)
// ---------------------------------------------------------------------------

/** Mirrors `Invoice` in contracts/reputation_bonus/src/invoice.rs. */
export interface ReputationBonusInvoice {
  id: bigint;
  freelancer: string;
  payer: string;
  amount: bigint;
  dueDate: bigint;
  baseDiscountRateBps: number;
  effectiveDiscountRateBps: number;
  status: string;
}

/**
 * Register a new invoice with the reputation_bonus contract.
 *
 * Wraps `submit_invoice(freelancer, payer, amount, due_date, base_discount_rate_bps)`.
 * Requires the freelancer's signature — `sourceAccount` must be the
 * freelancer's account.
 *
 * @param server                    - Soroban RPC server for the target network
 * @param contractId                - Deployed reputation_bonus contract address
 * @param freelancerAddress         - Freelancer's Stellar G... address (must match sourceAccount)
 * @param payerAddress              - Payer's Stellar G... address
 * @param amount                    - Invoice amount
 * @param dueDate                   - Unix timestamp the invoice is due
 * @param baseDiscountRateBps       - Base discount rate in basis points
 * @param sourceAccount             - The freelancer's account (signs and pays the tx fee)
 * @param signTransaction           - Function to sign the assembled transaction
 * @param networkPassphrase         - Stellar network passphrase (default: TESTNET)
 * @returns The submitted transaction hash and the raw simulated return value
 * @throws {ReputationContractError} On config/rate errors surfaced by the contract
 */
export async function submitReputationInvoice(
  server: SorobanRpc.Server,
  contractId: string,
  freelancerAddress: string,
  payerAddress: string,
  amount: bigint,
  dueDate: bigint,
  baseDiscountRateBps: number,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string = Networks.TESTNET
): Promise<{ txHash: string }> {
  if (!isValidGAddress(freelancerAddress)) {
    throw new Error(`Invalid Stellar address: "${freelancerAddress}". Must be a G… public key.`);
  }
  if (!isValidGAddress(payerAddress)) {
    throw new Error(`Invalid Stellar address: "${payerAddress}". Must be a G… public key.`);
  }
  const { txHash } = await submitCall(
    server,
    contractId,
    "submit_invoice",
    [
      new Address(freelancerAddress).toScVal(),
      new Address(payerAddress).toScVal(),
      nativeToScVal(amount, { type: "i128" }),
      nativeToScVal(dueDate, { type: "u64" }),
      nativeToScVal(baseDiscountRateBps, { type: "u32" }),
    ],
    sourceAccount,
    signTransaction,
    networkPassphrase
  );
  return { txHash };
}

/**
 * Mark a reputation_bonus invoice as paid.
 *
 * Wraps `mark_paid(invoice_id)`. Requires the invoice's *payer* signature —
 * `sourceAccount` must be the payer address the invoice was submitted with,
 * not an arbitrary caller.
 *
 * @param server              - Soroban RPC server for the target network
 * @param contractId          - Deployed reputation_bonus contract address
 * @param invoiceId           - The invoice's ID
 * @param sourceAccount       - The invoice's payer account (signs and pays the tx fee)
 * @param signTransaction     - Function to sign the assembled transaction
 * @param networkPassphrase   - Stellar network passphrase (default: TESTNET)
 * @returns The submitted transaction hash
 * @throws {ReputationContractError.InvoiceNotFound} If the invoice id is unknown
 */
export async function markReputationInvoicePaid(
  server: SorobanRpc.Server,
  contractId: string,
  invoiceId: bigint,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string = Networks.TESTNET
): Promise<{ txHash: string }> {
  const { txHash } = await submitCall(
    server,
    contractId,
    "mark_paid",
    [nativeToScVal(invoiceId, { type: "u64" })],
    sourceAccount,
    signTransaction,
    networkPassphrase
  );
  return { txHash };
}

/**
 * Mark a reputation_bonus invoice as defaulted, decrementing both parties'
 * reputation.
 *
 * Wraps `handle_default(invoice_id)`. Note: unlike `mark_paid`, the contract
 * does not restrict this to any specific caller — any signed transaction can
 * invoke it. `sourceAccount` just needs to be a funded account to pay the
 * transaction fee.
 *
 * @param server              - Soroban RPC server for the target network
 * @param contractId          - Deployed reputation_bonus contract address
 * @param invoiceId           - The invoice's ID
 * @param sourceAccount       - Any funded account (signs and pays the tx fee)
 * @param signTransaction     - Function to sign the assembled transaction
 * @param networkPassphrase   - Stellar network passphrase (default: TESTNET)
 * @returns The submitted transaction hash
 * @throws {ReputationContractError.IllegalState} If the invoice isn't Pending or Funded
 */
export async function handleDefault(
  server: SorobanRpc.Server,
  contractId: string,
  invoiceId: bigint,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string = Networks.TESTNET
): Promise<{ txHash: string }> {
  const { txHash } = await submitCall(
    server,
    contractId,
    "handle_default",
    [nativeToScVal(invoiceId, { type: "u64" })],
    sourceAccount,
    signTransaction,
    networkPassphrase
  );
  return { txHash };
}
