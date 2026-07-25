import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { markPaid } from '../src/methods/markPaid.js';
import { ILNError } from '../src/errors.js';
import { Account, SorobanRpc } from '@stellar/stellar-sdk';
import * as queries from '../src/methods/queries.js';

vi.mock('../src/methods/queries.js');

describe('markPaid', () => {
  const mockServer = { simulateTransaction: vi.fn() } as unknown as SorobanRpc.Server;
  const mockAccount = new Account("GAGZSXAR7P7PASD2PGYISBMEZCMSI35TRJXYZTZNNCAUZRDEMHQM2XJS", "1");
  const mockSign = vi.fn((tx) => tx);

  it('throws if payment exceeds outstanding', async () => {
    // @ts-ignore
    queries.getInvoice.mockResolvedValue({ amount: 100n, amountPaid: 0n });
    await expect(markPaid(mockServer, 'C123', 1n, 200n, mockAccount, mockSign, 'pass')).rejects.toThrow(ILNError.InsufficientAmount);
  });

  it('throws if amount is 0', async () => {
    // @ts-ignore
    queries.getInvoice.mockResolvedValue({ amount: 100n, amountPaid: 0n });
    await expect(markPaid(mockServer, 'C123', 1n, 0n, mockAccount, mockSign, 'pass')).rejects.toThrow(ILNError.InsufficientAmount);
  });
});
