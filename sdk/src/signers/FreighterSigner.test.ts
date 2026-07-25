import { vi, describe, it, expect, afterEach } from 'vitest';
/**
 * Tests for FreighterSigner — covers:
 *   - Installation detection (WalletNotInstalled)
 *   - Connection flow (connect, publicKey caching)
 *   - Network mismatch detection
 *   - signTransaction happy path
 *   - User rejection handling
 *   - ILNError classification
 */

import { FreighterSigner, ILNError, ILNErrorCode } from "./FreighterSigner.js";
import { Networks, TransactionBuilder, Account, BASE_FEE, Operation, Asset, Keypair } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Mock Freighter API
// ---------------------------------------------------------------------------

import { createMockFreighter, makeMockServer } from "@iln/test-utils";

type MockFreighter = ReturnType<typeof createMockFreighter>;

function installFreighter(mock: MockFreighter): void {
  (global as unknown).window = { freighterApi: mock };
}

function uninstallFreighter(): void {
  delete (global as unknown).window;
}

function buildTestTx(kp: Keypair = Keypair.random()) {
  const account = new Account(kp.publicKey(), "100");
  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: "1",
      })
    )
    .setTimeout(30)
    .build();
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

afterEach(() => {
  uninstallFreighter();
});

// ---------------------------------------------------------------------------
// WalletNotInstalled
// ---------------------------------------------------------------------------

describe("FreighterSigner — WalletNotInstalled", () => {
  it("throws ILNError.WalletNotInstalled when window.freighterApi is absent", async () => {
    const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
    await expect(signer.connect()).rejects.toThrow(ILNError);
    await expect(signer.connect()).rejects.toMatchObject({
      code: ILNErrorCode.WalletNotInstalled,
    });
  });

  it("returns empty string when not connected", () => {
    const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
    expect(signer.publicKey).toBe("");
  });

  it("returns empty string when window is undefined (server-side)", () => {
    // No window at all
    const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
    expect(signer.publicKey).toBe("");
  });
});

// ---------------------------------------------------------------------------
// connect() — happy path
// ---------------------------------------------------------------------------

describe("FreighterSigner — connect", () => {
  it("returns the public key on successful connection", async () => {
    const mock = createMockFreighter();
    installFreighter(mock);

    const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
    const pk = await signer.connect();

    expect(pk).toBe("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN");
    expect(mock.isConnected).toHaveBeenCalledTimes(1);
    expect(mock.getPublicKey).toHaveBeenCalledTimes(1);
  });

  it("caches the public key and sets isConnected=true", async () => {
    const mock = createMockFreighter();
    installFreighter(mock);

    const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
    await signer.connect();

    expect(signer.isConnected).toBe(true);
    // publicKey getter now works synchronously
    expect(signer.publicKey).toBe("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN");
  });

  it("can be called multiple times without re-prompting", async () => {
    const mock = createMockFreighter();
    installFreighter(mock);

    const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
    await signer.connect();
    const pk2 = await signer.connect();

    expect(pk2).toBe("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN");
    // connect calls getPublicKey again, which is idempotent
  });
});

// ---------------------------------------------------------------------------
// connect() — NotConnected
// ---------------------------------------------------------------------------

describe("FreighterSigner — connect / NotConnected", () => {
  it("throws NotConnected when isConnected returns false", async () => {
    const mock = createMockFreighter({ isConnected: vi.fn().mockResolvedValue(false) });
    installFreighter(mock);

    const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
    await expect(signer.connect()).rejects.toMatchObject({
      code: ILNErrorCode.NotConnected,
    });
  });
});

// ---------------------------------------------------------------------------
// connect() — UserRejected
// ---------------------------------------------------------------------------

describe("FreighterSigner — connect / UserRejected", () => {
  it("throws UserRejected when getPublicKey returns empty string", async () => {
    const mock = createMockFreighter({ getPublicKey: vi.fn().mockResolvedValue("") });
    installFreighter(mock);

    const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
    await expect(signer.connect()).rejects.toMatchObject({
      code: ILNErrorCode.UserRejected,
    });
  });
});

// ---------------------------------------------------------------------------
// connect() — NetworkMismatch
// ---------------------------------------------------------------------------

describe("FreighterSigner — connect / NetworkMismatch", () => {
  it("throws NetworkMismatch when wallet is on mainnet but SDK expects testnet", async () => {
    const mock = createMockFreighter({ getNetwork: vi.fn().mockResolvedValue("PUBLIC") });
    installFreighter(mock);

    const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
    await expect(signer.connect()).rejects.toMatchObject({
      code: ILNErrorCode.NetworkMismatch,
    });
  });

  it("throws NetworkMismatch when wallet is on testnet but SDK expects mainnet", async () => {
    const mock = createMockFreighter({ getNetwork: vi.fn().mockResolvedValue("TESTNET") });
    installFreighter(mock);

    const signer = new FreighterSigner({ networkPassphrase: Networks.PUBLIC });
    await expect(signer.connect()).rejects.toMatchObject({
      code: ILNErrorCode.NetworkMismatch,
    });
  });

  it("skips network check when getNetwork throws (older Freighter versions)", async () => {
    const mock = createMockFreighter({
      getNetwork: vi.fn().mockRejectedValue(new Error("not implemented")),
    });
    installFreighter(mock);

    const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
    const pk = await signer.connect();

    expect(pk).toBeTruthy();
  });

  it("skips network check when getNetwork returns unknown network", async () => {
    const mock = createMockFreighter({ getNetwork: vi.fn().mockResolvedValue("STANDALONE") });
    installFreighter(mock);

    const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
    const pk = await signer.connect();

    expect(pk).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// signTransaction — happy path
// ---------------------------------------------------------------------------

describe("FreighterSigner — signTransaction", () => {
  it("simulates, signs with Freighter, and returns signed XDR", async () => {
    const mock = createMockFreighter();
    installFreighter(mock);

    const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
    await signer.connect();

    const server = makeMockServer();
    const tx = buildTestTx();
    const result = await signer.signTransaction(tx, server);

    expect(result).toBe("AAAASIGNEDXDR==");
    expect(server.prepareTransaction).toHaveBeenCalledWith(tx);
    expect(mock.signTransaction).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ network: "TESTNET" })
    );
  });

  it("auto-connects if connect() wasn't called explicitly", async () => {
    const mock = createMockFreighter();
    installFreighter(mock);

    const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
    const server = makeMockServer();
    const tx = buildTestTx();
    const result = await signer.signTransaction(tx, server);

    expect(result).toBe("AAAASIGNEDXDR==");
    expect(signer.isConnected).toBe(true);
  });

  it("does not re-connect if already connected", async () => {
    const mock = createMockFreighter();
    installFreighter(mock);

    const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
    await signer.connect();
    vi.clearAllMocks();

    const server = makeMockServer();
    const tx = buildTestTx();
    await signer.signTransaction(tx, server);

    // getPublicKey should not be called again
    expect(mock.getPublicKey).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// signTransaction — error paths
// ---------------------------------------------------------------------------

describe("FreighterSigner — signTransaction errors", () => {
  it("throws when Soroban simulation fails", async () => {
    const mock = createMockFreighter();
    installFreighter(mock);

    const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
    await signer.connect();

    const server = makeMockServer({ fail: true });
    const tx = buildTestTx();

    await expect(signer.signTransaction(tx, server)).rejects.toThrow(
      "Soroban simulation failed"
    );
  });

  it("throws UserRejected when Freighter rejects the signing", async () => {
    const mock = createMockFreighter({
      signTransaction: vi.fn().mockRejectedValue("User rejected the request"),
    });
    installFreighter(mock);

    const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
    await signer.connect();

    const server = makeMockServer();
    const tx = buildTestTx();

    await expect(signer.signTransaction(tx, server)).rejects.toMatchObject({
      code: ILNErrorCode.UserRejected,
    });
  });

  it("throws UserRejected when Freighter returns 'denied'", async () => {
    const mock = createMockFreighter({
      signTransaction: vi.fn().mockRejectedValue("Access denied by user"),
    });
    installFreighter(mock);

    const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
    await signer.connect();

    const server = makeMockServer();
    const tx = buildTestTx();

    await expect(signer.signTransaction(tx, server)).rejects.toMatchObject({
      code: ILNErrorCode.UserRejected,
    });
  });

  it("throws UserRejected when Freighter returns empty signed XDR", async () => {
    const mock = createMockFreighter({
      signTransaction: vi.fn().mockResolvedValue(""),
    });
    installFreighter(mock);

    const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
    await signer.connect();

    const server = makeMockServer();
    const tx = buildTestTx();

    await expect(signer.signTransaction(tx, server)).rejects.toMatchObject({
      code: ILNErrorCode.UserRejected,
    });
  });

  it("throws NetworkMismatch when Freighter signals network mismatch", async () => {
    const mock = createMockFreighter({
      signTransaction: vi
        .fn()
        .mockRejectedValue("Network mismatch. Please switch to TESTNET."),
    });
    installFreighter(mock);

    const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
    await signer.connect();

    const server = makeMockServer();
    const tx = buildTestTx();

    await expect(signer.signTransaction(tx, server)).rejects.toMatchObject({
      code: ILNErrorCode.NetworkMismatch,
    });
  });

  it("throws SigningFailed for unknown Freighter errors", async () => {
    const mock = createMockFreighter({
      signTransaction: vi
        .fn()
        .mockRejectedValue(new Error("Something unexpected happened")),
    });
    installFreighter(mock);

    const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
    await signer.connect();

    const server = makeMockServer();
    const tx = buildTestTx();

    await expect(signer.signTransaction(tx, server)).rejects.toMatchObject({
      code: ILNErrorCode.SigningFailed,
    });
  });
});

// ---------------------------------------------------------------------------
// Network passphrase mapping
// ---------------------------------------------------------------------------

describe("FreighterSigner — network mapping", () => {
  it("maps TESTNET passphrase to Freighter TESTNET", async () => {
    const mock = createMockFreighter();
    installFreighter(mock);

    const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
    await signer.connect();

    const server = makeMockServer();
    const tx = buildTestTx();
    await signer.signTransaction(tx, server);

    expect(mock.signTransaction).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ network: "TESTNET" })
    );
  });

  it("maps PUBLIC passphrase to Freighter PUBLIC", async () => {
    const mock = createMockFreighter({ getNetwork: vi.fn().mockResolvedValue("PUBLIC") });
    installFreighter(mock);

    const signer = new FreighterSigner({ networkPassphrase: Networks.PUBLIC });
    await signer.connect();

    const server = makeMockServer();
    const tx = buildTestTx(Keypair.random());
    await signer.signTransaction(tx, server);

    expect(mock.signTransaction).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ network: "PUBLIC" })
    );
  });

  it("exposes networkPassphrase as a public property", () => {
    const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
    expect(signer.networkPassphrase).toBe(Networks.TESTNET);
  });
});

// ---------------------------------------------------------------------------
// ILNError factory methods
// ---------------------------------------------------------------------------

describe("ILNError factory methods", () => {
  it("WalletNotInstalled has the correct code and message", () => {
    const err = ILNError.WalletNotInstalled();
    expect(err.code).toBe(ILNErrorCode.WalletNotInstalled);
    expect(err.message).toContain("Freighter");
  });

  it("UserRejected has the correct code and message", () => {
    const err = ILNError.UserRejected();
    expect(err.code).toBe(ILNErrorCode.UserRejected);
    expect(err.message).toContain("rejected");
  });

  it("NetworkMismatch has the correct code and message", () => {
    const err = ILNError.NetworkMismatch("test", "public");
    expect(err.code).toBe(ILNErrorCode.NetworkMismatch);
    expect(err.message).toContain("test");
    expect(err.message).toContain("public");
  });

  it("NotConnected has the correct code and message", () => {
    const err = ILNError.NotConnected();
    expect(err.code).toBe(ILNErrorCode.NotConnected);
    expect(err.message).toContain("locked");
  });

  it("ILNError is an instance of Error", () => {
    const err = ILNError.WalletNotInstalled();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ILNError);
    expect(err.name).toBe("ILNError");
  });
});

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe("FreighterSigner — constructor", () => {
  it("stores the network passphrase without touching the wallet", () => {
    const signer = new FreighterSigner({ networkPassphrase: Networks.TESTNET });
    expect(signer.networkPassphrase).toBe(Networks.TESTNET);
    expect(signer.isConnected).toBe(false);
  });
});
