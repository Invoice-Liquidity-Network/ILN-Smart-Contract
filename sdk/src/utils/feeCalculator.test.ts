import { vi, describe, it, expect, beforeEach } from "vitest";
import {
  estimateFee,
  estimateSubmitFee,
  estimateFundFee,
} from "./feeCalculator.js";
import { SorobanRpc, Networks, Account, Contract } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_ACCOUNT = new Account(
  "GAZ3LFZW7WS7HFL2TCKU3GHZ47NOGOCOY6KEXQPWEBHQOYH3PE75TMD2",
  "0"
);

const CONTRACT_ID = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
const TOKEN_ID   = "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ";
const LP_ADDRESS = "GAT4FOB6AUF6E6GOEKCUAJPX3G3QOCMXQYCBNVZQJSA3M7H3A2A7QECC";
const PAYER_ADDR = "GAUQ7B6KWZEHWEQS33QMSJRSF5C7A7DMESUGPFQNPMPHKKJQNLLSKHKN";

const mockServer = {
  simulateTransaction: vi.fn(),
} as unknown as SorobanRpc.Server;

function makeSim(minResourceFee: string) {
  return { minResourceFee, result: { retval: {} } };
}

function makeErrorSim(error: string) {
  return { error, _parsed: true };
}

const contract = new Contract(CONTRACT_ID);
const SAMPLE_OP = contract.call("submit_invoice");

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// estimateFee — core behaviour
// ---------------------------------------------------------------------------

describe("estimateFee", () => {
  it("returns feeStroops and feeXLM for a successful simulation", async () => {
    (mockServer.simulateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSim("1000000")
    );

    const result = await estimateFee(
      SAMPLE_OP,
      mockServer,
      MOCK_ACCOUNT,
      Networks.TESTNET
    );

    // 1.2× buffer: 1_000_000 * 1.2 = 1_200_000 stroops
    expect(result.feeStroops).toBe(1_200_000n);
    // 1_200_000 / 10_000_000 = 0.12 XLM
    expect(result.feeXLM).toBe("0.1200000");
  });

  it("applies a custom feeBuffer", async () => {
    (mockServer.simulateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSim("500000")
    );

    const result = await estimateFee(
      SAMPLE_OP,
      mockServer,
      MOCK_ACCOUNT,
      Networks.TESTNET,
      { feeBuffer: 1.5 }
    );

    expect(result.feeStroops).toBe(750_000n);
    expect(result.feeXLM).toBe("0.0750000");
  });

  it("ceil-rounds fractional stroops", async () => {
    (mockServer.simulateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSim("1")
    );

    // 1 * 1.2 = 1.2 → ceiled to 2
    const result = await estimateFee(
      SAMPLE_OP,
      mockServer,
      MOCK_ACCOUNT,
      Networks.TESTNET
    );

    expect(result.feeStroops).toBe(2n);
  });

  it("returns zero fee when minResourceFee is absent", async () => {
    (mockServer.simulateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({
      result: { retval: {} },
    });

    const result = await estimateFee(
      SAMPLE_OP,
      mockServer,
      MOCK_ACCOUNT,
      Networks.TESTNET
    );

    expect(result.feeStroops).toBe(0n);
    expect(result.feeXLM).toBe("0.0000000");
  });

  it("throws when the simulation returns an error", async () => {
    (mockServer.simulateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeErrorSim("contract trap: out of gas")
    );

    await expect(
      estimateFee(SAMPLE_OP, mockServer, MOCK_ACCOUNT, Networks.TESTNET)
    ).rejects.toThrow("Fee simulation failed: contract trap: out of gas");
  });

  it("propagates network errors from simulateTransaction", async () => {
    (mockServer.simulateTransaction as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Network unreachable")
    );

    await expect(
      estimateFee(SAMPLE_OP, mockServer, MOCK_ACCOUNT, Networks.TESTNET)
    ).rejects.toThrow("Network unreachable");
  });

  it("calls simulateTransaction exactly once", async () => {
    (mockServer.simulateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSim("100000")
    );

    await estimateFee(SAMPLE_OP, mockServer, MOCK_ACCOUNT, Networks.TESTNET);

    expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("defaults to TESTNET passphrase when omitted", async () => {
    (mockServer.simulateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSim("200000")
    );

    await expect(
      estimateFee(SAMPLE_OP, mockServer, MOCK_ACCOUNT)
    ).resolves.toBeDefined();
  });

  it("formats feeXLM to exactly 7 decimal places", async () => {
    (mockServer.simulateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSim("10000000")
    );

    const result = await estimateFee(
      SAMPLE_OP,
      mockServer,
      MOCK_ACCOUNT,
      Networks.TESTNET
    );

    expect(result.feeXLM).toMatch(/^\d+\.\d{7}$/);
  });
});

// ---------------------------------------------------------------------------
// estimateSubmitFee
// ---------------------------------------------------------------------------

describe("estimateSubmitFee", () => {
  const BASE_PARAMS = {
    payer: PAYER_ADDR,
    amount: 1_000_000n,
    token: TOKEN_ID,
    discountRate: 300,
    dueDate: Math.floor(Date.now() / 1000) + 86400 * 30,
  };

  it("returns a fee estimate for submit_invoice", async () => {
    (mockServer.simulateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSim("800000")
    );

    const result = await estimateSubmitFee(
      BASE_PARAMS,
      mockServer,
      CONTRACT_ID,
      MOCK_ACCOUNT,
      Networks.TESTNET
    );

    // 800_000 * 1.2 = 960_000 stroops
    expect(result.feeStroops).toBe(960_000n);
    expect(typeof result.feeXLM).toBe("string");
  });

  it("accepts an optional referralCode without error", async () => {
    (mockServer.simulateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSim("500000")
    );

    await expect(
      estimateSubmitFee(
        { ...BASE_PARAMS, referralCode: "REF123" },
        mockServer,
        CONTRACT_ID,
        MOCK_ACCOUNT,
        Networks.TESTNET
      )
    ).resolves.toBeDefined();
  });

  it("applies a custom feeBuffer", async () => {
    (mockServer.simulateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSim("1000000")
    );

    const result = await estimateSubmitFee(
      BASE_PARAMS,
      mockServer,
      CONTRACT_ID,
      MOCK_ACCOUNT,
      Networks.TESTNET,
      { feeBuffer: 2.0 }
    );

    expect(result.feeStroops).toBe(2_000_000n);
  });

  it("throws on simulation error", async () => {
    (mockServer.simulateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeErrorSim("invalid payer")
    );

    await expect(
      estimateSubmitFee(BASE_PARAMS, mockServer, CONTRACT_ID, MOCK_ACCOUNT)
    ).rejects.toThrow("Fee simulation failed");
  });
});

// ---------------------------------------------------------------------------
// estimateFundFee
// ---------------------------------------------------------------------------

describe("estimateFundFee", () => {
  it("returns a fee estimate for fund_invoice", async () => {
    (mockServer.simulateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSim("600000")
    );

    const result = await estimateFundFee(
      42n,
      LP_ADDRESS,
      1_000_000n,
      mockServer,
      CONTRACT_ID,
      MOCK_ACCOUNT,
      Networks.TESTNET
    );

    // 600_000 * 1.2 = 720_000 stroops
    expect(result.feeStroops).toBe(720_000n);
    expect(result.feeXLM).toBe("0.0720000");
  });

  it("applies a custom feeBuffer", async () => {
    (mockServer.simulateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSim("1000000")
    );

    const result = await estimateFundFee(
      1n,
      LP_ADDRESS,
      500_000n,
      mockServer,
      CONTRACT_ID,
      MOCK_ACCOUNT,
      Networks.TESTNET,
      { feeBuffer: 1.5 }
    );

    expect(result.feeStroops).toBe(1_500_000n);
  });

  it("throws on simulation error", async () => {
    (mockServer.simulateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeErrorSim("invoice not found")
    );

    await expect(
      estimateFundFee(99n, LP_ADDRESS, 1_000_000n, mockServer, CONTRACT_ID, MOCK_ACCOUNT)
    ).rejects.toThrow("Fee simulation failed");
  });

  it("defaults to TESTNET passphrase when omitted", async () => {
    (mockServer.simulateTransaction as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeSim("300000")
    );

    await expect(
      estimateFundFee(1n, LP_ADDRESS, 1_000_000n, mockServer, CONTRACT_ID, MOCK_ACCOUNT)
    ).resolves.toBeDefined();
  });
});
