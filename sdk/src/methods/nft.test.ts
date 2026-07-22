import { describe, it, expect, beforeEach, vi } from "vitest";
import { Account, SorobanRpc } from "@stellar/stellar-sdk";
import { getNftMetadata, getNftOwner } from "./nft.js";
import type { InvoiceNftMetadata } from "../utils/xdrDecoder.js";
import { ILNError } from "../errors.js";

describe("NFT Query Methods", () => {
  let server: SorobanRpc.Server;
  let sourceAccount: Account;
  const contractAddress = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const networkPassphrase = "Test SDF Network ; September 2015";
  const invoiceId = 42n;

  beforeEach(() => {
    // Create a mock server
    server = {
      simulateTransaction: vi.fn(),
    } as unknown as SorobanRpc.Server;

    // Create a mock source account
    sourceAccount = new Account(
      "GBRPYHIL2CI3WHZDTOOQFC6EB4RBDAPPLYAT2FOSSYOWLCDTIR35IWJP",
      "0"
    );
  });

  describe("getNftMetadata", () => {
    it("should return NFT metadata when NFT exists", async () => {
      const mockMetadata: InvoiceNftMetadata = {
        invoiceId: 42n,
        amount: 1000000n,
        dueDate: 1704067200,
        discountRate: 300,
        token: "CCJZ375JREG7DSHBG44D7ZLBFOXQFSWBM3L4AZXC3NZYBV3MYQ4GOHB",
        owner: "GBRPYHIL2CI3WHZDTOOQFC6EB4RBDAPPLYAT2FOSSYOWLCDTIR35IWJP",
        mintedAt: 1704067200,
      };

      // Mock successful simulation
      vi.mocked(server.simulateTransaction).mockResolvedValueOnce({
        result: {
          retval: {
            type: "obj",
            fields: [
              { key: { type: "sym", sym: "invoice_id" }, val: { type: "u64", u64: "42" } },
              { key: { type: "sym", sym: "amount" }, val: { type: "i128", i128: "1000000" } },
              { key: { type: "sym", sym: "due_date" }, val: { type: "u32", u32: "1704067200" } },
              { key: { type: "sym", sym: "discount_rate" }, val: { type: "u32", u32: "300" } },
              { key: { type: "sym", sym: "token" }, val: { type: "addr", addr: "CCJZ375JREG7DSHBG44D7ZLBFOXQFSWBM3L4AZXC3NZYBV3MYQ4GOHB" } },
              { key: { type: "sym", sym: "owner" }, val: { type: "addr", addr: "GBRPYHIL2CI3WHZDTOOQFC6EB4RBDAPPLYAT2FOSSYOWLCDTIR35IWJP" } },
              { key: { type: "sym", sym: "minted_at" }, val: { type: "u32", u32: "1704067200" } },
            ],
          },
        },
      } as any);

      const result = await getNftMetadata(
        server,
        contractAddress,
        invoiceId,
        sourceAccount,
        networkPassphrase
      );

      expect(result).not.toBeNull();
      expect(result?.invoiceId).toBe(42n);
      expect(result?.amount).toBe(1000000n);
      expect(result?.discountRate).toBe(300);
      expect(result?.owner).toBe("GBRPYHIL2CI3WHZDTOOQFC6EB4RBDAPPLYAT2FOSSYOWLCDTIR35IWJP");
    });

    it("should return null when NFT does not exist", async () => {
      // Mock simulation returning null for Option::None
      vi.mocked(server.simulateTransaction).mockResolvedValueOnce({
        result: {
          retval: null,
        },
      } as any);

      const result = await getNftMetadata(
        server,
        contractAddress,
        invoiceId,
        sourceAccount,
        networkPassphrase
      );

      expect(result).toBeNull();
    });

    it("should throw ILNError on simulation error", async () => {
      // Mock simulation error
      vi.mocked(server.simulateTransaction).mockResolvedValueOnce({
        error: new Error("Simulation failed"),
      } as any);

      await expect(
        getNftMetadata(server, contractAddress, invoiceId, sourceAccount, networkPassphrase)
      ).rejects.toThrow(ILNError);
    });
  });

  describe("getNftOwner", () => {
    it("should return owner address when NFT exists", async () => {
      const ownerAddress = "GBRPYHIL2CI3WHZDTOOQFC6EB4RBDAPPLYAT2FOSSYOWLCDTIR35IWJP";

      // Mock successful simulation
      vi.mocked(server.simulateTransaction).mockResolvedValueOnce({
        result: {
          retval: {
            type: "addr",
            addr: ownerAddress,
          },
        },
      } as any);

      const result = await getNftOwner(
        server,
        contractAddress,
        invoiceId,
        sourceAccount,
        networkPassphrase
      );

      expect(result).toBe(ownerAddress);
    });

    it("should return null when NFT does not exist", async () => {
      // Mock simulation returning null for Option::None
      vi.mocked(server.simulateTransaction).mockResolvedValueOnce({
        result: {
          retval: null,
        },
      } as any);

      const result = await getNftOwner(
        server,
        contractAddress,
        invoiceId,
        sourceAccount,
        networkPassphrase
      );

      expect(result).toBeNull();
    });

    it("should throw ILNError on simulation error", async () => {
      // Mock simulation error
      vi.mocked(server.simulateTransaction).mockResolvedValueOnce({
        error: new Error("Simulation failed"),
      } as any);

      await expect(
        getNftOwner(server, contractAddress, invoiceId, sourceAccount, networkPassphrase)
      ).rejects.toThrow(ILNError);
    });
  });
});
