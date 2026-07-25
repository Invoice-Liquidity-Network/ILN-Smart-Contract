import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  scValToNative,
  nativeToScVal,
  Account,
} from "@stellar/stellar-sdk";
import { ILNError } from "../errors.js";
import { decodeNftMetadata, type InvoiceNftMetadata } from "../utils/xdrDecoder.js";
import { retry } from "../utils/retry.js";

/**
 * Fetch NFT metadata for an invoice.
 * @param server Soroban RPC server instance
 * @param contractAddress The contract's address
 * @param invoiceId The invoice ID
 * @param sourceAccount Account used for simulation (does not consume sequence or fees)
 * @param networkPassphrase The network passphrase
 * @returns The NFT metadata if it exists, null otherwise
 * @throws {ILNError} On simulation errors
 * @example
 * ```ts
 * const metadata = await getNftMetadata(server, contractAddress, 42n, sourceAccount, Networks.TESTNET);
 * if (metadata) {
 *   console.log(`NFT owner: ${metadata.owner}`);
 * }
 * ```
 */
export async function getNftMetadata(
  server: SorobanRpc.Server,
  contractAddress: string,
  invoiceId: bigint,
  sourceAccount: Account,
  networkPassphrase: string
): Promise<InvoiceNftMetadata | null> {
  const contract = new Contract(contractAddress);
  const op = contract.call(
    "query_nft_metadata",
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
    throw ILNError.fromError(sim.error);
  }

  if (!sim.result?.retval) {
    return null;
  }

  const raw = scValToNative(sim.result.retval);

  // Handle Option type: if raw is null/none, return null
  if (raw === null || raw === undefined) {
    return null;
  }

  return decodeNftMetadata(raw as Record<string, unknown>);
}

/**
 * Fetch the owner address of an invoice NFT.
 * @param server Soroban RPC server instance
 * @param contractAddress The contract's address
 * @param invoiceId The invoice ID
 * @param sourceAccount Account used for simulation (does not consume sequence or fees)
 * @param networkPassphrase The network passphrase
 * @returns The owner address if the NFT exists, null otherwise
 * @throws {ILNError} On simulation errors
 * @example
 * ```ts
 * const owner = await getNftOwner(server, contractAddress, 42n, sourceAccount, Networks.TESTNET);
 * if (owner) {
 *   console.log(`Invoice NFT owner: ${owner}`);
 * }
 * ```
 */
export async function getNftOwner(
  server: SorobanRpc.Server,
  contractAddress: string,
  invoiceId: bigint,
  sourceAccount: Account,
  networkPassphrase: string
): Promise<string | null> {
  const contract = new Contract(contractAddress);
  const op = contract.call(
    "query_nft_owner",
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
    throw ILNError.fromError(sim.error);
  }

  if (!sim.result?.retval) {
    return null;
  }

  const raw = scValToNative(sim.result.retval);

  // Handle Option type: if raw is null/none, return null
  if (raw === null || raw === undefined) {
    return null;
  }

  return String(raw);
}
