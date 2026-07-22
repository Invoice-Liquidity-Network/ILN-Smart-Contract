declare module "@iln/sdk" {
  export interface ReputationProfile {
    address: string;
    score: number;
    invoicesSubmitted: number;
    invoicesPaid: number;
    invoicesDefaulted: number;
  }

  export interface InvoiceNftMetadata {
    amount: bigint;
    dueDate: bigint;
    discountRate: number;
    token: string;
    owner: string;
    mintedAt: bigint;
  }

  export class ILNClient {
    static testnet(
      signer?: unknown,
      options?: { rpcUrl?: string; contractId?: string }
    ): ILNClient;
    static mainnet(
      signer?: unknown,
      options?: { rpcUrl?: string; contractId?: string }
    ): ILNClient;
    static custom(config: {
      rpcUrl: string;
      networkPassphrase: string;
      contractId: string;
      signer?: unknown;
    }): ILNClient;
    getReputation(address: string): Promise<ReputationProfile>;
    queryNftMetadata(invoiceId: bigint): Promise<InvoiceNftMetadata | null>;
    queryNftOwner(invoiceId: bigint): Promise<string | null>;
  }
}
