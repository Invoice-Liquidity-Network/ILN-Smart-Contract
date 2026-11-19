// @ts-nocheck
/**
 * submitInvoicesBatch — SDK helper for submitting up to 10 invoices in a
 * single transaction (issue #467).
 *
 * Note on multi-freelancer batches: the contract's `submit_invoices_batch`
 * requires `require_auth()` from every distinct freelancer address in the
 * batch. This SDK method signs with a single `client.signer`, so it only
 * supports batches where every item's `freelancer` matches that signer
 * (the common "high-volume freelancer submits their own batch" case
 * called out in the issue). A batch spanning multiple freelancers would
 * need multiple signers attached to the same transaction, which is
 * out of scope here.
 */
import { Contract, SorobanRpc, TransactionBuilder, BASE_FEE, nativeToScVal, xdr, scValToNative } from "@stellar/stellar-sdk";
import type { ILNClient } from "../client.js";
import { ILNError } from "../errors.js";
import { retry } from "../utils/retry.js";
import type { SupportedToken } from "@invoice-liquidity/types";

const MAX_BATCH_SIZE = 10;

export interface BatchInvoiceItem {
  freelancer: string;
  payer: string;
  amount: bigint;
  token: SupportedToken;
  discountRate: number;
  dueDate: Date | number;
  referralCode?: string;
}

export interface SubmitInvoicesBatchResult {
  invoiceIds: bigint[];
  txHash: string;
}

/** Encode a single batch item as the contract's `InvoiceParams` struct (ScVal map, keys sorted alphabetically). */
function encodeInvoiceParams(item: BatchInvoiceItem): xdr.ScVal {
  const dueDateUnix =
    item.dueDate instanceof Date ? Math.floor(item.dueDate.getTime() / 1000) : item.dueDate;

  const refArg = item.referralCode
    ? xdr.ScVal.scvVec([
        xdr.ScVal.scvU32(1),
        nativeToScVal(Buffer.from(item.referralCode, "hex"), { type: "bytes" }),
      ])
    : xdr.ScVal.scvVec([xdr.ScVal.scvU32(0), xdr.ScVal.scvVoid()]);

  // Field order must be alphabetical to match soroban_sdk's #[contracttype] map encoding.
  const entries: Array<[string, xdr.ScVal]> = [
    ["amount", nativeToScVal(item.amount, { type: "i128" })],
    ["discount_rate", nativeToScVal(item.discountRate, { type: "u32" })],
    ["due_date", nativeToScVal(dueDateUnix, { type: "u64" })],
    ["freelancer", nativeToScVal(item.freelancer, { type: "address" })],
    ["payer", nativeToScVal(item.payer, { type: "address" })],
    ["referral_code", refArg],
    ["token", nativeToScVal(item.token, { type: "address" })],
  ];

  return xdr.ScVal.scvMap(
    entries.map(
      ([key, val]) =>
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol(key),
          val,
        })
    )
  );
}

/**
 * Submit a batch of up to 10 invoices in a single transaction.
 *
 * Wraps `submit_invoices_batch(invoices)`.
 *
 * @param client Configured {@link ILNClient} — `client.signer` must be the freelancer for every item (see file header note)
 * @param invoices Batch of invoice params, 1-10 items
 * @returns The new invoice IDs, in submission order, and the transaction hash
 * @throws {ILNError.BatchTooLarge} If more than 10 invoices are provided
 */
export async function submitInvoicesBatch(
  client: ILNClient,
  invoices: BatchInvoiceItem[]
): Promise<SubmitInvoicesBatchResult> {
  if (!client.signer) {
    throw new Error("submitInvoicesBatch requires a client configured with a signer");
  }
  if (invoices.length === 0) {
    throw new Error("submitInvoicesBatch requires at least one invoice");
  }
  if (invoices.length > MAX_BATCH_SIZE) {
    throw new ILNError.BatchTooLarge(`Batch of ${invoices.length} exceeds the maximum of ${MAX_BATCH_SIZE}`);
  }

  const contract = new Contract(client.contractId);
  const op = contract.call(
    "submit_invoices_batch",
    xdr.ScVal.scvVec(invoices.map(encodeInvoiceParams))
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

  let status = await retry(() => client.rpc.getTransaction(sendResult.hash));
  let retries = 0;
  while (status.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND && retries < 15) {
    await new Promise((r) => setTimeout(r, 2000));
    status = await retry(() => client.rpc.getTransaction(sendResult.hash));
    retries++;
  }
  if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw new Error("Transaction failed during execution");
  }

  let invoiceIds: bigint[] = [];
  if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS && status.returnValue) {
    const raw = scValToNative(status.returnValue) as Array<string | bigint>;
    invoiceIds = raw.map((id) => BigInt(String(id)));
  }

  return { invoiceIds, txHash: sendResult.hash };
}
