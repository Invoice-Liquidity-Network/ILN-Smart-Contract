/**
 * Distribution queries — read stats from the distribution reward contract.
 */

import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Account,
  BASE_FEE,
  scValToNative,
  nativeToScVal,
  Address,
  Networks,
  Transaction,
} from "@stellar/stellar-sdk";
import { retry } from "../utils/retry.js";
import { validateGAddress, validateContractId } from "../utils/validate.js";

/**
 * Build, simulate, sign, and submit a write operation against the
 * distribution contract. iln_distribution doesn't use a typed
 * `#[contracterror]` enum (it panics with plain strings), so unlike
 * insurance.ts/reputation.ts there's no numeric error code to map here —
 * simulation failures surface the raw message.
 */
async function submitCall(
  server: SorobanRpc.Server,
  contractId: string,
  methodName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[],
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<{ txHash: string; retval: unknown }> {
  const contract = new Contract(contractId);
  const op = contract.call(methodName, ...args);

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await retry(() => server.simulateTransaction(tx));
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`${methodName} simulation failed: ${sim.error}`);
  }

  const assembledTx = SorobanRpc.assembleTransaction(tx, sim).build();
  const signedTx = await signTransaction(assembledTx);
  const sendResult = await retry(() => server.sendTransaction(signedTx));

  if (sendResult.errorResult) {
    throw new Error(`${methodName} transaction failed: ${sendResult.errorResult}`);
  }

  let status = await retry(() => server.getTransaction(sendResult.hash));
  let retries = 0;
  while (
    status.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND &&
    retries < 15
  ) {
    await new Promise((r) => setTimeout(r, 2000));
    status = await retry(() => server.getTransaction(sendResult.hash));
    retries++;
  }

  if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw new Error(`${methodName} transaction failed during execution`);
  }

  const retval =
    status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS && sim.result?.retval
      ? scValToNative(sim.result.retval)
      : undefined;

  return { txHash: sendResult.hash, retval };
}

/**
 * Fetch a participant's accrued distribution tokens.
 *
 * Wraps the `get_accrual(participant)` view function.
 *
 * @param server              - Soroban RPC server for the target network
 * @param contractId          - Deployed distribution contract address
 * @param participantAddress  - Stellar address (G...) of the participant
 * @param networkPassphrase   - Stellar network passphrase (default: TESTNET)
 * @returns The total earned tokens as a number
 */
export async function getDistributionAccrual(
  server: SorobanRpc.Server,
  contractId: string,
  participantAddress: string,
  networkPassphrase: string = Networks.TESTNET
): Promise<number> {
  validateContractId(contractId);
  validateGAddress(participantAddress);

  const contract = new Contract(contractId);
  const op = contract.call(
    "get_accrual",
    new Address(participantAddress).toScVal()
  );

  const sourceAccount = new Account(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "0"
  );

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await retry(() => server.simulateTransaction(tx));

  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`get_accrual simulation failed: ${sim.error}`);
  }

  if (!sim.result?.retval) {
    return 0;
  }

  const rawVal = scValToNative(sim.result.retval) as bigint;
  return Number(rawVal);
}

// ---------------------------------------------------------------------------
// Write operations (#476)
// ---------------------------------------------------------------------------

/**
 * Record an LP's funded volume for distribution accrual.
 *
 * Wraps `accrue_lp(lp, amount_usdc_equivalent)`. **Restricted**: the
 * contract's `require_iln_invoker` check requires a signature from the
 * configured `iln_contract` address (set at `initialize`), not an arbitrary
 * caller. In production this is called by the invoice_liquidity contract as
 * part of `fund_invoice`; this wrapper exists for testing and governance
 * scenarios where `sourceAccount` controls (or can authorize as) that
 * configured address.
 *
 * @param server                    - Soroban RPC server for the target network
 * @param contractId                - Deployed distribution contract address
 * @param lpAddress                 - The LP's Stellar G... address
 * @param amountUsdcEquivalent      - USDC-equivalent funded amount to accrue; no-ops if <= 0
 * @param sourceAccount             - Account authorized as the configured iln_contract address
 * @param signTransaction           - Function to sign the assembled transaction
 * @param networkPassphrase         - Stellar network passphrase (default: TESTNET)
 * @returns The submitted transaction hash
 */
export async function accrueLp(
  server: SorobanRpc.Server,
  contractId: string,
  lpAddress: string,
  amountUsdcEquivalent: bigint,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string = Networks.TESTNET
): Promise<{ txHash: string }> {
  validateContractId(contractId);
  validateGAddress(lpAddress);
  const { txHash } = await submitCall(
    server,
    contractId,
    "accrue_lp",
    [new Address(lpAddress).toScVal(), nativeToScVal(amountUsdcEquivalent, { type: "i128" })],
    sourceAccount,
    signTransaction,
    networkPassphrase
  );
  return { txHash };
}

/**
 * Record a settlement event for both the freelancer and (if on-time) payer.
 *
 * Wraps `accrue_settlement(freelancer, payer, settled_on_time)`. Same
 * `require_iln_invoker` restriction as {@link accrueLp} — see that doc
 * comment for the auth caveat.
 *
 * @param server              - Soroban RPC server for the target network
 * @param contractId          - Deployed distribution contract address
 * @param freelancerAddress   - The freelancer's Stellar G... address
 * @param payerAddress        - The payer's Stellar G... address
 * @param settledOnTime       - Whether the payer settled before the due date
 * @param sourceAccount       - Account authorized as the configured iln_contract address
 * @param signTransaction     - Function to sign the assembled transaction
 * @param networkPassphrase   - Stellar network passphrase (default: TESTNET)
 * @returns The submitted transaction hash
 */
export async function accrueSettlement(
  server: SorobanRpc.Server,
  contractId: string,
  freelancerAddress: string,
  payerAddress: string,
  settledOnTime: boolean,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string = Networks.TESTNET
): Promise<{ txHash: string }> {
  validateContractId(contractId);
  validateGAddress(freelancerAddress);
  validateGAddress(payerAddress);
  const { txHash } = await submitCall(
    server,
    contractId,
    "accrue_settlement",
    [
      new Address(freelancerAddress).toScVal(),
      new Address(payerAddress).toScVal(),
      nativeToScVal(settledOnTime, { type: "bool" }),
    ],
    sourceAccount,
    signTransaction,
    networkPassphrase
  );
  return { txHash };
}

/**
 * Claim accrued distribution tokens for the caller.
 *
 * Wraps `claim_tokens(claimer)`. Requires the claimer's signature —
 * `sourceAccount` must be `claimer`'s account. Mints the claimable delta
 * (total earned minus already claimed) directly to the claimer.
 *
 * @param server              - Soroban RPC server for the target network
 * @param contractId          - Deployed distribution contract address
 * @param claimerAddress      - The claimer's Stellar G... address (must match sourceAccount)
 * @param sourceAccount       - The claimer's account (signs and pays the tx fee)
 * @param signTransaction     - Function to sign the assembled transaction
 * @param networkPassphrase   - Stellar network passphrase (default: TESTNET)
 * @returns The submitted transaction hash and the amount claimed
 */
export async function claimTokens(
  server: SorobanRpc.Server,
  contractId: string,
  claimerAddress: string,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string = Networks.TESTNET
): Promise<{ txHash: string; claimed: bigint }> {
  validateContractId(contractId);
  validateGAddress(claimerAddress);
  const { txHash, retval } = await submitCall(
    server,
    contractId,
    "claim_tokens",
    [new Address(claimerAddress).toScVal()],
    sourceAccount,
    signTransaction,
    networkPassphrase
  );
  return { txHash, claimed: (retval as bigint | undefined) ?? 0n };
}
