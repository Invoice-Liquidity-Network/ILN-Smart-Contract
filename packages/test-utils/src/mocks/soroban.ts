import { vi } from 'vitest';
import type { SorobanRpc } from '@stellar/stellar-sdk';

export const mockStellarSdk = () => {
  vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
    return {
      ...actual,
      SorobanRpc: {
        ...actual.SorobanRpc,
        Server: vi.fn().mockImplementation(() => ({
          getAccount: vi.fn(),
          simulateTransaction: vi.fn(),
          prepareTransaction: vi.fn(),
          sendTransaction: vi.fn(),
          getLatestLedger: vi.fn(),
        })),
      },
    };
  });
};

export const createMockFreighter = (overrides = {}) => {
  return {
    isConnected: vi.fn().mockResolvedValue(true),
    getPublicKey: vi.fn().mockResolvedValue("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN"),
    getNetwork: vi.fn().mockResolvedValue("TESTNET"),
    signTransaction: vi.fn().mockResolvedValue("AAAASIGNEDXDR=="),
    ...overrides
  };
};

export function makeMockServer(opts: { fail?: boolean } = {}): SorobanRpc.Server {
  return {
    prepareTransaction: vi.fn().mockImplementation(async (tx: any) => {
      if (opts.fail) {
        return { error: "simulation error", _parsed: true };
      }
      return tx;
    }),
  } as unknown as SorobanRpc.Server;
}
