import { vi, describe, it, expect, beforeEach} from 'vitest';
import {
  createProposal,
  castVote,
  executeProposal,
  getProposal,
  listProposals,
  delegateVotes,
  undelegateVotes,
  vetoProposal,
  disableVetoPower,
  setExecutionDelay,
  getExecutionDelay,
  setMinQuorumBps,
  setMinProposalBalance,
  GovernanceContractError,
} from "./governance.js";
import { ProposalAction, ProposalStatus } from "../types/governance.js";
import { Account, SorobanRpc, scValToNative } from "@stellar/stellar-sdk";

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual("@stellar/stellar-sdk");
  return { ...actual, scValToNative: vi.fn(), SorobanRpc: { ...actual.SorobanRpc, assembleTransaction: vi.fn(() => ({ build: () => ({}) })) } };
});

const PROPOSER = "GBR7RT4MZTLKK2JNZPOSWVY74VFDR4HVR24QZNH2WONHPQFJZPKHWOTP";
const DELEGATE = "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37";
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const PASS = "Test SDF Network ; September 2015";
const HASH32 = "ab".repeat(32);

const mockScValToNative = scValToNative as unknown as vi.Mock;

describe("governance", () => {
  const mockServer = {
    simulateTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
  } as unknown as SorobanRpc.Server;

  const account = new Account(PROPOSER, "1");
  const sign = vi.fn((tx) => tx);

  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error mock

    // @ts-expect-error mock
    mockServer.simulateTransaction.mockResolvedValue({ result: { retval: {} } });
    // @ts-expect-error mock
    mockServer.sendTransaction.mockResolvedValue({ status: "PENDING", hash: "txGOV" });
    // @ts-expect-error mock
    mockServer.getTransaction.mockResolvedValue({
      status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
      returnValue: {},
    });
  });

  it("createProposal returns the new proposalId and txHash", async () => {
    mockScValToNative.mockReturnValue(5n);
    const res = await createProposal(
      mockServer, CONTRACT, ProposalAction.UpdateProtocolFee, 250n, HASH32, account, sign, PASS
    );
    expect(res).toEqual({ proposalId: 5n, txHash: "txGOV" });
    expect(sign).toHaveBeenCalled();
  });

  it("castVote submits and returns txHash", async () => {
    const res = await castVote(mockServer, CONTRACT, 5n, true, account, sign, PASS);
    expect(res.txHash).toBe("txGOV");
  });

  it("executeProposal submits and returns txHash", async () => {
    const res = await executeProposal(mockServer, CONTRACT, 5n, account, sign, PASS);
    expect(res.txHash).toBe("txGOV");
  });

  it("getProposal parses a raw proposal record", async () => {
    mockScValToNative.mockReturnValue({
      id: "5",
      action: 0,
      proposed_value: "250",
      proposer: PROPOSER,
      votes_for: "10",
      votes_against: "2",
      status: { tag: "Active" },
      voting_ends_at: 1700,
    });
    const p = await getProposal(mockServer, CONTRACT, 5n, account, PASS);
    expect(p.id).toBe(5n);
    expect(p.action).toBe(ProposalAction.UpdateProtocolFee);
    expect(p.votesFor).toBe(10n);
    expect(p.status).toBe(ProposalStatus.Active);
  });

  it("listProposals filters by status", async () => {
    mockScValToNative.mockReturnValue([
      { id: "1", action: 0, proposer: PROPOSER, status: { tag: "Active" } },
      { id: "2", action: 0, proposer: PROPOSER, status: { tag: "Executed" } },
    ]);
    const active = await listProposals(mockServer, CONTRACT, account, PASS, {
      status: ProposalStatus.Active,
    });
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(1n);
  });

  it("delegateVotes submits and returns txHash", async () => {
    const res = await delegateVotes(mockServer, CONTRACT, PROPOSER, DELEGATE, account, sign, PASS);
    expect(res.txHash).toBe("txGOV");
  });

  it("delegateVotes throws GovernanceContractError.CannotDelegateToSelf on Error(Contract, 11)", async () => {
    // @ts-expect-error mock
    mockServer.simulateTransaction.mockResolvedValueOnce({ error: "Error(Contract, 11)" });
    await expect(
      delegateVotes(mockServer, CONTRACT, PROPOSER, PROPOSER, account, sign, PASS)
    ).rejects.toBeInstanceOf(GovernanceContractError.CannotDelegateToSelf);
  });

  it("delegateVotes throws GovernanceContractError.DelegationCyclePrevented on Error(Contract, 12)", async () => {
    // @ts-expect-error mock
    mockServer.simulateTransaction.mockResolvedValueOnce({ error: "Error(Contract, 12)" });
    await expect(
      delegateVotes(mockServer, CONTRACT, PROPOSER, DELEGATE, account, sign, PASS)
    ).rejects.toBeInstanceOf(GovernanceContractError.DelegationCyclePrevented);
  });

  it("undelegateVotes submits and returns txHash", async () => {
    const res = await undelegateVotes(mockServer, CONTRACT, PROPOSER, account, sign, PASS);
    expect(res.txHash).toBe("txGOV");
  });

  it("vetoProposal submits and returns txHash", async () => {
    const res = await vetoProposal(mockServer, CONTRACT, 5n, HASH32, account, sign, PASS);
    expect(res.txHash).toBe("txGOV");
  });

  it("vetoProposal throws GovernanceContractError.VetoPowerDisabled on Error(Contract, 18)", async () => {
    // @ts-expect-error mock
    mockServer.simulateTransaction.mockResolvedValueOnce({ error: "Error(Contract, 18)" });
    await expect(
      vetoProposal(mockServer, CONTRACT, 5n, HASH32, account, sign, PASS)
    ).rejects.toBeInstanceOf(GovernanceContractError.VetoPowerDisabled);
  });

  it("vetoProposal throws GovernanceContractError.NotVetoable on Error(Contract, 17)", async () => {
    // @ts-expect-error mock
    mockServer.simulateTransaction.mockResolvedValueOnce({ error: "Error(Contract, 17)" });
    await expect(
      vetoProposal(mockServer, CONTRACT, 5n, HASH32, account, sign, PASS)
    ).rejects.toBeInstanceOf(GovernanceContractError.NotVetoable);
  });

  it("disableVetoPower submits and returns txHash", async () => {
    const res = await disableVetoPower(mockServer, CONTRACT, account, sign, PASS);
    expect(res.txHash).toBe("txGOV");
  });

  it("setExecutionDelay submits and returns txHash", async () => {
    const res = await setExecutionDelay(mockServer, CONTRACT, PROPOSER, 3600, account, sign, PASS);
    expect(res.txHash).toBe("txGOV");
  });

  it("setExecutionDelay throws GovernanceContractError.Unauthorized on Error(Contract, 14)", async () => {
    // @ts-expect-error mock
    mockServer.simulateTransaction.mockResolvedValueOnce({ error: "Error(Contract, 14)" });
    await expect(
      setExecutionDelay(mockServer, CONTRACT, PROPOSER, 3600, account, sign, PASS)
    ).rejects.toBeInstanceOf(GovernanceContractError.Unauthorized);
  });

  it("getExecutionDelay returns the decoded delay", async () => {
    mockScValToNative.mockReturnValue(3600);
    const delay = await getExecutionDelay(mockServer, CONTRACT, account, PASS);
    expect(delay).toBe(3600);
  });

  it("getExecutionDelay returns 0 when unset", async () => {
    // @ts-expect-error mock
    mockServer.simulateTransaction.mockResolvedValueOnce({ result: { retval: null } });
    const delay = await getExecutionDelay(mockServer, CONTRACT, account, PASS);
    expect(delay).toBe(0);
  });

  it("setMinQuorumBps submits and returns txHash", async () => {
    const res = await setMinQuorumBps(mockServer, CONTRACT, 1000, account, sign, PASS);
    expect(res.txHash).toBe("txGOV");
  });

  it("setMinQuorumBps throws GovernanceContractError.InvalidQuorumBps on Error(Contract, 15)", async () => {
    // @ts-expect-error mock
    mockServer.simulateTransaction.mockResolvedValueOnce({ error: "Error(Contract, 15)" });
    await expect(
      setMinQuorumBps(mockServer, CONTRACT, 0, account, sign, PASS)
    ).rejects.toBeInstanceOf(GovernanceContractError.InvalidQuorumBps);
  });

  it("setMinProposalBalance submits and returns txHash", async () => {
    const res = await setMinProposalBalance(mockServer, CONTRACT, 500n, account, sign, PASS);
    expect(res.txHash).toBe("txGOV");
  });
});
