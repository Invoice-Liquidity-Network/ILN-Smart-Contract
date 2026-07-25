// ---------------------------------------------------------------------------
// Invoice Types
// ---------------------------------------------------------------------------

export type InvoiceState =
  | 'Pending'
  | 'Funded'
  | 'PartiallyFunded'
  | 'Paid'
  | 'Defaulted'
  | 'Appealed'
  | 'Disputed'
  | 'Expired'
  | 'Cancelled';

export interface Invoice {
  id: bigint;
  freelancer: string;
  payer: string;
  token: string;
  amount: bigint;
  dueDate: number;
  discountRate: number;
  status: InvoiceState;
  funder?: string;
  fundedAt?: number;
  amountFunded: bigint;
  amountPaid: bigint;
  referralCode?: string;
  submitterReputation: number;
  effectiveYieldBps: number;
}

// ---------------------------------------------------------------------------
// Reputation Types
// ---------------------------------------------------------------------------

export interface ReputationScore {
  /** Stellar G… address that was queried. */
  address: string;
  /** Current reputation score (0–100). */
  score: number;
  /** Total invoices submitted by this address. */
  invoicesSubmitted: number;
  /** Total invoices paid by this address (as payer). */
  invoicesPaid: number;
  /** Total invoices defaulted by this address. */
  invoicesDefaulted: number;
}

// ---------------------------------------------------------------------------
// Governance Types
// ---------------------------------------------------------------------------

export enum ProposalAction {
  /** Update the protocol fee, in basis points. */
  UpdateProtocolFee = 0,
  /** Update the minimum payer reputation required to submit an invoice. */
  UpdateMinReputation = 1,
  /** Update the oracle contract address (value is an address index/handle). */
  UpdateOracle = 2,
  /** Pause the contract (proposedValue ignored). */
  PauseContract = 3,
  /** Unpause the contract (proposedValue ignored). */
  UnpauseContract = 4,
  /** Update the default grace period, in seconds. */
  UpdateGracePeriod = 5,
}

export enum ProposalStatus {
  Active = "Active",
  Passed = "Passed",
  Rejected = "Rejected",
  Executed = "Executed",
}

export interface GovernanceProposal {
  /** Unique proposal identifier. */
  id: bigint;
  /** The parameter-changing action this proposal requests. */
  action: ProposalAction;
  /** The proposed new value for the action's parameter. */
  proposedValue: bigint;
  /** Hex-encoded 32-byte hash of the off-chain proposal description. */
  descriptionHash: string;
  /** Address that created the proposal. */
  proposer: string;
  /** Total weight of votes in support. */
  votesFor: bigint;
  /** Total weight of votes against. */
  votesAgainst: bigint;
  /** Current lifecycle status. */
  status: ProposalStatus;
  /** Unix timestamp (seconds) when voting closes. */
  votingEndsAt: number;
}

// ---------------------------------------------------------------------------
// Protocol Stats
// ---------------------------------------------------------------------------

export interface ContractStats {
  /** Total number of invoices ever created. */
  totalInvoices: bigint;
  /** Cumulative number of fully-funded invoices. */
  totalFunded: bigint;
  /** Cumulative number of paid invoices. */
  totalPaid: bigint;
  /** Total USDC volume (in stroops, 6 decimals). */
  totalVolumeUsdc: bigint;
  /** Total EURC volume (in stroops, 6 decimals). */
  totalVolumeEurc: bigint;
  /** Total XLM volume (in stroops, 7 decimals). */
  totalVolumeXlm: bigint;
  /** Per-token volume map: token address → volume. */
  volumeByToken: Record<string, bigint>;
  /** Total volume normalized to USD (depends on oracle price feed). */
  totalVolumeUsdNormalized: bigint;
}

// ---------------------------------------------------------------------------
// Insurance Pool Types
// ---------------------------------------------------------------------------

export interface InsurancePoolInfo {
  poolBalance: bigint;
  coverage: bigint;
  isEnrolled: boolean;
  premiumsPaid: bigint;
}

// ---------------------------------------------------------------------------
// Token Parameters
// ---------------------------------------------------------------------------

export type SupportedToken = 'USDC' | 'EURC' | 'XLM' | string;

export interface TokenConfig {
  address: string;
  symbol: string;
  decimals: number;
}

// ---------------------------------------------------------------------------
// Event Types (Unions)
// ---------------------------------------------------------------------------

export type ILNEventType = 
  | "submitted" 
  | "funded" 
  | "paid" 
  | "partially_paid" 
  | "defaulted" 
  | "appealed" 
  | "appeal_resolved" 
  | "disputed" 
  | "dispute_resolved" 
  | "token_added" 
  | "token_removed" 
  | "parameter_updated" 
  | "transferred" 
  | "cancelled" 
  | "paused" 
  | "unpaused" 
  | "upgraded" 
  | "admin_changed" 
  | "fund_requested" 
  | "fund_queue_resolved";

export interface BaseEvent {
  type: ILNEventType;
  timestamp: number;
  txHash: string;
}

// Catch-all for events payload since full events are huge, we'll just define the union base
export type ILNEvent = BaseEvent & Record<string, any>;
