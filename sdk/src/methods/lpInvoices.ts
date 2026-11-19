/**
 * getLpInvoices — fetch a page of invoices funded by a specific liquidity
 * provider from the on-chain invoice-liquidity contract.
 *
 * Wraps the `list_invoices_by_lp(lp, page, page_size)` view function.
 * Read-only simulation — no signer or transaction fees required, and no
 * caller-supplied source account needed.
 */

import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Account,
  BASE_FEE,
  scValToNative,
  nativeToScVal,
  Networks,
} from "@stellar/stellar-sdk";
import { retry } from "../utils/retry.js";
import { decodeInvoice } from "../utils/xdrDecoder.js";
import type { Invoice } from "@invoice-liquidity/types";

// ---------------------------------------------------------------------------
// G-address validation
// ---------------------------------------------------------------------------

const G_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

function isValidGAddress(address: string): boolean {
  return G_ADDRESS_RE.test(address);
}

// ---------------------------------------------------------------------------
// getLpInvoices
// ---------------------------------------------------------------------------

/**
 * Query a page of invoices funded by a liquidity provider.
 *
 * Performs a read-only Soroban simulation — no on-chain mutation, no
 * transaction fees, and no signer required. The contract clamps
 * `pageSize` to 50 regardless of the value requested.
 *
 * @param server              - Soroban RPC server for the target network
 * @param contractId          - Deployed invoice-liquidity contract address
 * @param lp                  - Stellar G… address of the liquidity provider
 * @param page                - Zero-indexed page number (default 0)
 * @param pageSize            - Number of invoices per page (default 10, capped at 50 by the contract)
 * @param networkPassphrase   - Stellar network passphrase (default: TESTNET)
 * @returns Array of invoices for the requested page (empty past the last page)
 *
 * @throws When `lp` is not a valid Stellar G-address
 * @throws When the Soroban simulation fails (RPC unreachable, contract not found)
 *
 * @example
 * ```ts
 * const invoices = await getLpInvoices(server, CONTRACT_ID, "GAA...", 0, 10);
 * console.log(`Page has ${invoices.length} invoices`);
 * ```
 */
export async function getLpInvoices(
  server: SorobanRpc.Server,
  contractId: string,
  lp: string,
  page: number = 0,
  pageSize: number = 10,
  networkPassphrase: string = Networks.TESTNET
): Promise<Invoice[]> {
  if (!isValidGAddress(lp)) {
    throw new Error(`Invalid Stellar address: "${lp}". Must be a G… public key.`);
  }

  const contract = new Contract(contractId);
  const op = contract.call(
    "list_invoices_by_lp",
    nativeToScVal(lp, { type: "address" }),
    nativeToScVal(page, { type: "u32" }),
    nativeToScVal(pageSize, { type: "u32" })
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
    throw new Error(`list_invoices_by_lp simulation failed: ${sim.error}`);
  }

  if (!sim.result?.retval) {
    return [];
  }

  const rawArr = scValToNative(sim.result.retval) as Record<string, unknown>[];
  return rawArr.map((raw) => decodeInvoice(raw));
}
