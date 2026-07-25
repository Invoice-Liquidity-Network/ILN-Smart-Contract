declare module "@iln/sdk" {
  export interface ReputationProfile {
    address: string;
    score: number;
    invoicesSubmitted: number;
    invoicesPaid: number;
    invoicesDefaulted: number;
  }

  export interface TopPayer {
    address: string;
    score: number;
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
    getTopPayers(limit: number): Promise<TopPayer[]>;
  }
}
