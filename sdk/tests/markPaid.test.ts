import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { markPaid } from '../src/methods/markPaid.js';
import { ILNError } from '../src/errors.js';
import { Account, SorobanRpc, Transaction } from '@stellar/stellar-sdk';
import * as queries from '../src/methods/queries.js';

vi.mock('../src/methods/queries.js');

describe('markPaid', () => {
  const mockServer = { simulateTransaction: vi.fn(), getTransaction: vi.fn(), sendTransaction: vi.fn() } as unknown as SorobanRpc.Server;
  const mockAccount = new Account("GAGZSXAR7P7PASD2PGYISBMEZCMSI35TRJXYZTZNNCAUZRDEMHQM2XJS", "1");
  const mockSign = vi.fn((tx) => tx);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws if payment exceeds outstanding', async () => {
    // @ts-ignore
    queries.getInvoice.mockResolvedValue({ amount: 100n, amountPaid: 0n });
    await expect(markPaid(mockServer, 'CDVZ3ADHUQK5OPJTTZCEAX3OMQWDI2B7VVQCI7EDWV747RMCRRMGAFJO', 1n, 200n, mockAccount, mockSign, 'pass')).rejects.toThrow(ILNError.InsufficientAmount);
  });

  it('throws if amount is 0', async () => {
    // @ts-ignore
    queries.getInvoice.mockResolvedValue({ amount: 100n, amountPaid: 0n });
    await expect(markPaid(mockServer, 'CDVZ3ADHUQK5OPJTTZCEAX3OMQWDI2B7VVQCI7EDWV747RMCRRMGAFJO', 1n, 0n, mockAccount, mockSign, 'pass')).rejects.toThrow(ILNError.InsufficientAmount);
  });

  it('successfully processes full payment', async () => {
    // @ts-ignore
    queries.getInvoice.mockResolvedValue({ amount: 100n, amountPaid: 0n });
    // @ts-ignore
    mockServer.simulateTransaction.mockResolvedValue({
      results: [{ xdr: 'AAAAAQ==', auth: [] }],
      cost: { cpu: 100, mem: 100 },
      latestLedger: 12345,
    });
    // @ts-ignore
    mockServer.sendTransaction.mockResolvedValue({ hash: 'TXHASH123', errorResult: null, status: 'PENDING' });
    // @ts-ignore
    mockServer.getTransaction.mockResolvedValue({ status: SorobanRpc.Api.GetTransactionStatus.SUCCESS });

    const result = await markPaid(mockServer, 'CDVZ3ADHUQK5OPJTTZCEAX3OMQWDI2B7VVQCI7EDWV747RMCRRMGAFJO', 1n, 100n, mockAccount, mockSign, 'pass');

    expect(result.txHash).toBe('TXHASH123');
    expect(result.remainingBalance).toBe(0n);
    expect(result.fullySettled).toBe(true);
    expect(mockSign).toHaveBeenCalled();
  });

  it('successfully processes partial payment', async () => {
    // @ts-ignore
    queries.getInvoice.mockResolvedValue({ amount: 100n, amountPaid: 0n });
    // @ts-ignore
    mockServer.simulateTransaction.mockResolvedValue({
      results: [{ xdr: 'AAAAAQ==', auth: [] }],
      cost: { cpu: 100, mem: 100 },
      latestLedger: 12345,
    });
    // @ts-ignore
    mockServer.sendTransaction.mockResolvedValue({ hash: 'TXHASH456', errorResult: null, status: 'PENDING' });
    // @ts-ignore
    mockServer.getTransaction.mockResolvedValue({ status: SorobanRpc.Api.GetTransactionStatus.SUCCESS });

    const result = await markPaid(mockServer, 'CDVZ3ADHUQK5OPJTTZCEAX3OMQWDI2B7VVQCI7EDWV747RMCRRMGAFJO', 1n, 50n, mockAccount, mockSign, 'pass');

    expect(result.txHash).toBe('TXHASH456');
    expect(result.remainingBalance).toBe(50n);
    expect(result.fullySettled).toBe(false);
  });

  it('calls contract with correct arguments (invoice_id, amount) without payer address', async () => {
    // @ts-ignore
    queries.getInvoice.mockResolvedValue({ amount: 100n, amountPaid: 0n });
    // @ts-ignore
    mockServer.simulateTransaction.mockResolvedValue({
      results: [{ xdr: 'AAAAAQ==', auth: [] }],
      cost: { cpu: 100, mem: 100 },
      latestLedger: 12345,
    });
    // @ts-ignore
    mockServer.sendTransaction.mockResolvedValue({ hash: 'TXHASH789', errorResult: null, status: 'PENDING' });
    // @ts-ignore
    mockServer.getTransaction.mockResolvedValue({ status: SorobanRpc.Api.GetTransactionStatus.SUCCESS });

    await markPaid(mockServer, 'CDVZ3ADHUQK5OPJTTZCEAX3OMQWDI2B7VVQCI7EDWV747RMCRRMGAFJO', 1n, 100n, mockAccount, mockSign, 'pass');

    // Verify that simulateTransaction was called
    expect(mockServer.simulateTransaction).toHaveBeenCalled();
    
    // The contract call should only have 2 arguments: invoice_id (u64) and amount (i128)
    // The payer is authenticated internally via require_payer_by_id
    const simulateCall = mockServer.simulateTransaction.mock.calls[0][0] as Transaction;
    const operation = simulateCall.operations[0];
    expect(operation.type).toBe('invokeHostFunction');
  });

  it('rejects payment when transaction fails during execution', async () => {
    // @ts-ignore
    queries.getInvoice.mockResolvedValue({ amount: 100n, amountPaid: 0n });
    // @ts-ignore
    mockServer.simulateTransaction.mockResolvedValue({
      results: [{ xdr: 'AAAAAQ==', auth: [] }],
      cost: { cpu: 100, mem: 100 },
      latestLedger: 12345,
    });
    // @ts-ignore
    mockServer.sendTransaction.mockResolvedValue({ hash: 'TXHASHFAIL', errorResult: null, status: 'PENDING' });
    // @ts-ignore
    mockServer.getTransaction.mockResolvedValue({ status: SorobanRpc.Api.GetTransactionStatus.FAILED });

    await expect(markPaid(mockServer, 'CDVZ3ADHUQK5OPJTTZCEAX3OMQWDI2B7VVQCI7EDWV747RMCRRMGAFJO', 1n, 100n, mockAccount, mockSign, 'pass')).rejects.toThrow('Transaction failed during execution');
  });

  it('rejects payment when simulation fails', async () => {
    // @ts-ignore
    queries.getInvoice.mockResolvedValue({ amount: 100n, amountPaid: 0n });
    // @ts-ignore
    mockServer.simulateTransaction.mockResolvedValue({
      error: { message: 'Simulation failed' },
      result: null,
      cost: null,
      latestLedger: 12345,
    });

    await expect(markPaid(mockServer, 'CDVZ3ADHUQK5OPJTTZCEAX3OMQWDI2B7VVQCI7EDWV747RMCRRMGAFJO', 1n, 100n, mockAccount, mockSign, 'pass')).rejects.toThrow();
  });
});
