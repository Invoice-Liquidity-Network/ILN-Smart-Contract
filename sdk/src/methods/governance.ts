// @ts-nocheck
import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  Account,
  Transaction,
} from "@stellar/stellar-sdk";
import { ILNError } from "../errors.js";
import {
  ProposalAction,
  ProposalStatus,
  type Proposal,
  type ProposalFilter,
  type CreateProposalResult,
} from "../types/governance.js";
import { retry } from "../utils/retry.js";
import { decodeGovernanceProposal } from "../utils/xdrDecoder.js";

/**
 * iln_governance has its own `GovernanceError` enum (contracts/iln_governance/src/lib.rs)
 * whose numeric codes are NOT the same as invoice_liquidity's `ContractError`
 * codes in errors.ts (e.g. code 11 is CannotDelegateToSelf here, but
 * NotYetDefaulted there). The existing createProposal/castVote/
 * executeProposal/getProposal functions in this file already reuse
 * `ILNError.fromError`, which predates this — left as-is to avoid an
 * unrelated behavior change, but the delegation/veto/config methods added
 * below need to surface the *correct* governance-specific error (the issues
 * that added them explicitly call out distinguishing e.g. VetoPowerDisabled
 * from NotVetoable), so they use this dedicated mapper instead.
 */
export class GovernanceContractError extends Error {
  constructor(message: string, public readonly code?: number) {
    super(message);
    this.name = "GovernanceContractError";
  }

  static AlreadyInitialized = class AlreadyInitialized extends GovernanceContractError {
    constructor(msg = "Governance contract already initialized") { super(msg, 1); }
  };
  static ProposalNotFound = class ProposalNotFound extends GovernanceContractError {
    constructor(msg = "Proposal not found") { super(msg, 2); }
  };
  static VotingEnded = class VotingEnded extends GovernanceContractError {
    constructor(msg = "Voting period has ended") { super(msg, 3); }
  };
  static ProposalNotActive = class ProposalNotActive extends GovernanceContractError {
    constructor(msg = "Proposal is not active") { super(msg, 4); }
  };
  static NoVotingPower = class NoVotingPower extends GovernanceContractError {
    constructor(msg = "Caller has no voting power") { super(msg, 5); }
  };
  static AlreadyVoted = class AlreadyVoted extends GovernanceContractError {
    constructor(msg = "Already voted on this proposal") { super(msg, 6); }
  };
  static VotingOngoing = class VotingOngoing extends GovernanceContractError {
    constructor(msg = "Voting is still ongoing") { super(msg, 7); }
  };
  static QuorumNotReached = class QuorumNotReached extends GovernanceContractError {
    constructor(msg = "Quorum not reached") { super(msg, 8); }
  };
  static ProposalRejected = class ProposalRejected extends GovernanceContractError {
    constructor(msg = "Proposal was rejected") { super(msg, 9); }
  };
  static AlreadyResolved = class AlreadyResolved extends GovernanceContractError {
    constructor(msg = "Proposal already resolved") { super(msg, 10); }
  };
  static CannotDelegateToSelf = class CannotDelegateToSelf extends GovernanceContractError {
    constructor(msg = "Cannot delegate votes to yourself") { super(msg, 11); }
  };
  static DelegationCyclePrevented = class DelegationCyclePrevented extends GovernanceContractError {
    constructor(msg = "Delegation would create a cycle") { super(msg, 12); }
  };
  static TimelockNotExpired = class TimelockNotExpired extends GovernanceContractError {
    constructor(msg = "Timelock has not expired yet") { super(msg, 13); }
  };
  static Unauthorized = class Unauthorized extends GovernanceContractError {
    constructor(msg = "Unauthorized") { super(msg, 14); }
  };
  static InvalidQuorumBps = class InvalidQuorumBps extends GovernanceContractError {
    constructor(msg = "Quorum bps must be between 1 and 10,000") { super(msg, 15); }
  };
  static NotAdmin = class NotAdmin extends GovernanceContractError {
    constructor(msg = "Caller is not the admin") { super(msg, 16); }
  };
  static NotVetoable = class NotVetoable extends GovernanceContractError {
    constructor(msg = "Proposal cannot be vetoed in its current status") { super(msg, 17); }
  };
  static VetoPowerDisabled = class VetoPowerDisabled extends GovernanceContractError {
    constructor(msg = "Admin veto power has been permanently disabled") { super(msg, 18); }
  };
  static InsufficientProposerBalance = class InsufficientProposerBalance extends GovernanceContractError {
    constructor(msg = "Proposer does not hold the minimum required balance") { super(msg, 19); }
  };

  static fromError(error: unknown): Error {
    const match = String(error).match(/Error\(Contract, (\d+)\)/);
    if (!match) return error instanceof Error ? error : new Error(String(error));
    switch (parseInt(match[1] || "", 10)) {
      case 1: return new GovernanceContractError.AlreadyInitialized();
      case 2: return new GovernanceContractError.ProposalNotFound();
      case 3: return new GovernanceContractError.VotingEnded();
      case 4: return new GovernanceContractError.ProposalNotActive();
      case 5: return new GovernanceContractError.NoVotingPower();
      case 6: return new GovernanceContractError.AlreadyVoted();
      case 7: return new GovernanceContractError.VotingOngoing();
      case 8: return new GovernanceContractError.QuorumNotReached();
      case 9: return new GovernanceContractError.ProposalRejected();
      case 10: return new GovernanceContractError.AlreadyResolved();
      case 11: return new GovernanceContractError.CannotDelegateToSelf();
      case 12: return new GovernanceContractError.DelegationCyclePrevented();
      case 13: return new GovernanceContractError.TimelockNotExpired();
      case 14: return new GovernanceContractError.Unauthorized();
      case 15: return new GovernanceContractError.InvalidQuorumBps();
      case 16: return new GovernanceContractError.NotAdmin();
      case 17: return new GovernanceContractError.NotVetoable();
      case 18: return new GovernanceContractError.VetoPowerDisabled();
      case 19: return new GovernanceContractError.InsufficientProposerBalance();
      default: return new GovernanceContractError(`iln_governance error: ${String(error)}`);
    }
  }
}

/**
 * Build, simulate, sign and submit a governance transaction, polling until the
 * network confirms it. Shared by the write methods below.
 */
async function sendGovernanceCall(
  server: SorobanRpc.Server,
  sourceAccount: Account,
  networkPassphrase: string,
  op: ReturnType<Contract["call"]>,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  // Defaults to ILNError.fromError to preserve existing behavior for
  // createProposal/castVote/executeProposal. New callers below pass
  // GovernanceContractError.fromError for correctly-typed governance errors.
  mapError: (error: unknown) => Error = ILNError.fromError
): Promise<{ txHash: string; returnValue: unknown }> {
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await retry(() => server.simulateTransaction(tx));
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw mapError(sim.error);
  }

  const assembledTx = SorobanRpc.assembleTransaction(tx, sim).build();
  const signedTx = await signTransaction(assembledTx);
  const sendResult = await retry(() => server.sendTransaction(signedTx));
  if (sendResult.errorResult) {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }

  let status = await retry(() => server.getTransaction(sendResult.hash));
  let retries = 0;
  while (status.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND && retries < 15) {
    await new Promise(r => setTimeout(r, 2000));
    status = await retry(() => server.getTransaction(sendResult.hash));
    retries++;
  }
  if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw new Error("Transaction failed during execution");
  }

  const returnValue =
    status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS && status.returnValue
      ? scValToNative(status.returnValue)
      : undefined;

  return { txHash: sendResult.hash, returnValue };
}

/** Normalise a raw contract proposal record into a {@link Proposal}. */
function parseProposal(raw: Record<string, unknown>): Proposal {
  const statusTag =
    ((raw as any)["status"] as unknown)?.tag ?? String((raw as any)["status"]);
  return {
    id: BigInt(String(raw["id"])),
    action: Number(raw["action"]) as ProposalAction,
    proposedValue: BigInt(String(raw["proposed_value"] ?? 0)),
    descriptionHash: (raw as any)["description_hash"]
      ? Buffer.from((raw as any)["description_hash"] as string).toString("hex")
      : "",
    proposer: String((raw as any)["proposer"]),
    votesFor: BigInt(String(raw["votes_for"] ?? 0)),
    votesAgainst: BigInt(String(raw["votes_against"] ?? 0)),
    status: (ProposalStatus as unknown)[statusTag] ?? (statusTag as ProposalStatus),
    votingEndsAt: Number(raw["voting_ends_at"] ?? 0),
  };
}

/**
 * Create a new governance proposal.
 *
 * @param server Soroban RPC server
 * @param contractAddress Governance contract address
 * @param action The parameter-changing action to propose
 * @param proposedValue The proposed new value for the action's parameter
 * @param descriptionHash Hex-encoded 32-byte hash of the off-chain description
 * @param sourceAccount The proposer's account
 * @param signTransaction A function to sign the transaction
 * @param networkPassphrase The network passphrase
 * @returns The new proposalId and txHash
 * @throws {ILNError} When simulation or execution fails
 */
export async function createProposal(
  server: SorobanRpc.Server,
  contractAddress: string,
  action: ProposalAction,
  proposedValue: bigint,
  descriptionHash: string,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<CreateProposalResult> {
  const contract = new Contract(contractAddress);
  const op = contract.call(
    "create_proposal",
    nativeToScVal(sourceAccount.accountId(), { type: "address" }),
    nativeToScVal(action, { type: "u32" }),
    nativeToScVal(proposedValue, { type: "i128" }),
    nativeToScVal(Buffer.from(descriptionHash, "hex"), { type: "bytes" })
  );

  const { txHash, returnValue } = await sendGovernanceCall(
    server,
    sourceAccount,
    networkPassphrase,
    op,
    signTransaction
  );

  return {
    proposalId: returnValue !== undefined ? BigInt(String(returnValue)) : 0n,
    txHash,
  };
}

/**
 * Cast a vote on an active proposal.
 *
 * @param support `true` to vote for, `false` to vote against.
 */
export async function castVote(
  server: SorobanRpc.Server,
  contractAddress: string,
  proposalId: bigint,
  support: boolean,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<{ txHash: string }> {
  const contract = new Contract(contractAddress);
  const op = contract.call(
    "cast_vote",
    nativeToScVal(sourceAccount.accountId(), { type: "address" }),
    nativeToScVal(proposalId, { type: "u64" }),
    nativeToScVal(support, { type: "bool" })
  );

  const { txHash } = await sendGovernanceCall(
    server,
    sourceAccount,
    networkPassphrase,
    op,
    signTransaction
  );
  return { txHash };
}

/**
 * Execute a proposal that has passed its vote.
 */
export async function executeProposal(
  server: SorobanRpc.Server,
  contractAddress: string,
  proposalId: bigint,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<{ txHash: string }> {
  const contract = new Contract(contractAddress);
  const op = contract.call(
    "execute_proposal",
    nativeToScVal(sourceAccount.accountId(), { type: "address" }),
    nativeToScVal(proposalId, { type: "u64" })
  );

  const { txHash } = await sendGovernanceCall(
    server,
    sourceAccount,
    networkPassphrase,
    op,
    signTransaction
  );
  return { txHash };
}

/**
 * Fetch a single proposal by ID (read-only; no signer required).
 */
export async function getProposal(
  server: SorobanRpc.Server,
  contractAddress: string,
  id: bigint,
  sourceAccount: Account,
  networkPassphrase: string
): Promise<Proposal> {
  const contract = new Contract(contractAddress);
  const op = contract.call("get_proposal", nativeToScVal(id, { type: "u64" }));

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
    throw new ILNError(`Proposal ${id} not found`);
  }

  const raw = scValToNative(sim.result.retval) as Record<string, unknown>;
  return decodeGovernanceProposal(raw);
}

/**
 * Check if an address has voted on a proposal (read-only; no signer required).
 * @param voter The address to check
 * @param proposalId The proposal ID
 * @returns true if the address has voted, false otherwise
 */
export async function hasVoted(
  server: SorobanRpc.Server,
  contractAddress: string,
  voter: string,
  proposalId: bigint,
  sourceAccount: Account,
  networkPassphrase: string
): Promise<boolean> {
  const contract = new Contract(contractAddress);
  const op = contract.call(
    "has_voted",
    nativeToScVal(voter, { type: "address" }),
    nativeToScVal(proposalId, { type: "u64" })
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
    throw GovernanceContractError.fromError(sim.error);
  }
  if (!sim.result?.retval) {
    return false;
  }

  return scValToNative(sim.result.retval) as boolean;
}

/**
 * List proposals, optionally filtered by status and/or proposer (read-only).
 * @param status Optional proposal status to filter by
 * @param page Page number (0-indexed, defaults to 0)
 * @param pageSize Results per page (defaults to 20, max 20)
 * @param filter Optional additional client-side filters (proposer)
 */
export async function listProposals(
  server: SorobanRpc.Server,
  contractAddress: string,
  sourceAccount: Account,
  networkPassphrase: string,
  status?: ProposalStatus,
  page: number = 0,
  pageSize: number = 20,
  filter?: ProposalFilter
): Promise<Proposal[]> {
  const contract = new Contract(contractAddress);
  const op = contract.call(
    "list_proposals",
    nativeToScVal(status, { type: "option" }),
    nativeToScVal(page, { type: "u32" }),
    nativeToScVal(pageSize, { type: "u32" })
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
    return [];
  }

  const rawArr = scValToNative(sim.result.retval) as Record<string, unknown>[];
  let proposals = rawArr.map(raw => decodeGovernanceProposal(raw as Record<string, unknown>));

  if (filter?.proposer) {
    proposals = proposals.filter(p => p.proposer === filter.proposer);
  }
  return proposals;
}

// ---------------------------------------------------------------------------
// Delegation (#471)
// ---------------------------------------------------------------------------

/**
 * Delegate the caller's voting weight to `delegate`.
 *
 * Wraps `delegate_votes(delegator, delegate)`. Requires the delegator's
 * signature — `sourceAccount` must be the delegator's account. The contract
 * walks the forward delegation chain to detect cycles before storing the
 * new edge.
 *
 * @throws {GovernanceContractError.CannotDelegateToSelf} If delegator === delegate
 * @throws {GovernanceContractError.DelegationCyclePrevented} If delegating to `delegate` would close a cycle
 */
export async function delegateVotes(
  server: SorobanRpc.Server,
  contractAddress: string,
  delegatorAddress: string,
  delegateAddress: string,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<{ txHash: string }> {
  const contract = new Contract(contractAddress);
  const op = contract.call(
    "delegate_votes",
    nativeToScVal(delegatorAddress, { type: "address" }),
    nativeToScVal(delegateAddress, { type: "address" })
  );

  const { txHash } = await sendGovernanceCall(
    server,
    sourceAccount,
    networkPassphrase,
    op,
    signTransaction,
    GovernanceContractError.fromError
  );
  return { txHash };
}

/**
 * Remove the caller's active delegation, if any.
 *
 * Wraps `undelegate_votes(delegator)`. Requires the delegator's signature —
 * `sourceAccount` must be the delegator's account. No-ops (does not error)
 * if the caller had no active delegation.
 */
export async function undelegateVotes(
  server: SorobanRpc.Server,
  contractAddress: string,
  delegatorAddress: string,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<{ txHash: string }> {
  const contract = new Contract(contractAddress);
  const op = contract.call(
    "undelegate_votes",
    nativeToScVal(delegatorAddress, { type: "address" })
  );

  const { txHash } = await sendGovernanceCall(
    server,
    sourceAccount,
    networkPassphrase,
    op,
    signTransaction,
    GovernanceContractError.fromError
  );
  return { txHash };
}

// ---------------------------------------------------------------------------
// Admin veto (#472)
// ---------------------------------------------------------------------------

/**
 * Admin-only: block a proposal from proceeding.
 *
 * Wraps `veto_proposal(proposal_id, reason_hash)`. Requires the configured
 * admin's signature — `sourceAccount` must be the stored admin account (see
 * {@link setExecutionDelay}, which sets the admin on first call). Only
 * proposals in `Active` or `Passed` status can be vetoed.
 *
 * @param reasonHash Hex-encoded 32-byte hash of the off-chain veto rationale
 * @throws {GovernanceContractError.VetoPowerDisabled} If disableVetoPower() was already called
 * @throws {GovernanceContractError.NotVetoable} If the proposal isn't Active or Passed
 * @throws {GovernanceContractError.ProposalNotFound} If the proposal id is unknown
 */
export async function vetoProposal(
  server: SorobanRpc.Server,
  contractAddress: string,
  proposalId: bigint,
  reasonHash: string,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<{ txHash: string }> {
  const contract = new Contract(contractAddress);
  const op = contract.call(
    "veto_proposal",
    nativeToScVal(proposalId, { type: "u64" }),
    nativeToScVal(Buffer.from(reasonHash, "hex"), { type: "bytes" })
  );

  const { txHash } = await sendGovernanceCall(
    server,
    sourceAccount,
    networkPassphrase,
    op,
    signTransaction,
    GovernanceContractError.fromError
  );
  return { txHash };
}

/**
 * Permanently disable the admin veto power. **One-way switch** — cannot be
 * re-enabled once called.
 *
 * Wraps `disable_veto_power()`. Requires a signature from the configured ILN
 * contract address (same pattern as `set_min_quorum_bps`/
 * `set_min_proposal_balance` below) — `sourceAccount` must be authorized as
 * that address, not an arbitrary caller.
 */
export async function disableVetoPower(
  server: SorobanRpc.Server,
  contractAddress: string,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<{ txHash: string }> {
  const contract = new Contract(contractAddress);
  const op = contract.call("disable_veto_power");

  const { txHash } = await sendGovernanceCall(
    server,
    sourceAccount,
    networkPassphrase,
    op,
    signTransaction,
    GovernanceContractError.fromError
  );
  return { txHash };
}

// ---------------------------------------------------------------------------
// Execution delay / timelock (#473)
// ---------------------------------------------------------------------------

/**
 * Set the execution delay (timelock) applied before a passed proposal can
 * be executed.
 *
 * Wraps `set_execution_delay(admin, delay)`. Requires the admin's signature
 * — `sourceAccount` must be `adminAddress`'s account. On the *first* call
 * (no admin stored yet) the calling address becomes the stored admin for
 * future admin-gated calls (including `vetoProposal`); subsequent calls
 * require the same admin address.
 *
 * @param delay Timelock duration in seconds
 * @throws {GovernanceContractError.Unauthorized} If called by an address other than the already-stored admin
 */
export async function setExecutionDelay(
  server: SorobanRpc.Server,
  contractAddress: string,
  adminAddress: string,
  delay: number,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<{ txHash: string }> {
  const contract = new Contract(contractAddress);
  const op = contract.call(
    "set_execution_delay",
    nativeToScVal(adminAddress, { type: "address" }),
    nativeToScVal(delay, { type: "u32" })
  );

  const { txHash } = await sendGovernanceCall(
    server,
    sourceAccount,
    networkPassphrase,
    op,
    signTransaction,
    GovernanceContractError.fromError
  );
  return { txHash };
}

/**
 * Fetch the currently configured execution delay (timelock), in seconds.
 * Read-only; no signer required. Defaults to 0 if never set.
 */
export async function getExecutionDelay(
  server: SorobanRpc.Server,
  contractAddress: string,
  sourceAccount: Account,
  networkPassphrase: string
): Promise<number> {
  const contract = new Contract(contractAddress);
  const op = contract.call("get_execution_delay");

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await retry(() => server.simulateTransaction(tx));
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw GovernanceContractError.fromError(sim.error);
  }
  if (!sim.result?.retval) {
    return 0;
  }
  return Number(scValToNative(sim.result.retval));
}

// ---------------------------------------------------------------------------
// Quorum / proposal balance config (#474)
// ---------------------------------------------------------------------------

/**
 * Update the minimum quorum required for a proposal to pass.
 *
 * Wraps `set_min_quorum_bps(min_quorum_bps)`. Requires a signature from the
 * configured ILN contract address — `sourceAccount` must be authorized as
 * that address, not an arbitrary caller.
 *
 * @param quorumBps Basis points, must be in 1..=10_000 (e.g. 1000 = 10%)
 * @throws {GovernanceContractError.InvalidQuorumBps} If quorumBps is 0 or > 10,000
 */
export async function setMinQuorumBps(
  server: SorobanRpc.Server,
  contractAddress: string,
  quorumBps: number,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<{ txHash: string }> {
  const contract = new Contract(contractAddress);
  const op = contract.call(
    "set_min_quorum_bps",
    nativeToScVal(quorumBps, { type: "u32" })
  );

  const { txHash } = await sendGovernanceCall(
    server,
    sourceAccount,
    networkPassphrase,
    op,
    signTransaction,
    GovernanceContractError.fromError
  );
  return { txHash };
}

/**
 * Update the minimum token balance required to create a proposal.
 *
 * Wraps `set_min_proposal_balance(min_balance)`. Requires a signature from
 * the configured ILN contract address — `sourceAccount` must be authorized
 * as that address, not an arbitrary caller.
 */
export async function setMinProposalBalance(
  server: SorobanRpc.Server,
  contractAddress: string,
  minBalance: bigint,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<{ txHash: string }> {
  const contract = new Contract(contractAddress);
  const op = contract.call(
    "set_min_proposal_balance",
    nativeToScVal(minBalance, { type: "i128" })
  );

  const { txHash } = await sendGovernanceCall(
    server,
    sourceAccount,
    networkPassphrase,
    op,
    signTransaction,
    GovernanceContractError.fromError
  );
  return { txHash };
}
