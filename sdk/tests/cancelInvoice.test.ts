import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cancelInvoice } from '../src/methods/cancelInvoice.js';
import { ILNError } from '../src/errors.js';
import { Account, SorobanRpc } from '@stellar/stellar-sdk';
import * as queries from '../src/methods/queries.js';

vi.mock('../src/methods/queries.js');

describe('cancelInvoice', () => {
  const mockServer = { simulateTransaction: vi.fn() } as unknown as SorobanRpc.Server;
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
});
