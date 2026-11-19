import { vi, describe, it, expect, beforeEach } from "vitest";
import { resolveDispute, DisputeRuling } from "./resolveDispute.js";
import { ILNClient } from "../client.js";
import { Account } from "@stellar/stellar-sdk";

const ADMIN = "GBR7RT4MZTLKK2JNZPOSWVY74VFDR4HVR24QZNH2WONHPQFJZPKHWOTP";
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const PASS = "Test SDF Network ; September 2015";
const HASH32 = "ab".repeat(32);

function makeClient(withSigner: boolean) {
  const client = ILNClient.custom({
    rpcUrl: "https://fake-rpc.example.org",
    networkPassphrase: PASS,
    contractId: CONTRACT,
    ...(withSigner ? { signer: makeSigner() } : {}),
  });

  Object.assign(client, {
    rpc: {
      getAccount: vi.fn().mockResolvedValue(new Account(ADMIN, "1")),
      prepareTransaction: vi.fn().mockImplementation((tx) => tx),
      sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING", hash: "txRESOLVE" }),
    },
  });

  return client;
}

function makeSigner() {
  return {
    publicKey: ADMIN,
    signTransaction: vi.fn().mockResolvedValue("signed-xdr"),
  };
}

describe("resolveDispute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("submits an Upheld ruling and returns txHash", async () => {
    const client = makeClient(true);
    const res = await resolveDispute(client, 42n, HASH32, DisputeRuling.Upheld);
    expect(res.txHash).toBe("txRESOLVE");
    expect(client.signer!.signTransaction).toHaveBeenCalled();
  });

  it("submits a Rejected ruling and returns txHash", async () => {
    const client = makeClient(true);
    const res = await resolveDispute(client, 42n, HASH32, DisputeRuling.Rejected);
    expect(res.txHash).toBe("txRESOLVE");
  });

  it("throws when the client has no signer configured", async () => {
    const client = makeClient(false);
    await expect(
      resolveDispute(client, 42n, HASH32, DisputeRuling.Upheld)
    ).rejects.toThrow("resolveDispute requires a client configured with a signer");
  });
});
