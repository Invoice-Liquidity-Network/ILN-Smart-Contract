/**
 * getReferralStats — query referral statistics (referral count) for a given
 * referral code hash from the on-chain ILN contract.
 *
 * Wraps the `get_referral_stats(BytesN<32>) -> u64` view function.
 */

import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Account,
  BASE_FEE,
  scValToNative,
  xdr,
  Networks,
} from "@stellar/stellar-sdk";
import { retry } from "../utils/retry.js";

// ---------------------------------------------------------------------------
// Hex validation
// ---------------------------------------------------------------------------

const HEX64_RE = /^[0-9a-fA-F]{64}$/;

// ---------------------------------------------------------------------------
// getReferralStats
// ---------------------------------------------------------------------------

/**
 * Query the number of referrals attributed to a given referral code.
 *
 * Performs a read-only Soroban simulation — no on-chain mutation, no
 * transaction fees, and no signer required.
 *
 * @param server              - Soroban RPC server for the target network
 * @param contractId          - Deployed invoice-liquidity contract address
 * @param referralCodeHex     - 64-character hex string (32 bytes) representing the referral code hash
 * @param networkPassphrase   - Stellar network passphrase (default: TESTNET)
 * @returns Number of referrals for the given code
 *
 * @throws When `referralCodeHex` is not a valid 64-character hex string
 * @throws When the Soroban simulation fails (RPC unreachable, contract not found)
 *
 * @example
 * ```ts
 * const count = await getReferralStats(server, CONTRACT_ID, "ab12...cd34");
 * console.log(`Referrals: ${count}`);
 * ```
 */
export async function getReferralStats(
  server: SorobanRpc.Server,
  contractId: string,
  referralCodeHex: string,
  networkPassphrase: string = Networks.TESTNET
): Promise<number> {
  // Strip optional 0x prefix
  const cleaned = referralCodeHex.startsWith("0x")
    ? referralCodeHex.slice(2)
    : referralCodeHex;

  if (!HEX64_RE.test(cleaned)) {
    throw new Error(
      `Invalid referral code: "${referralCodeHex}". Expected a 64-character hex string (32 bytes) optionally prefixed with "0x".`
    );
  }

  // Decode hex to raw 32-byte buffer
  const referralCodeBytes = Buffer.from(cleaned, "hex");

  const contract = new Contract(contractId);
  const op = contract.call(
    "get_referral_stats",
    xdr.ScVal.scvBytes(referralCodeBytes)
  );

  const sourceAccount = new Account(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "0"
  );

  const simTx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await retry(() => server.simulateTransaction(simTx));

  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`get_referral_stats simulation failed: ${sim.error}`);
  }

  if (!sim.result?.retval) {
    return 0;
  }

  const raw = scValToNative(sim.result.retval);
  return Number(raw ?? 0n);
}
