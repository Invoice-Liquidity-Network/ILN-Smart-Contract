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

  export interface InsurancePoolInfo {
    poolBalance: bigint;
    coverage: bigint;
    isEnrolled: boolean;
    premiumsPaid: bigint;
  }

  export class ILNClient {
    rpc: unknown;
    networkPassphrase: string;
    contractId: string;

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
    getInsurancePoolInfo(
      insurancePoolContractId: string,
      lpAddress: string
    ): Promise<InsurancePoolInfo>;
    getDistributionAccrual(
      distributionContractId: string,
      participantAddress: string
    ): Promise<number>;
  }

  export function getReferralStats(
    server: unknown,
    contractId: string,
    referralCodeHex: string,
    networkPassphrase: string
  ): Promise<number>;
}
