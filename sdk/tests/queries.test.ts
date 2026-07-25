import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getInvoice, listInvoicesBySubmitter, listInvoicesByLP } from '../src/methods/queries.js';
import { ILNError } from '../src/errors.js';
import { Account, SorobanRpc } from '@stellar/stellar-sdk';

describe('queries', () => {
  const mockServer = { simulateTransaction: vi.fn() } as unknown as SorobanRpc.Server;
  const mockAccount = new Account("GAGZSXAR7P7PASD2PGYISBMEZCMSI35TRJXYZTZNNCAUZRDEMHQM2XJS", "1");

  it('getInvoice throws InvoiceNotFound', async () => {
    // @ts-ignore
    mockServer.simulateTransaction.mockResolvedValue({ error: 'NotFound' });
    await expect(getInvoice(mockServer, "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4", 1n, mockAccount, 'pass')).rejects.toThrow(ILNError.InvoiceNotFound);
  });
});
