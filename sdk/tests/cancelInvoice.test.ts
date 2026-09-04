import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Account, SorobanRpc, Contract, scValToNative } from '@stellar/stellar-sdk';
import { cancelInvoice } from '../src/methods/cancelInvoice.js';
import { ILNError } from '../src/errors.js';
import * as queries from '../src/methods/queries.js';

vi.mock('../src/methods/queries.js');

// assembleTransaction is a non-configurable static on SorobanRpc, so it can't
// be spied on directly — mock it at the module level instead.
vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      assembleTransaction: vi.fn(),
    },
  };
});

const mockAssembleTransaction = SorobanRpc.assembleTransaction as unknown as ReturnType<typeof vi.fn>;

describe('cancelInvoice', () => {
  const mockServer = {
    simulateTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
  } as unknown as SorobanRpc.Server;
  const mockAccount = new Account("GAGZSXAR7P7PASD2PGYISBMEZCMSI35TRJXYZTZNNCAUZRDEMHQM2XJS", "1");
  const mockSign = vi.fn((tx) => tx);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws if invoice is not in Pending state', async () => {
    // @ts-ignore
    queries.getInvoice.mockResolvedValue({ status: 'Funded', freelancer: "GAGZSXAR7P7PASD2PGYISBMEZCMSI35TRJXYZTZNNCAUZRDEMHQM2XJS" });
    await expect(cancelInvoice(mockServer, "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4", 1n, mockAccount, mockSign, 'pass'))
      .rejects.toThrow(ILNError.InvoiceNotCancellable);
  });

  it('throws if caller is not the invoice submitter', async () => {
    // @ts-ignore
    queries.getInvoice.mockResolvedValue({ status: 'Pending', freelancer: "GCCGXKWWVKMVIM2DMFJUTYTHFXSVXSMS7U3LPGS5KUPYE3TN5GXY364G" });
    await expect(cancelInvoice(mockServer, 'C123', 1n, mockAccount, mockSign, 'pass'))
      .rejects.toThrow(ILNError.Unauthorized);
  });

  it('cancels a Pending invoice successfully', async () => {
    // @ts-ignore
    queries.getInvoice.mockResolvedValue({
      status: 'Pending',
      freelancer: "GAGZSXAR7P7PASD2PGYISBMEZCMSI35TRJXYZTZNNCAUZRDEMHQM2XJS",
    });
    (mockServer.simulateTransaction as vi.Mock).mockResolvedValue({});
    (mockServer.sendTransaction as vi.Mock).mockResolvedValue({ hash: 'canceltxhash' });
    (mockServer.getTransaction as vi.Mock).mockResolvedValue({ status: 'SUCCESS' });
    mockAssembleTransaction.mockReturnValue({ build: () => ({} as never) });

    const result = await cancelInvoice(
      mockServer,
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
      1n,
      mockAccount,
      mockSign,
      'pass'
    );

    expect(result.txHash).toBe('canceltxhash');
    expect(mockSign).toHaveBeenCalled();
    expect(mockServer.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('calls cancel_invoice with only the invoice id (no submitter address)', async () => {
    // Issue #596: the contract derives the submitter on-chain via
    // require_submitter_by_id — the SDK must not pass submitterAddress.
    // @ts-ignore
    queries.getInvoice.mockResolvedValue({
      status: 'Pending',
      freelancer: "GAGZSXAR7P7PASD2PGYISBMEZCMSI35TRJXYZTZNNCAUZRDEMHQM2XJS",
    });
    (mockServer.simulateTransaction as vi.Mock).mockResolvedValue({});
    (mockServer.sendTransaction as vi.Mock).mockResolvedValue({ hash: 'canceltxhash' });
    (mockServer.getTransaction as vi.Mock).mockResolvedValue({ status: 'SUCCESS' });
    mockAssembleTransaction.mockReturnValue({ build: () => ({} as never) });

    const callSpy = vi.spyOn(Contract.prototype, 'call');

    await cancelInvoice(
      mockServer,
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
      1n,
      mockAccount,
      mockSign,
      'pass'
    );

    const calls = callSpy.mock.calls as unknown as [string, ...unknown[]][];
    const cancelCall = calls.find(([method]) => method === 'cancel_invoice');
    expect(cancelCall).toBeDefined();
    // [method, invoice_id] — exactly one user argument, no submitter address
    expect(cancelCall).toHaveLength(2);
    expect(scValToNative(cancelCall![1] as never)).toBe(1n);

    callSpy.mockRestore();
  });
});
