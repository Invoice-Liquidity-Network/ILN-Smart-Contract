// @ts-nocheck
/**
 * transferInvoice — SDK helper for reassigning a pending invoice to a new
 * freelancer (issue #469).
 */
import { Contract, SorobanRpc, TransactionBuilder, BASE_FEE, nativeToScVal } from "@stellar/stellar-sdk";
import type { ILNClient } from "../client.js";
import { ILNError } from "../errors.js";
import { retry } from "../utils/retry.js";

export interface TransferInvoiceResult {
  txHash: string;
}

/**
 * Transfer an invoice's ownership to a new freelancer.
 *
 * Wraps `transfer_invoice(invoice_id, new_freelancer)`. Requires the
 * *current* freelancer's signature — `client.signer` must be the
 * invoice's existing submitter. Validates the invoice is currently
 * `Pending` client-side before submitting (the contract enforces this
 * too, and updates the submitter index on both sides of the transfer).
 *
 * @param client Configured {@link ILNClient} — `client.signer` must be the invoice's current freelancer
 * @param invoiceId Invoice to transfer (must currently be `Pending`)
 * @param newFreelancer The new freelancer's Stellar address
 * @throws {ILNError.InvoiceNotFound} If the invoice id is unknown
 * @throws {ILNError.AlreadyFunded} If the invoice has already been (partially) funded
 * @throws {ILNError.AlreadyPaid} If the invoice has already been paid
 */
export async function transferInvoice(
  client: ILNClient,
  invoiceId: bigint,
  newFreelancer: string
): Promise<TransferInvoiceResult> {
  if (!client.signer) {
    throw new Error("transferInvoice requires a client configured with a signer (the invoice's current freelancer)");
  }

  const { getInvoice } = await import("./queries.js");
  const account = await retry(() => client.rpc.getAccount(client.signer!.publicKey));

  const invoice = await getInvoice(client.rpc, client.contractId, invoiceId, account, client.networkPassphrase);
  if (invoice.status !== "Pending") {
    throw new Error(`Invoice ${invoiceId} is ${invoice.status}, not Pending — cannot be transferred`);
  }

  const contract = new Contract(client.contractId);
  const op = contract.call(
    "transfer_invoice",
    nativeToScVal(invoiceId, { type: "u64" }),
    nativeToScVal(newFreelancer, { type: "address" })
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
