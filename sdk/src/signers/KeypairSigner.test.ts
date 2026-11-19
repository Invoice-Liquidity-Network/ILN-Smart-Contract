import { vi, describe, it, expect} from 'vitest';
import { KeypairSigner } from "./KeypairSigner.js";
import { Keypair, SorobanRpc, Networks, TransactionBuilder, Account, BASE_FEE, Operation, Asset } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Well-known test secret — triggers the "example key" warning path
const EXAMPLE_SECRET = "SBQM45DNQRUNKDBPTXCAT7CRQLJHOD2NVEP2EKUND7HM7GFCBFTAY2EZ";

// A random test keypair (generated once — deterministic in tests)
const TEST_KP = Keypair.random();
const TEST_SECRET = TEST_KP.secret();

/** Build a minimal valid Stellar transaction for testing. */
function buildTestTx(sourceKp: Keypair = TEST_KP) {
  const account = new Account(sourceKp.publicKey(), "100");
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

import { makeMockServer } from "@iln/test-utils";


// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe("KeypairSigner — constructor", () => {
  it("accepts a Keypair instance", () => {
    const signer = new KeypairSigner(TEST_KP);
    expect(signer.publicKey).toBe(TEST_KP.publicKey());
  });

  it("accepts a secret key string", () => {
    const signer = new KeypairSigner(TEST_SECRET);
    expect(signer.publicKey).toBe(TEST_KP.publicKey());
  });

  it("exposes the underlying keypair", () => {
    const signer = new KeypairSigner(TEST_KP);
    expect(signer.keypair).toBe(TEST_KP);
  });

  it("emits a console.warn for a well-known example key outside test env", () => {
    const originalEnv = process.env["NODE_ENV"];
    const originalVitest = process.env["VITEST"];
    process.env["NODE_ENV"] = "production";
    delete process.env["VITEST"];

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new KeypairSigner(EXAMPLE_SECRET);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("well-known example")
    );

    warn.mockRestore();
    process.env["NODE_ENV"] = originalEnv;
    if (originalVitest !== undefined) process.env["VITEST"] = originalVitest;
  });

  it("emits a generic console.warn for a non-example secret outside test env", () => {
    const originalEnv = process.env["NODE_ENV"];
    const originalVitest = process.env["VITEST"];
    delete process.env["NODE_ENV"];
    delete process.env["JEST_WORKER_ID"];
    delete process.env["VITEST"];

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new KeypairSigner(TEST_SECRET);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("plain string is risky")
    );

    warn.mockRestore();
    process.env["NODE_ENV"] = originalEnv ?? "test";
    if (originalVitest !== undefined) process.env["VITEST"] = originalVitest;
  });

  it("does NOT warn when NODE_ENV=test", () => {
    const originalEnv = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "test";

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new KeypairSigner(TEST_SECRET);
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
    process.env["NODE_ENV"] = originalEnv;
  });

  it("does NOT warn when JEST_WORKER_ID is set", () => {
    const originalJest = process.env["JEST_WORKER_ID"];
    const originalEnv = process.env["NODE_ENV"];
    process.env["JEST_WORKER_ID"] = "1";
    delete process.env["NODE_ENV"];

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new KeypairSigner(TEST_SECRET);
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
    process.env["NODE_ENV"] = originalEnv ?? "test";
    if (originalJest !== undefined) process.env["JEST_WORKER_ID"] = originalJest;
    else delete process.env["JEST_WORKER_ID"];
  });

  it("does NOT warn when a Keypair instance is passed (not a string)", () => {
    const originalEnv = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new KeypairSigner(TEST_KP); // Keypair object, not string
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
    process.env["NODE_ENV"] = originalEnv;
  });
});

// ---------------------------------------------------------------------------
// fromEnv
// ---------------------------------------------------------------------------

describe("KeypairSigner.fromEnv", () => {
  it("creates a signer from an env variable", () => {
    process.env["TEST_LP_SECRET"] = TEST_SECRET;
    const signer = KeypairSigner.fromEnv("TEST_LP_SECRET");
    expect(signer.publicKey).toBe(TEST_KP.publicKey());
    delete process.env["TEST_LP_SECRET"];
  });

  it("throws when the env variable is not set", () => {
    delete process.env["MISSING_SECRET"];
    expect(() => KeypairSigner.fromEnv("MISSING_SECRET")).toThrow(
      'environment variable "MISSING_SECRET" is not set'
    );
  });

  it("does NOT emit a warning (env path is recommended)", () => {
    process.env["TEST_LP_SECRET2"] = TEST_SECRET;
    const originalEnv = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    KeypairSigner.fromEnv("TEST_LP_SECRET2");
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
    process.env["NODE_ENV"] = originalEnv;
    delete process.env["TEST_LP_SECRET2"];
  });
});

// ---------------------------------------------------------------------------
// signTransaction — happy path
// ---------------------------------------------------------------------------

describe("KeypairSigner.signTransaction — success", () => {
  it("calls server.prepareTransaction with the supplied tx", async () => {
    const signer = new KeypairSigner(TEST_KP);
    const server = makeMockServer();
    const tx = buildTestTx();

    await signer.signTransaction(tx, server);

    expect(server.prepareTransaction).toHaveBeenCalledWith(tx);
  });

  it("returns a non-empty base-64 XDR string", async () => {
    const signer = new KeypairSigner(TEST_KP);
    const server = makeMockServer();
    const tx = buildTestTx();

    const result = await signer.signTransaction(tx, server);

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("signs the prepared transaction (tx.signatures is non-empty)", async () => {
    const signer = new KeypairSigner(TEST_KP);
    const server = makeMockServer();
    const tx = buildTestTx();

    const signedXdr = await signer.signTransaction(tx, server);

    // Decode and verify the signature is present
    const { Transaction } = await import("@stellar/stellar-sdk");
    const signed = new Transaction(signedXdr, Networks.TESTNET);
    expect(signed.signatures.length).toBeGreaterThan(0);
  });

  it("works when constructed from a secret string", async () => {
    const signer = new KeypairSigner(TEST_SECRET);
    const server = makeMockServer();
    const tx = buildTestTx();

    const result = await signer.signTransaction(tx, server);
    expect(typeof result).toBe("string");
  });

  it("works when using KeypairSigner.fromEnv", async () => {
    process.env["SIGN_TEST_SECRET"] = TEST_SECRET;
    const signer = KeypairSigner.fromEnv("SIGN_TEST_SECRET");
    const server = makeMockServer();
    const tx = buildTestTx();

    const result = await signer.signTransaction(tx, server);
    expect(typeof result).toBe("string");
    delete process.env["SIGN_TEST_SECRET"];
  });
});

// ---------------------------------------------------------------------------
// signTransaction — simulation failure
// ---------------------------------------------------------------------------

describe("KeypairSigner.signTransaction — simulation failure", () => {
  it("throws when prepareTransaction returns a simulation error object", async () => {
    const signer = new KeypairSigner(TEST_KP);
    const server = makeMockServer({ fail: true });
    const tx = buildTestTx();

    await expect(signer.signTransaction(tx, server)).rejects.toThrow(
      "Soroban simulation failed"
    );
  });

  it("propagates errors thrown by prepareTransaction", async () => {
    const signer = new KeypairSigner(TEST_KP);
    const server = {
      prepareTransaction: vi.fn().mockRejectedValue(new Error("RPC timeout")),
    } as unknown as SorobanRpc.Server;

    await expect(
      signer.signTransaction(buildTestTx(), server)
    ).rejects.toThrow("RPC timeout");
  });
});

// ---------------------------------------------------------------------------
// Signature correctness
// ---------------------------------------------------------------------------

describe("KeypairSigner — signature correctness", () => {
  it("the signed XDR can be decoded back to the same source account", async () => {
    const signer = new KeypairSigner(TEST_KP);
    const server = makeMockServer();
    const tx = buildTestTx();

    const signedXdr = await signer.signTransaction(tx, server);

    const { Transaction } = await import("@stellar/stellar-sdk");
    const decoded = new Transaction(signedXdr, Networks.TESTNET);
    expect(decoded.source).toBe(TEST_KP.publicKey());
  });

  it("different keypairs produce different signatures for the same tx", async () => {
    const kp1 = Keypair.random();
    const kp2 = Keypair.random();
    const server = makeMockServer();

    const xdr1 = await new KeypairSigner(kp1).signTransaction(
      buildTestTx(kp1),
      server
    );
    const xdr2 = await new KeypairSigner(kp2).signTransaction(
      buildTestTx(kp2),
      server
    );

    expect(xdr1).not.toBe(xdr2);
  });
});
