import { describe, it, expect, beforeEach, vi } from "vitest";
import { Account, SorobanRpc, nativeToScVal } from "@stellar/stellar-sdk";
import { getNftMetadata, getNftOwner } from "./nft.js";
import type { InvoiceNftMetadata } from "../utils/xdrDecoder.js";
import { ILNError } from "../errors.js";

describe("NFT Query Methods", () => {
  let server: SorobanRpc.Server;
  let sourceAccount: Account;
  const contractAddress = "CDVZ3ADHUQK5OPJTTZCEAX3OMQWDI2B7VVQCI7EDWV747RMCRRMGAFJO";
  const networkPassphrase = "Test SDF Network ; September 2015";
  const invoiceId = 42n;

  beforeEach(() => {
    // Create a mock server
    server = {
      simulateTransaction: vi.fn(),
    } as unknown as SorobanRpc.Server;

    // Create a mock source account
    sourceAccount = new Account(
      "GBZNA4VFAQNBXG7ZUGYEG3IZB4FYWCYMKI75NPCABRZ27OPB6A7ENNDV",
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
        owner: "GBZNA4VFAQNBXG7ZUGYEG3IZB4FYWCYMKI75NPCABRZ27OPB6A7ENNDV",
        mintedAt: 1704067200,
      };

      // Mock successful simulation
      vi.mocked(server.simulateTransaction).mockResolvedValueOnce({
        result: {
          retval: nativeToScVal(
            {
              invoice_id: 42n,
              amount: 1000000n,
              due_date: 1704067200,
              discount_rate: 300,
              token: "CD2OPBKYWTPLVETA3ZC4FVWONKUMR3PRLOH2AK23KDMPTCXJIM5JNOFE",
              owner: "GBZNA4VFAQNBXG7ZUGYEG3IZB4FYWCYMKI75NPCABRZ27OPB6A7ENNDV",
              minted_at: 1704067200,
            },
            { type: "instance" }
          ),
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
      expect(result?.owner).toBe("GBZNA4VFAQNBXG7ZUGYEG3IZB4FYWCYMKI75NPCABRZ27OPB6A7ENNDV");
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
      const ownerAddress = "GBZNA4VFAQNBXG7ZUGYEG3IZB4FYWCYMKI75NPCABRZ27OPB6A7ENNDV";

      // Mock successful simulation
      vi.mocked(server.simulateTransaction).mockResolvedValueOnce({
        result: {
          retval: nativeToScVal(ownerAddress, { type: "address" }),
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
