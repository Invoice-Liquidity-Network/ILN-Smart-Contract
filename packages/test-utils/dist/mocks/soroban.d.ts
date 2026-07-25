import type { SorobanRpc } from '@stellar/stellar-sdk';
export declare const mockStellarSdk: () => void;
export declare const createMockFreighter: (overrides?: {}) => {
    isConnected: import("vitest").Mock<any, any>;
    getPublicKey: import("vitest").Mock<any, any>;
    getNetwork: import("vitest").Mock<any, any>;
    signTransaction: import("vitest").Mock<any, any>;
};
export declare function makeMockServer(opts?: {
    fail?: boolean;
}): SorobanRpc.Server;
