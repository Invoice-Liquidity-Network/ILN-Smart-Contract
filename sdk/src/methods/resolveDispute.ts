// @ts-nocheck
/**
 * resolveDispute — SDK helper for admin-ruling on a disputed invoice (issue #465).
 *
 * Wraps the admin-only `resolve_dispute(invoice_id, resolution_hash, resolution)`
 * contract entry point. The contract enforces that the caller is the
 * configured admin via `require_admin` — `client.signer` must be that admin's
 * signer.
 */
import { Contract, xdr } from "@stellar/stellar-sdk";
import type { ILNClient } from "../client.js";
import { retry } from "../utils/retry.js";

/** Governance ruling on a disputed invoice, matching the contract's `resolution` u32. */
export enum DisputeRuling {
  /** Payer is right: invoice is cancelled and any funders are refunded. */
  Upheld = 1,
  /** Freelancer is right: invoice reverts to its pre-dispute status. */
  Rejected = 2,
}

export interface ResolveDisputeResult {
  /** Transaction hash of the resolution submission. */
  txHash: string;
}

/**
 * Resolve a disputed invoice with an admin ruling.
 *
 * @param client Configured {@link ILNClient} — `client.signer` must be the contract's admin
 * @param invoiceId Invoice ID to resolve (must currently be in `Disputed` status)
 * @param resolutionHash Hex-encoded 32-byte hash of the off-chain ruling rationale
 * @param ruling {@link DisputeRuling.Upheld} (payer right) or {@link DisputeRuling.Rejected} (freelancer right)
 *
 * @example
 * ```ts
 * const client = ILNClient.testnet(adminSigner);
 * await resolveDispute(client, 42n, evidenceHash, DisputeRuling.Upheld);
 * ```
 */
export async function resolveDispute(
  client: ILNClient,
  invoiceId: bigint,
  resolutionHash: string,
  ruling: DisputeRuling
): Promise<ResolveDisputeResult> {
  if (!client.signer) {
    throw new Error(
      "resolveDispute requires a client configured with a signer (the contract admin)"
    );
  }

  const contract = new Contract(client.contractId);
  const operation = contract.call(
    "resolve_dispute",
    xdr.ScVal.scvU64(xdr.Uint64.fromString(invoiceId.toString())),
    xdr.ScVal.scvBytes(Buffer.from(resolutionHash, "hex")),
    xdr.ScVal.scvU32(ruling)
  );

  const account = await retry(() => client.rpc.getAccount(client.signer!.publicKey));
  const { TransactionBuilder } = await import("@stellar/stellar-sdk");
  const built = await retry(() =>
    client.rpc.prepareTransaction(
      new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: client.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build()
    )
  );

  const signed = await client.signer.signTransaction(built as any, client.rpc);
  const response = await retry(() => client.rpc.sendTransaction(signed));

  return { txHash: response.hash };
}
