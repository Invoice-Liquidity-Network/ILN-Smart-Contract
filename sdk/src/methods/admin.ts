import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  Account,
  Transaction,
} from "@stellar/stellar-sdk";
import { ILNError } from "../errors.js";
import { retry } from "../utils/retry.js";
import { validateGAddress, validateContractId } from "../utils/validate.js";

/**
 * Set a new admin for the ILN contract.
 */
export async function setAdmin(
  server: SorobanRpc.Server,
  contractAddress: string,
  newAdmin: string,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<{ txHash: string }> {
  validateGAddress(newAdmin);

  const contract = new Contract(contractAddress);
  const op = contract.call(
    "set_admin",
    nativeToScVal(newAdmin, { type: "address" })
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
    throw ILNError.fromError(sim.error);
  }

  const assembledTx = SorobanRpc.assembleTransaction(tx, sim).build();
  const signedTx = await signTransaction(assembledTx);
  const sendResult = await retry(() => server.sendTransaction(signedTx));
  if (sendResult.errorResult) {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }

  let status = await retry(() => server.getTransaction(sendResult.hash));
  let retries = 0;
  while (status.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND && retries < 15) {
    await new Promise(r => setTimeout(r, 2000));
    status = await retry(() => server.getTransaction(sendResult.hash));
    retries++;
  }

  if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw new Error("Transaction failed during execution");
  }

  return { txHash: sendResult.hash };
}

/**
 * Upgrade the ILN contract to a new Wasm hash.
 */
export async function upgrade(
  server: SorobanRpc.Server,
  contractAddress: string,
  newWasmHash: Buffer,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<{ txHash: string }> {
  const contract = new Contract(contractAddress);
  const op = contract.call(
    "upgrade",
    nativeToScVal(newWasmHash, { type: "bytes" })
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
    throw ILNError.fromError(sim.error);
  }

  const assembledTx = SorobanRpc.assembleTransaction(tx, sim).build();
  const signedTx = await signTransaction(assembledTx);
  const sendResult = await retry(() => server.sendTransaction(signedTx));
  if (sendResult.errorResult) {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }

  let status = await retry(() => server.getTransaction(sendResult.hash));
  let retries = 0;
  while (status.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND && retries < 15) {
    await new Promise(r => setTimeout(r, 2000));
    status = await retry(() => server.getTransaction(sendResult.hash));
    retries++;
  }

  if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw new Error("Transaction failed during execution");
  }

  return { txHash: sendResult.hash };
}

/**
 * Set the distribution contract address on the ILN invoice_liquidity contract.
 * Admin only — subject to the default rate limit.
 */
export async function setDistributionContract(
  server: SorobanRpc.Server,
  contractAddress: string,
  distributionContract: string,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<{ txHash: string }> {
  validateContractId(distributionContract);

  const contract = new Contract(contractAddress);
  const op = contract.call(
    "set_distribution_contract",
    nativeToScVal(distributionContract, { type: "address" })
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
    throw ILNError.fromError(sim.error);
  }

  const assembledTx = SorobanRpc.assembleTransaction(tx, sim).build();
  const signedTx = await signTransaction(assembledTx);
  const sendResult = await retry(() => server.sendTransaction(signedTx));
  if (sendResult.errorResult) {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }

  let status = await retry(() => server.getTransaction(sendResult.hash));
  let retries = 0;
  while (status.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND && retries < 15) {
    await new Promise(r => setTimeout(r, 2000));
    status = await retry(() => server.getTransaction(sendResult.hash));
    retries++;
  }

  if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw new Error("Transaction failed during execution");
  }

  return { txHash: sendResult.hash };
}

/**
 * Add an approved token to the ILN invoice_liquidity contract.
 * Admin only — subject to the default rate limit.
 */
export async function addToken(
  server: SorobanRpc.Server,
  contractAddress: string,
  token: string,
  decimals: number,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<{ txHash: string }> {
  validateContractId(token);

  const contract = new Contract(contractAddress);
  const op = contract.call(
    "add_token",
    nativeToScVal(token, { type: "address" }),
    nativeToScVal(decimals, { type: "u32" })
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
    throw ILNError.fromError(sim.error);
  }

  const assembledTx = SorobanRpc.assembleTransaction(tx, sim).build();
  const signedTx = await signTransaction(assembledTx);
  const sendResult = await retry(() => server.sendTransaction(signedTx));
  if (sendResult.errorResult) {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }

  let status = await retry(() => server.getTransaction(sendResult.hash));
  let retries = 0;
  while (status.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND && retries < 15) {
    await new Promise(r => setTimeout(r, 2000));
    status = await retry(() => server.getTransaction(sendResult.hash));
    retries++;
  }

  if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw new Error("Transaction failed during execution");
  }

  return { txHash: sendResult.hash };
}

/**
 * Update the protocol fee rate (in basis points) on the ILN invoice_liquidity
 * contract. Admin only — subject to the economic-parameter cooldown.
 */
export async function updateFeeRate(
  server: SorobanRpc.Server,
  contractAddress: string,
  rate: number,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<{ txHash: string }> {
  const contract = new Contract(contractAddress);
  const op = contract.call(
    "update_fee_rate",
    nativeToScVal(rate, { type: "u32" })
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
    throw ILNError.fromError(sim.error);
  }

  const assembledTx = SorobanRpc.assembleTransaction(tx, sim).build();
  const signedTx = await signTransaction(assembledTx);
  const sendResult = await retry(() => server.sendTransaction(signedTx));
  if (sendResult.errorResult) {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }

  let status = await retry(() => server.getTransaction(sendResult.hash));
  let retries = 0;
  while (status.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND && retries < 15) {
    await new Promise(r => setTimeout(r, 2000));
    status = await retry(() => server.getTransaction(sendResult.hash));
    retries++;
  }

  if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw new Error("Transaction failed during execution");
  }

  return { txHash: sendResult.hash };
}

/**
 * Update the maximum invoice discount rate (in basis points) on the ILN
 * invoice_liquidity contract. Admin only — subject to the economic-parameter
 * cooldown.
 */
export async function updateMaxDiscount(
  server: SorobanRpc.Server,
  contractAddress: string,
  rate: number,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<{ txHash: string }> {
  const contract = new Contract(contractAddress);
  const op = contract.call(
    "update_max_discount",
    nativeToScVal(rate, { type: "u32" })
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
    throw ILNError.fromError(sim.error);
  }

  const assembledTx = SorobanRpc.assembleTransaction(tx, sim).build();
  const signedTx = await signTransaction(assembledTx);
  const sendResult = await retry(() => server.sendTransaction(signedTx));
  if (sendResult.errorResult) {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }

  let status = await retry(() => server.getTransaction(sendResult.hash));
  let retries = 0;
  while (status.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND && retries < 15) {
    await new Promise(r => setTimeout(r, 2000));
    status = await retry(() => server.getTransaction(sendResult.hash));
    retries++;
  }

  if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw new Error("Transaction failed during execution");
  }

  return { txHash: sendResult.hash };
}

/**
 * Set the price oracle contract address on the ILN invoice_liquidity
 * contract. Admin only — subject to the default rate limit.
 */
export async function setPriceOracle(
  server: SorobanRpc.Server,
  contractAddress: string,
  oracle: string,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<{ txHash: string }> {
  validateContractId(oracle);

  const contract = new Contract(contractAddress);
  const op = contract.call(
    "set_price_oracle",
    nativeToScVal(oracle, { type: "address" })
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
    throw ILNError.fromError(sim.error);
  }

  const assembledTx = SorobanRpc.assembleTransaction(tx, sim).build();
  const signedTx = await signTransaction(assembledTx);
  const sendResult = await retry(() => server.sendTransaction(signedTx));
  if (sendResult.errorResult) {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }

  let status = await retry(() => server.getTransaction(sendResult.hash));
  let retries = 0;
  while (status.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND && retries < 15) {
    await new Promise(r => setTimeout(r, 2000));
    status = await retry(() => server.getTransaction(sendResult.hash));
    retries++;
  }

  if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw new Error("Transaction failed during execution");
  }

  return { txHash: sendResult.hash };
}

/**
 * Update the maximum oracle data age (in ledgers) on the ILN
 * invoice_liquidity contract. Admin only — subject to the default rate
 * limit. Setting this to 0 disables the freshness check entirely.
 */
export async function setMaxOracleAge(
  server: SorobanRpc.Server,
  contractAddress: string,
  maxAgeLedgers: bigint,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<{ txHash: string }> {
  const contract = new Contract(contractAddress);
  const op = contract.call(
    "set_max_oracle_age",
    nativeToScVal(maxAgeLedgers, { type: "u64" })
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
    throw ILNError.fromError(sim.error);
  }

  const assembledTx = SorobanRpc.assembleTransaction(tx, sim).build();
  const signedTx = await signTransaction(assembledTx);
  const sendResult = await retry(() => server.sendTransaction(signedTx));
  if (sendResult.errorResult) {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }

  let status = await retry(() => server.getTransaction(sendResult.hash));
  let retries = 0;
  while (status.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND && retries < 15) {
    await new Promise(r => setTimeout(r, 2000));
    status = await retry(() => server.getTransaction(sendResult.hash));
    retries++;
  }

  if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw new Error("Transaction failed during execution");
  }

  return { txHash: sendResult.hash };
}

/**
 * Configure the deployed insurance pool contract address consulted by
 * claim_default() to compensate enrolled LPs on a confirmed default
 * (Issue #529). Admin only — subject to the default rate limit.
 */
export async function setInsurancePool(
  server: SorobanRpc.Server,
  contractAddress: string,
  poolAddress: string,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<{ txHash: string }> {
  validateContractId(poolAddress);

  const contract = new Contract(contractAddress);
  const op = contract.call(
    "set_insurance_pool",
    nativeToScVal(poolAddress, { type: "address" })
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
    throw ILNError.fromError(sim.error);
  }

  const assembledTx = SorobanRpc.assembleTransaction(tx, sim).build();
  const signedTx = await signTransaction(assembledTx);
  const sendResult = await retry(() => server.sendTransaction(signedTx));
  if (sendResult.errorResult) {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }

  let status = await retry(() => server.getTransaction(sendResult.hash));
  let retries = 0;
  while (status.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND && retries < 15) {
    await new Promise(r => setTimeout(r, 2000));
    status = await retry(() => server.getTransaction(sendResult.hash));
    retries++;
  }

  if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw new Error("Transaction failed during execution");
  }

  return { txHash: sendResult.hash };
}

/**
 * Fetch the invoice_liquidity contract's configured insurance pool address,
 * if any (Issue #529). Read-only; no signer required.
 */
export async function getInsurancePool(
  server: SorobanRpc.Server,
  contractAddress: string,
  sourceAccount: Account,
  networkPassphrase: string
): Promise<string | undefined> {
  const contract = new Contract(contractAddress);
  const op = contract.call("get_insurance_pool");

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await retry(() => server.simulateTransaction(tx));
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw ILNError.fromError(sim.error);
  }
  if (!sim.result?.retval) {
    return undefined;
  }
  const decoded = scValToNative(sim.result.retval);
  return decoded === null || decoded === undefined ? undefined : String(decoded);
}

/**
 * Remove an approved token from the ILN invoice_liquidity contract.
 * Admin only — subject to the default rate limit.
 */
export async function removeToken(
  server: SorobanRpc.Server,
  contractAddress: string,
  token: string,
  sourceAccount: Account,
  signTransaction: (tx: Transaction) => Promise<Transaction> | Transaction,
  networkPassphrase: string
): Promise<{ txHash: string }> {
  validateContractId(token);

  const contract = new Contract(contractAddress);
  const op = contract.call(
    "remove_token",
    nativeToScVal(token, { type: "address" })
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
    throw ILNError.fromError(sim.error);
  }

  const assembledTx = SorobanRpc.assembleTransaction(tx, sim).build();
  const signedTx = await signTransaction(assembledTx);
  const sendResult = await retry(() => server.sendTransaction(signedTx));
  if (sendResult.errorResult) {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }

  let status = await retry(() => server.getTransaction(sendResult.hash));
  let retries = 0;
  while (status.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND && retries < 15) {
    await new Promise(r => setTimeout(r, 2000));
    status = await retry(() => server.getTransaction(sendResult.hash));
    retries++;
  }

  if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
    throw new Error("Transaction failed during execution");
  }

  return { txHash: sendResult.hash };
}
