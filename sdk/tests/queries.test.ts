import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getInvoice, listInvoicesBySubmitter, listInvoicesByLP, getSubmitterInvoices, getPayerScore } from '../src/methods/queries.js';
import { ILNError } from '../src/errors.js';
import { Account, SorobanRpc, scValToNative } from '@stellar/stellar-sdk';

// Mock scValToNative so getPayerScore tests can control the decoded result
vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  return {
    ...actual,
    scValToNative: vi.fn().mockImplementation(actual.scValToNative),
  };
});

const mockScValToNative = scValToNative as unknown as ReturnType<typeof vi.fn>;

describe('queries', () => {
  const mockServer = { simulateTransaction: vi.fn() } as unknown as SorobanRpc.Server;
  const mockAccount = new Account("GAGZSXAR7P7PASD2PGYISBMEZCMSI35TRJXYZTZNNCAUZRDEMHQM2XJS", "1");

  beforeEach(() => {
    mockScValToNative.mockClear();
  });

  it('getInvoice throws InvoiceNotFound', async () => {
    // @ts-ignore
    mockServer.simulateTransaction.mockResolvedValue({ error: 'NotFound' });
    await expect(getInvoice(mockServer, "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4", 1n, mockAccount, 'pass')).rejects.toThrow(ILNError.InvoiceNotFound);
  });

  it('getSubmitterInvoices returns empty array when retval is null', async () => {
    // @ts-ignore
    mockServer.simulateTransaction.mockResolvedValue({ result: { retval: null } });
    const result = await getSubmitterInvoices(mockServer, "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4", "GAGZSXAR7P7PASD2PGYISBMEZCMSI35TRJXYZTZNNCAUZRDEMHQM2XJS", mockAccount, 'pass', 0, 10);
    expect(result).toEqual([]);
  });

  it('getSubmitterInvoices throws error on simulation error', async () => {
    // @ts-ignore
    mockServer.simulateTransaction.mockResolvedValue({ error: 'ContractError' });
    await expect(getSubmitterInvoices(mockServer, "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4", "GAGZSXAR7P7PASD2PGYISBMEZCMSI35TRJXYZTZNNCAUZRDEMHQM2XJS", mockAccount, 'pass', 0, 10)).rejects.toThrow();
  });

  it('getSubmitterInvoices uses default pagination values', async () => {
    // @ts-ignore
    mockServer.simulateTransaction.mockResolvedValue({ result: { retval: null } });
    const result = await getSubmitterInvoices(mockServer, "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4", "GAGZSXAR7P7PASD2PGYISBMEZCMSI35TRJXYZTZNNCAUZRDEMHQM2XJS", mockAccount, 'pass');
    expect(result).toEqual([]);
  });

  it('getPayerScore throws InvalidAddress for a malformed payer address', async () => {
    await expect(
      getPayerScore(mockServer, "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4", "not-an-address", mockAccount, 'pass')
    ).rejects.toThrow(ILNError.InvalidAddress);
  });

  it('getPayerScore throws on simulation error', async () => {
    // @ts-ignore
    mockServer.simulateTransaction.mockResolvedValue({ error: 'ContractError' });
    await expect(
      getPayerScore(mockServer, "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4", "GAGZSXAR7P7PASD2PGYISBMEZCMSI35TRJXYZTZNNCAUZRDEMHQM2XJS", mockAccount, 'pass')
    ).rejects.toThrow();
  });

  it('getPayerScore returns 0 when retval is empty', async () => {
    // @ts-ignore
    mockServer.simulateTransaction.mockResolvedValue({ result: { retval: null } });
    const result = await getPayerScore(mockServer, "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4", "GAGZSXAR7P7PASD2PGYISBMEZCMSI35TRJXYZTZNNCAUZRDEMHQM2XJS", mockAccount, 'pass');
    expect(result).toBe(0);
  });

  it('getPayerScore returns the decoded score on success', async () => {
    mockScValToNative.mockReturnValue(72);
    // @ts-ignore
    mockServer.simulateTransaction.mockResolvedValue({ result: { retval: {} } });
    const result = await getPayerScore(mockServer, "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4", "GAGZSXAR7P7PASD2PGYISBMEZCMSI35TRJXYZTZNNCAUZRDEMHQM2XJS", mockAccount, 'pass');
    expect(result).toBe(72);
  });
});
