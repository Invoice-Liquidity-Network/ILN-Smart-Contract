import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  scValToNative,
  nativeToScVal,
  Account,
} from "@stellar/stellar-sdk";
import type { Invoice, InvoiceState } from "@invoice-liquidity/types";
import { ILNError } from "../errors.js";
import { decodeInvoice } from "../utils/xdrDecoder.js";
import { retry } from "../utils/retry.js";

/**
 * Fetch a single invoice by its ID.
 * @param server Soroban RPC server instance
 * @param contractAddress The contract's address
 * @param invoiceId The invoice ID
 * @param sourceAccount Account used for simulation (does not consume sequence or fees)
 * @param networkPassphrase The network passphrase
 * @returns The invoice data including computed yield
 * @throws {ILNError.InvoiceNotFound} If the invoice does not exist
 * @throws {ILNError} On other simulation errors
 * @example
 * ```ts
 * const invoice = await getInvoice(server, contractAddress, 42n, sourceAccount, Networks.TESTNET);
 * console.log(`Invoice status: ${invoice.status}`);
 * ```
 */
export async function getInvoice(
  server: SorobanRpc.Server,
  contractAddress: string,
  invoiceId: bigint,
  sourceAccount: Account,
  networkPassphrase: string
): Promise<Invoice> {
  const contract = new Contract(contractAddress);
  const op = contract.call(
    "get_invoice",
    nativeToScVal(invoiceId, { type: "u64" })
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
    if (String(sim.error).includes("NotFound") || String(sim.error).includes("Error(Contract, 1)")) {
      throw new ILNError.InvoiceNotFound(`Invoice ${invoiceId} not found`);
    }
    throw ILNError.fromError(sim.error);
  }
  if (!sim.result?.retval) {
    throw new ILNError.InvoiceNotFound(`Invoice ${invoiceId} not found`);
  }

  const raw = scValToNative(sim.result.retval) as Record<string, unknown>;
  return decodeInvoice(raw);

}

/**
 * List invoices submitted by a specific freelancer address.
 * @param server Soroban RPC server instance
 * @param contractAddress The contract's address
 * @param submitter The freelancer's address
 * @param sourceAccount Account used for simulation
 * @param networkPassphrase The network passphrase
 * @param page The page number (0-indexed)
 * @param pageSize The number of items per page
 * @returns Array of invoices
 * @throws {ILNError} On simulation errors
 * @example
 * ```ts
 * const invoices = await listInvoicesBySubmitter(server, contractAddress, "G...", sourceAccount, Networks.TESTNET, 0, 10);
 * ```
 */
export async function listInvoicesBySubmitter(
  server: SorobanRpc.Server,
  contractAddress: string,
  submitter: string,
  sourceAccount: Account,
  networkPassphrase: string,
  page: number = 0,
  pageSize: number = 50
): Promise<Invoice[]> {
  const contract = new Contract(contractAddress);
  const op = contract.call(
    "list_invoices_by_submitter",
    nativeToScVal(submitter, { type: "address" }),
    nativeToScVal(page, { type: "u32" }),
    nativeToScVal(pageSize, { type: "u32" })
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
    throw ILNError.fromError(sim.error);
  }
  if (!sim.result?.retval) {
    return [];
  }

  const rawArr = scValToNative(sim.result.retval) as Record<string, unknown>[];
  return rawArr.map(raw => decodeInvoice(raw as Record<string, unknown>));

}

/**
 * List invoices funded by a specific LP address.
 * @param server Soroban RPC server instance
 * @param contractAddress The contract's address
 * @param lp The liquidity provider's address
 * @param sourceAccount Account used for simulation
 * @param networkPassphrase The network passphrase
 * @param page The page number (0-indexed)
 * @param pageSize The number of items per page
 * @returns Array of invoices
 * @throws {ILNError} On simulation errors
 * @example
 * ```ts
 * const invoices = await listInvoicesByLP(server, contractAddress, "G...", sourceAccount, Networks.TESTNET, 0, 10);
 * ```
 */
export async function listInvoicesByLP(
  server: SorobanRpc.Server,
  contractAddress: string,
  lp: string,
  sourceAccount: Account,
  networkPassphrase: string,
  page: number = 0,
  pageSize: number = 50
): Promise<Invoice[]> {
  const contract = new Contract(contractAddress);
  const op = contract.call(
    "list_invoices_by_lp",
    nativeToScVal(lp, { type: "address" }),
    nativeToScVal(page, { type: "u32" }),
    nativeToScVal(pageSize, { type: "u32" })
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
    throw ILNError.fromError(sim.error);
  }
  if (!sim.result?.retval) {
    return [];
  }

  const rawArr = scValToNative(sim.result.retval) as Record<string, unknown>[];
  return rawArr.map(raw => decodeInvoice(raw as Record<string, unknown>));
}
