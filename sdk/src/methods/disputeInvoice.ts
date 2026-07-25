// @ts-nocheck
/**
 * disputeInvoice — SDK helper for disputing an invoice (issue #225, error
 * handling and pre-flight validation added for issue #464).
 *
 * Hashes the caller-supplied evidence string with SHA-256 (via the
 * Stellar SDK's built-in Buffer / crypto utilities) and forwards the
 * resulting 32-byte hash to the `dispute_invoice` contract function.
 */
import { Contract, SorobanRpc, xdr } from "@stellar/stellar-sdk";
import type { ISigner as Signer } from "../signers/ISigner.js";
import { ILNError } from "../errors.js";
import { retry } from "../utils/retry.js";

export interface DisputeInvoiceParams {
  /** Soroban RPC server instance. */
  rpc: SorobanRpc.Server;
  /** Deployed ILN contract address. */
  contractAddress: string;
  /** Signer (keypair or wallet) for the transaction. */
  signer: Signer;
  /** Invoice ID to dispute. */
  invoiceId: bigint;
  /**
   * Human-readable evidence string.  The SDK hashes this automatically
   * with SHA-256 so callers never have to produce the raw hash themselves.
   */
  evidence: string;
  /** Optional: transaction fee in stroops (default 100). */
  fee?: number;
}

export interface DisputeInvoiceResult {
  /** Transaction hash of the dispute submission. */
  txHash: string;
  /** SHA-256 hex digest of the evidence that was submitted on-chain. */
  evidenceHash: string;
}

/**
 * Hash `text` with SHA-256 and return the lower-case hex digest.
 * Works in both Node.js (crypto module) and browser (SubtleCrypto).
 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);

  // Node.js path
  if (typeof process !== "undefined" && process.versions?.node) {
    const { createHash } = await import("crypto");
    return createHash("sha256").update(bytes).digest("hex");
  }

  // Browser / Deno path
  const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Invoice statuses `dispute_invoice` accepts (mirrors the contract's own match arm). */
const DISPUTABLE_STATUSES = new Set(["Pending", "PartiallyFunded", "Funded"]);

/**
 * Dispute an invoice by submitting a SHA-256 hash of the caller's evidence
 * to the `dispute_invoice` contract entry point.
 *
 * Validates the invoice is currently in a disputable status (`Pending`,
 * `PartiallyFunded`, or `Funded`) before submitting, and maps all
 * simulation errors through {@link ILNError.fromError} so callers get
 * typed errors (e.g. `ILNError.AlreadyDisputed`) instead of raw RPC
 * exceptions. All RPC calls retry transient network failures with
 * exponential back-off via {@link retry}.
 *
 * @throws {ILNError.InvoiceNotFound} If the invoice id is unknown
 * @throws {ILNError.AlreadyPaid} If the invoice has already been paid
 * @throws {ILNError.AlreadyDisputed} If a dispute has already been filed
 * @throws {ILNError.InvoiceDefaulted} If the invoice has already defaulted
 * @throws {ILNError.InvoiceAppealed} If the invoice is under appeal
 * @throws {ILNError.InvoiceExpired} If the invoice has expired
 * @throws {ILNError.AlreadyCancelled} If the invoice was cancelled
 * @throws {ILNError.ContractPaused} If the contract is currently paused
 *
 * @example
 * ```ts
 * const result = await disputeInvoice({
 *   rpc,
 *   contractAddress: CONTRACT_ID,
 *   signer: keypairSigner(myKeypair),
 *   invoiceId: 42n,
 *   evidence: "Payment already settled via bank transfer ref #TX9921",
 * });
 * console.log("Dispute tx:", result.txHash);
 * console.log("Evidence hash:", result.evidenceHash);
 * ```
 */
export async function disputeInvoice(
  params: DisputeInvoiceParams
): Promise<DisputeInvoiceResult> {
  const { rpc, contractAddress, signer, invoiceId, evidence, fee = 100 } =
    params;

  const evidenceHash = await sha256Hex(evidence);
  const hashBytes = Buffer.from(evidenceHash, "hex");

  const account = await retry(() => rpc.getAccount(signer.publicKey));
  const { TransactionBuilder } = await import("@stellar/stellar-sdk");
  const networkPassphrase = (await retry(() => rpc.getNetwork())).passphrase;

  const { getInvoice } = await import("./queries.js");
  const invoice = await getInvoice(rpc, contractAddress, invoiceId, account, networkPassphrase);
  if (!DISPUTABLE_STATUSES.has(invoice.status)) {
    throw new ILNError(`Invoice ${invoiceId} is ${invoice.status} and cannot be disputed`);
  }

  const contract = new Contract(contractAddress);
  const operation = contract.call(
    "dispute_invoice",
    xdr.ScVal.scvU64(xdr.Uint64.fromString(invoiceId.toString())),
    xdr.ScVal.scvBytes(hashBytes)
  );

  const tx = new TransactionBuilder(account, {
    fee: String(fee),
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  const sim = await retry(() => rpc.simulateTransaction(tx));
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw ILNError.fromError(sim.error);
  }

  const assembledTx = SorobanRpc.assembleTransaction(tx, sim).build();
  const signed = await signer.signTransaction(assembledTx as any, rpc);
  const response = await retry(() => rpc.sendTransaction(signed));
  if (response.errorResult) {
    throw new Error(`Transaction failed: ${response.errorResult}`);
  }

  return { txHash: response.hash, evidenceHash };
}
