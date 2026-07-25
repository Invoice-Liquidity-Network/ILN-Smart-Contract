// @ts-nocheck
/**
 * convertInvoiceToken — SDK helper for changing a pending invoice's
 * settlement token (issue #468).
 */
import { Contract, SorobanRpc, TransactionBuilder, BASE_FEE, nativeToScVal } from "@stellar/stellar-sdk";
import type { ILNClient } from "../client.js";
import { ILNError } from "../errors.js";
import { retry } from "../utils/retry.js";

export interface ConvertInvoiceTokenResult {
  txHash: string;
}

/**
 * Change the settlement token for a pending invoice.
 *
 * Wraps `convert_invoice_token(freelancer, invoice_id, new_token)`.
 * Requires the freelancer's signature — `client.signer` must be
 * `freelancerAddress`. Validates the invoice is currently `Pending`
 * client-side before submitting.
 *
 * Token-approval is enforced by the contract (there is no public query
 * to check the allowlist client-side), so an unapproved `newToken`
 * surfaces as `ILNError.Unauthorized` from the simulation rather than a
 * pre-flight check here.
 *
 * @param client Configured {@link ILNClient} — `client.signer` must be `freelancerAddress`
 * @param freelancerAddress The invoice's freelancer (must match `client.signer`)
 * @param invoiceId Invoice to update (must currently be `Pending`)
 * @param newToken The new settlement token's contract address (must be an approved token)
 * @throws {ILNError.InvoiceNotFound} If the invoice id is unknown
 * @throws {ILNError.AlreadyFunded} If the invoice has already been (partially) funded
 * @throws {ILNError.AlreadyPaid} If the invoice has already been paid
 * @throws {ILNError.InvoiceExpired} If the invoice's due date has passed
 * @throws {ILNError.Unauthorized} If `newToken` is not an approved token, or the caller isn't the freelancer
 */
export async function convertInvoiceToken(
  client: ILNClient,
  freelancerAddress: string,
  invoiceId: bigint,
  newToken: string
): Promise<ConvertInvoiceTokenResult> {
  if (!client.signer) {
    throw new Error("convertInvoiceToken requires a client configured with a signer (the invoice's freelancer)");
  }

  const { getInvoice } = await import("./queries.js");
  const account = await retry(() => client.rpc.getAccount(client.signer!.publicKey));

  const invoice = await getInvoice(client.rpc, client.contractId, invoiceId, account, client.networkPassphrase);
  if (invoice.status !== "Pending") {
    throw new Error(`Invoice ${invoiceId} is ${invoice.status}, not Pending — token cannot be changed`);
  }

  const contract = new Contract(client.contractId);
  const op = contract.call(
    "convert_invoice_token",
    nativeToScVal(freelancerAddress, { type: "address" }),
    nativeToScVal(invoiceId, { type: "u64" }),
    nativeToScVal(newToken, { type: "address" })
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
