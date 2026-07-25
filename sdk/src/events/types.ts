/**
 * Typed event union for the Invoice Liquidity Network contract.
 *
 * Every event emitted on-chain has a `type` discriminant that matches the
 * Soroban contract-event topic string, plus the decoded data fields.
 */

// ---------------------------------------------------------------------------
// Event type literals
// ---------------------------------------------------------------------------


import type { ILNEventType, ILNEvent } from "@invoice-liquidity/types";

// ---------------------------------------------------------------------------
// Per-event payload types  (mirror the Rust #[contractevent] structs)
// ---------------------------------------------------------------------------

export interface InvoiceSubmittedEvent {
  type: "submitted";
  invoiceId: bigint;
  freelancer: string;
  payer: string;
  token: string;
  amount: bigint;
  dueDate: bigint;
  discountRate: number;
  status: string;
  timestamp: bigint;
}

export interface InvoiceFundedEvent {
  type: "funded";
  invoiceId: bigint;
  funder: string;
  freelancer: string;
  payer: string;
  token: string;
  fundAmount: bigint;
  amountFunded: bigint;
  invoiceAmount: bigint;
  dueDate: bigint;
  discountRate: number;
  fundedAt: bigint | null;
  status: string;
  lp: string;
  effectiveYieldBps: number;
  timestamp: bigint;
}

export interface InvoicePaidEvent {
  type: "paid";
  invoiceId: bigint;
  payer: string;
  lp: string;
  freelancer: string;
  token: string;
  amountPaid: bigint;
  lpEarned: bigint;
  lpPayout: bigint;
  settlementTimestamp: bigint;
  paidOnTime: boolean;
  status: string;
}

export interface InvoicePartiallyPaidEvent {
  type: "partially_paid";
  invoiceId: bigint;
  payer: string;
  amountPaidNow: bigint;
  totalAmountPaid: bigint;
  remainingAmount: bigint;
}

export interface InvoiceDefaultedEvent {
  type: "defaulted";
  invoiceId: bigint;
  funder: string;
  freelancer: string;
  payer: string;
  token: string;
  amount: bigint;
  dueDate: bigint;
  defaultedAt: bigint;
  discountAmount: bigint;
  status: string;
}

export interface DefaultAppealedEvent {
  type: "appealed";
  invoiceId: bigint;
  payer: string;
  evidenceHash: string;
  appealedAt: bigint;
}

export interface AppealResolvedEvent {
  type: "appeal_resolved";
  invoiceId: bigint;
  payer: string;
  upheld: boolean;
  resolvedAt: bigint;
}

export interface InvoiceDisputedEvent {
  type: "disputed";
  invoiceId: bigint;
  payer: string;
  reasonHash: string;
  disputedAt: bigint;
}

export interface DisputeResolvedEvent {
  type: "dispute_resolved";
  invoiceId: bigint;
  resolutionHash: string;
  resolution: number;
  resolvedAt: bigint;
}

export interface TokenAddedEvent {
  type: "token_added";
  token: string;
  decimals: number;
}

export interface TokenRemovedEvent {
  type: "token_removed";
  token: string;
}

export interface ParameterUpdatedEvent {
  type: "parameter_updated";
  paramName: string;
  oldValue: bigint;
  newValue: bigint;
  updatedBy: string;
}

export interface InvoiceTransferredEvent {
  type: "transferred";
  invoiceId: bigint;
  oldFreelancer: string;
  newFreelancer: string;
  status: string;
}

export interface InvoiceCancelledEvent {
  type: "cancelled";
  invoiceId: bigint;
  freelancer: string;
  status: string;
}

export interface ContractPausedEvent {
  type: "paused";
  timestamp: bigint;
}

export interface ContractUnpausedEvent {
  type: "unpaused";
  timestamp: bigint;
}

export interface ContractUpgradedEvent {
  type: "upgraded";
  admin: string;
  newWasmHash: string;
  timestamp: bigint;
}

export interface AdminChangedEvent {
  type: "admin_changed";
  oldAdmin: string;
  newAdmin: string;
  timestamp: bigint;
}

export interface FundRequestedEvent {
  type: "fund_requested";
  invoiceId: bigint;
  lp: string;
  score: number;
}

export interface FundQueueResolvedEvent {
  type: "fund_queue_resolved";
  invoiceId: bigint;
  approvedLp: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

/**
 * Criteria used to narrow the event stream.  All fields are optional; an
 * empty filter matches every ILN contract event.
 */
export interface EventFilter {
  /** Only emit events whose `type` is in this list. */
  types?: ILNEventType[];
  /** Only emit events that mention this invoice ID (in a topic). */
  invoiceId?: bigint;
  /**
   * Only emit events that mention this Stellar address in any topic
   * (freelancer, payer, LP, admin, token …).
   */
  address?: string;
}

/** Call to stop the subscription and close the underlying stream. */
export type Unsubscribe = () => void;

export type { ILNEventType, ILNEvent };
