import {
  Account,
  BASE_FEE,
  Contract,
  nativeToScVal,
  Networks,
  scValToNative,
  SorobanRpc,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { retry } from "../utils/retry.js";

export interface InvoiceNftMetadata {
  amount: bigint;
  dueDate: bigint;
  discountRate: number;
  token: string;
  owner: string;
  mintedAt: bigint;
}

async function simulateNftQuery(
  server: SorobanRpc.Server,
  contractId: string,
  method: "query_nft_metadata" | "query_nft_owner",
  invoiceId: bigint,
  networkPassphrase: string,
): Promise<unknown | null> {
  const operation = new Contract(contractId).call(
    method,
    nativeToScVal(invoiceId, { type: "u64" }),
  );
  const source = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0");
  const transaction = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();
  const simulation = await retry(() => server.simulateTransaction(transaction));
  if (SorobanRpc.Api.isSimulationError(simulation)) {
    throw new Error(`${method} simulation failed: ${simulation.error}`);
  }
  return simulation.result?.retval ? scValToNative(simulation.result.retval) : null;
}

export async function queryNftMetadata(
  server: SorobanRpc.Server,
  contractId: string,
  invoiceId: bigint,
  networkPassphrase: string = Networks.TESTNET,
): Promise<InvoiceNftMetadata | null> {
  const raw = (await simulateNftQuery(
    server,
    contractId,
    "query_nft_metadata",
    invoiceId,
    networkPassphrase,
  )) as Record<string, unknown> | null;
  if (!raw) return null;
  return {
    amount: BigInt(String(raw.amount)),
    dueDate: BigInt(String(raw.due_date ?? raw.dueDate)),
    discountRate: Number(raw.discount_rate ?? raw.discountRate),
    token: String(raw.token),
    owner: String(raw.owner),
    mintedAt: BigInt(String(raw.minted_at ?? raw.mintedAt)),
  };
}

export async function queryNftOwner(
  server: SorobanRpc.Server,
  contractId: string,
  invoiceId: bigint,
  networkPassphrase: string = Networks.TESTNET,
): Promise<string | null> {
  const owner = await simulateNftQuery(
    server,
    contractId,
    "query_nft_owner",
    invoiceId,
    networkPassphrase,
  );
  return owner === null ? null : String(owner);
}
