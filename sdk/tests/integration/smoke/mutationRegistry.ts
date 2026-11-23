/**
 * Registry mapping every public SDK mutation (a method in `src/methods` that signs and submits
 * a transaction) to the smoke test that proves its effect on confirmed on-chain state.
 *
 * `mutationRegistry.test.ts` fails if a mutation is added to `src/methods` without an entry
 * here, if a `smoke` entry points at a test that does not exist, or if a `deferred` entry has
 * no reason. Read-only methods are listed in `READ_ONLY` so every exported function is classified.
 *
 * Statuses:
 *   smoke    - a testnet smoke test calls the method and asserts chain state read back afterwards.
 *   deferred - no smoke test yet; `reason` says what is missing. The method is still covered by
 *              mocked unit tests (src/methods/*.test.ts) which do NOT prove on-chain behaviour.
 */

export interface SmokeEntry {
  status: "smoke";
  /** Path relative to `sdk/`. */
  file: string;
  /** Substring of the `it(...)` title that exercises this mutation. */
  test: string;
  /** What is read back from chain to confirm the effect. */
  confirms: string;
  /** Extra environment (beyond TEST_SUBMITTER_SECRET / TEST_LP_SECRET) required to run it. */
  requires?: string;
}

export interface DeferredEntry {
  status: "deferred";
  reason: DeferredReason;
  detail: string;
}

export type DeferredReason =
  | "needs-admin-key" //       caller must be the contract admin; no admin secret in the smoke environment
  | "needs-governance" //      needs a passed proposal / token-holder quorum and execution delay
  | "needs-default-state" //   needs an invoice past due + grace period, not reachable in a smoke run
  | "needs-second-contract" // needs a deployed distribution / reputation / second-token contract
  | "destructive" //           would pause or upgrade the shared testnet deployment other suites use
  | "pure-builder"; //         builds a transaction, submits nothing

export type RegistryEntry = SmokeEntry | DeferredEntry;

const LIFECYCLE = "tests/integration/invoiceLifecycle.integration.test.ts";
const INVOICE_SMOKE = "tests/integration/smoke/invoiceMutations.integration.test.ts";
const INSURANCE_SMOKE = "tests/integration/smoke/insuranceMutations.integration.test.ts";

const admin = (detail: string): DeferredEntry => ({ status: "deferred", reason: "needs-admin-key", detail });
const gov = (detail: string): DeferredEntry => ({ status: "deferred", reason: "needs-governance", detail });

/** Every exported mutation in src/methods/*.ts (excluding tests). */
export const MUTATIONS: Record<string, RegistryEntry> = {
  // ---- invoice lifecycle -------------------------------------------------------------------
  submitInvoice: {
    status: "smoke",
    file: LIFECYCLE,
    test: "submits, funds and marks an invoice paid",
    confirms: "getInvoice status=Pending after submit",
  },
  fundInvoice: {
    status: "smoke",
    file: LIFECYCLE,
    test: "submits, funds and marks an invoice paid",
    confirms: "getInvoice status=Funded after fund",
  },
  markPaid: {
    status: "smoke",
    file: LIFECYCLE,
    test: "submits, funds and marks an invoice paid",
    confirms: "getInvoice status=Paid after markPaid",
  },
  cancelInvoice: {
    status: "smoke",
    file: INVOICE_SMOKE,
    test: "cancelInvoice: Pending -> Cancelled",
    confirms: "getInvoice status=Cancelled; repeat cancel refused; non-submitter refused",
  },
  transferInvoice: {
    status: "smoke",
    file: INVOICE_SMOKE,
    test: "transferInvoice: freelancer changes on chain",
    confirms: "getInvoice freelancer=new owner; non-owner and previous owner refused",
  },
  transferLPPosition: {
    status: "smoke",
    file: INVOICE_SMOKE,
    test: "transferLPPosition: funder changes on chain",
    confirms: "getInvoice funder=new LP; non-LP and previous LP refused",
  },
  submitInvoicesBatch: {
    status: "smoke",
    file: INVOICE_SMOKE,
    test: "submitInvoicesBatch: every item exists on chain",
    confirms: "getInvoice for each returned id (status, freelancer, payer, amount, rate)",
  },
  disputeInvoice: {
    status: "smoke",
    file: INVOICE_SMOKE,
    test: "disputeInvoice: only the payer can dispute",
    confirms: "getInvoice status=Disputed; non-payer and repeat refused",
  },
  resolveDispute: admin("only the admin can resolve a dispute; needs a Disputed invoice (produced by the disputeInvoice smoke test) plus an admin secret"),
  appealInvoice: {
    status: "deferred",
    reason: "needs-default-state",
    detail: "appeals apply to a Defaulted invoice, which requires the due date and grace period to elapse",
  },
  resolveAppeal: {
    status: "deferred",
    reason: "needs-default-state",
    detail: "needs an Appealed invoice (Defaulted first) and the admin key",
  },
  convertInvoiceToken: {
    status: "deferred",
    reason: "needs-second-contract",
    detail: "needs a second allow-listed token and an oracle price for the pair",
  },
  submitBatchTransaction: {
    status: "deferred",
    reason: "needs-second-contract",
    detail: "multi-contract batch; needs the additional contract ids a run would target",
  },
  // ---- fund queue --------------------------------------------------------------------------
  joinFundQueue: {
    status: "deferred",
    reason: "needs-second-contract",
    detail: "needs the fund-queue contract id, which is empty in the testnet registry",
  },
  resolveFundQueue: {
    status: "deferred",
    reason: "needs-second-contract",
    detail: "needs the fund-queue contract id and a matured queue entry",
  },
  // ---- insurance pool ----------------------------------------------------------------------
  enrollInsurancePool: {
    status: "smoke",
    file: INSURANCE_SMOKE,
    test: "enrollInsurancePool: a fresh LP goes from not enrolled to enrolled",
    confirms: "isEnrolled false -> true",
    requires: "INSURANCE_POOL_ID",
  },
  initializeInsurancePool: admin("one-time admin initialisation of the pool"),
  depositInsurancePremium: {
    status: "deferred",
    reason: "needs-second-contract",
    detail: "needs a deployed pool with a token configured and an LP holding that token",
  },
  claimInsurance: {
    status: "deferred",
    reason: "needs-default-state",
    detail: "needs a Defaulted, insured invoice",
  },
  setBasePremiumRateViaGovernance: gov("rate change is a governance action"),
  // ---- distribution ------------------------------------------------------------------------
  accrueLp: {
    status: "deferred",
    reason: "needs-second-contract",
    detail: "needs the distribution contract id (empty in the testnet registry) and a funded invoice",
  },
  accrueSettlement: {
    status: "deferred",
    reason: "needs-second-contract",
    detail: "needs the distribution contract id and a settled invoice",
  },
  claimTokens: {
    status: "deferred",
    reason: "needs-second-contract",
    detail: "needs the distribution contract id and accrued balance",
  },
  // ---- reputation bonus --------------------------------------------------------------------
  submitReputationInvoice: {
    status: "deferred",
    reason: "needs-second-contract",
    detail: "needs a deployed reputation_bonus contract",
  },
  markReputationInvoicePaid: {
    status: "deferred",
    reason: "needs-second-contract",
    detail: "needs a deployed reputation_bonus contract and a submitted invoice",
  },
  handleDefault: {
    status: "deferred",
    reason: "needs-default-state",
    detail: "needs a defaulted reputation invoice",
  },
  // ---- governance --------------------------------------------------------------------------
  createProposal: gov("needs a governance contract and a balance above the minimum proposal balance"),
  castVote: gov("needs an open proposal"),
  executeProposal: gov("needs a passed proposal past its execution delay"),
  delegateVotes: gov("needs governance token balance"),
  undelegateVotes: gov("needs an existing delegation"),
  configureVetoMultisig: gov("admin-only governance configuration"),
  vetoProposal: gov("needs a veto multisig and a pending proposal"),
  disableVetoPower: gov("irreversible governance change"),
  disableVetoPowerWithReason: gov("irreversible governance change"),
  setExecutionDelay: gov("admin-only governance configuration"),
  setMinQuorumBps: gov("admin-only governance configuration"),
  setMinProposalBalance: gov("admin-only governance configuration"),
  setQuadraticVotingEnabled: gov("admin-only governance configuration"),
  // ---- admin / operator --------------------------------------------------------------------
  pause: { status: "deferred", reason: "destructive", detail: "pausing the shared testnet contract would fail every other suite" },
  unpause: { status: "deferred", reason: "destructive", detail: "only meaningful after pause; same shared-deployment risk" },
  setAdmin: { status: "deferred", reason: "destructive", detail: "rotating the admin could lock the team out of the shared deployment" },
  upgrade: { status: "deferred", reason: "destructive", detail: "replaces the shared contract's WASM" },
  setDistributionContract: admin("admin-only configuration of the shared deployment"),
  addToken: admin("admin-only allow-list change"),
  removeToken: admin("admin-only allow-list change"),
  updateFeeRate: admin("admin-only; changes fees for every user of the shared deployment"),
  updateMaxDiscount: admin("admin-only; changes limits for every user of the shared deployment"),
  setPriceOracle: admin("admin-only configuration of the shared deployment"),
  setMaxOracleAge: admin("admin-only configuration of the shared deployment"),
  setInsurancePool: admin("admin-only configuration of the shared deployment"),
};

/** Exported `src/methods` functions that never submit a transaction. */
export const READ_ONLY: readonly string[] = [
  "computeFundingCost",
  "computeEffectiveYieldBps",
  "sha256Hex",
  "buildBatchTransaction",
  "getInsurancePool",
  "getLpScore",
  "getDistributionAccrual",
  "getProposal",
  "hasVoted",
  "listProposals",
  "getExecutionDelay",
  "isQuadraticVotingEnabled",
  "getAppliedVoteWeight",
  "getProductionDelayBounds",
  "isValidProductionDelay",
  "isEtaReached",
  "getVetoState",
  "getVetoDisableRecord",
  "getInvoice",
  "listInvoicesBySubmitter",
  "getSubmitterInvoices",
  "listInvoicesByLP",
  "getPayerScore",
  "getReputation",
  "getReputationBonusConfig",
  "getReputationBonusReputation",
  "getReferralStats",
  "getPoolBalance",
  "getCoverage",
  "isEnrolled",
  "getPremiumsPaid",
  "getInsurancePoolInfo",
  "getTokenAddress",
  "calculatePremiumRate",
  "getTieredCoverage",
  "isInsuranceEnrolled",
  "getInsurancePremiums",
  "isInsuranceClaimed",
  "getBasePremiumRateBps",
  "getDefaultCount",
  "calculateInsurancePremiumRateBps",
  "calculateInsurancePremiumAmount",
  "getInsuranceTieredCoverage",
  "getInsuranceBalanceCap",
  "getPoolHealth",
  "getVersion",
  "getNftMetadata",
  "getNftOwner",
  "getLpInvoices",
  "getTokenDecimals",
  "getContractStats",
  "getTopPayers",
];
