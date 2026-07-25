// @ts-nocheck
/**
 * appealInvoice / resolveAppeal — SDK helpers for the default-appeal flow
 * (issues #462, #463).
 *
 * Flow: payer appeals a Defaulted invoice (appealInvoice) → governance
 * rules on it (resolveAppeal), either restoring the payer's pre-default
 * reputation score (upheld) or leaving the default in place (rejected).
 */
import { Contract, SorobanRpc, TransactionBuilder, BASE_FEE, nativeToScVal } from "@stellar/stellar-sdk";
import type { ILNClient } from "../client.js";
import { ILNError } from "../errors.js";
import { retry } from "../utils/retry.js";

export interface AppealInvoiceResult {
  txHash: string;
}

export interface ResolveAppealResult {
  txHash: string;
}

/**
 * File an appeal against a defaulted invoice.
 *
 * Wraps `appeal_default(invoice_id, evidence_hash)`. Requires the invoice's
 * payer to sign — `client.signer` must be that payer. Validates the
 * invoice is currently `Defaulted` client-side before submitting (the
 * contract enforces this too, but a client-side check gives a clearer
 * error before spending a transaction).
 *
 * @param client Configured {@link ILNClient} — `client.signer` must be the invoice's payer
 * @param invoiceId Invoice ID to appeal (must currently be `Defaulted`)
 * @param evidenceHash Hex-encoded 32-byte hash of the off-chain evidence
 * @throws {ILNError.InvoiceNotFound} If the invoice id is unknown
 * @throws {ILNError.NotDefaulted} If the invoice is not currently Defaulted
 * @throws {ILNError.AlreadyAppealed} If an appeal has already been filed
 * @throws {ILNError.AppealWindowClosed} If more than 30 days have passed since default
 */
export async function appealInvoice(
  client: ILNClient,
  invoiceId: bigint,
  evidenceHash: string
): Promise<AppealInvoiceResult> {
  if (!client.signer) {
    throw new Error("appealInvoice requires a client configured with a signer (the invoice's payer)");
  }

  const { getInvoice } = await import("./queries.js");
  const account = await retry(() => client.rpc.getAccount(client.signer!.publicKey));

  const invoice = await getInvoice(client.rpc, client.contractId, invoiceId, account, client.networkPassphrase);
  if (invoice.status !== "Defaulted") {
    throw new ILNError.NotDefaulted(`Invoice ${invoiceId} is ${invoice.status}, not Defaulted`);
  }

  const contract = new Contract(client.contractId);
  const op = contract.call(
    "appeal_default",
    nativeToScVal(invoiceId, { type: "u64" }),
    nativeToScVal(Buffer.from(evidenceHash, "hex"), { type: "bytes" })
  );

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: client.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await retry(() => client.rpc.simulateTransaction(tx));
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw ILNError.fromError(sim.error);
  }

  const assembledTx = SorobanRpc.assembleTransaction(tx, sim).build();
  const signed = await client.signer.signTransaction(assembledTx, client.rpc);
  const sendResult = await retry(() => client.rpc.sendTransaction(signed));
  if (sendResult.errorResult) {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }

  return { txHash: sendResult.hash };
}

/**
 * Resolve a pending appeal with a governance ruling.
 *
 * Wraps `resolve_appeal(invoice_id, upheld)`.
 *
 * `upheld = true` restores the payer's pre-default reputation score and
 * decrements their defaulted-invoice count (the default itself remains on
 * record — only the reputational penalty is reversed). `upheld = false`
 * rejects the appeal and leaves the default penalty in place.
 *
 * **Security note:** despite the contract's doc comment ("Access: Admin
 * only"), `resolve_appeal` in the current deployed contract
 * (contracts/invoice_liquidity/src/lib.rs) does not actually call
 * `require_admin` or any other auth check — any account can currently call
 * this and manipulate reputation scores. This is a contract-level bug
 * outside the scope of this SDK-wrapper issue; flagging it here rather
 * than silently working around it. The SDK does not add a client-side
 * restriction since that would not be enforceable anyway.
 *
 * @param client Configured {@link ILNClient} — any signer, since the contract does not currently check identity (see security note above)
 * @param invoiceId Invoice ID to resolve (must currently be `Appealed`)
 * @param upheld `true` to reverse the default (restore reputation), `false` to reject the appeal
 * @throws {ILNError.InvoiceNotFound} If the invoice id is unknown
 * @throws {ILNError.NotDefaulted} If the invoice is not currently Appealed
 */
export async function resolveAppeal(
  client: ILNClient,
  invoiceId: bigint,
  upheld: boolean
): Promise<ResolveAppealResult> {
  if (!client.signer) {
    throw new Error("resolveAppeal requires a client configured with a signer");
  }

  const contract = new Contract(client.contractId);
  const op = contract.call(
    "resolve_appeal",
    nativeToScVal(invoiceId, { type: "u64" }),
    nativeToScVal(upheld, { type: "bool" })
  );

  const account = await retry(() => client.rpc.getAccount(client.signer!.publicKey));
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: client.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await retry(() => client.rpc.simulateTransaction(tx));
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw ILNError.fromError(sim.error);
  }

  const assembledTx = SorobanRpc.assembleTransaction(tx, sim).build();
  const signed = await client.signer.signTransaction(assembledTx, client.rpc);
  const sendResult = await retry(() => client.rpc.sendTransaction(signed));
  if (sendResult.errorResult) {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }

  return { txHash: sendResult.hash };
}
