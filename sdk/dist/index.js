var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/utils/retry.ts
function isTransientError(error) {
  if (error instanceof Error) {
    const errorMessage = error.message.toLowerCase();
    const errorString = String(error).toLowerCase();
    if (errorMessage.includes("timeout") || errorMessage.includes("etimedout") || errorMessage.includes("econnrefused") || errorMessage.includes("enotfound") || errorMessage.includes("connection") || errorMessage.includes("network") || errorString.includes("timeout") || errorString.includes("econnrefused") || errorString.includes("enotfound")) {
      return true;
    }
    if (errorMessage.includes("429") || errorMessage.includes("too many requests") || errorMessage.includes("rate limit")) {
      return true;
    }
    if (errorMessage.includes("503") || errorMessage.includes("service unavailable") || errorMessage.includes("temporarily unavailable")) {
      return true;
    }
    if (errorMessage.includes("error(contract,") || errorString.includes("error(contract,")) {
      return false;
    }
    if (errorMessage.includes("user rejected") || errorMessage.includes("rejected by user") || errorMessage.includes("user cancelled") || errorMessage.includes("user denied")) {
      return false;
    }
    if (errorMessage.includes("invalid") || errorMessage.includes("validation") || errorMessage.includes("malformed")) {
      return false;
    }
    if (errorMessage.includes("unauthorized") || errorMessage.includes("authentication") || errorMessage.includes("forbidden")) {
      return false;
    }
  }
  return false;
}
async function retry(fn, options = {}) {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientError(error)) {
        throw error;
      }
      if (attempt === opts.maxRetries) {
        throw error;
      }
      const delay = opts.initialDelayMs * Math.pow(opts.backoffMultiplier, attempt);
      if (opts.verbose) {
        console.warn(
          `[retry] Attempt ${attempt + 1}/${opts.maxRetries + 1} failed, retrying in ${delay}ms:`,
          error instanceof Error ? error.message : error
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
var DEFAULT_RETRY_OPTIONS;
var init_retry = __esm({
  "src/utils/retry.ts"() {
    "use strict";
    DEFAULT_RETRY_OPTIONS = {
      maxRetries: 3,
      initialDelayMs: 500,
      backoffMultiplier: 2,
      verbose: false
    };
  }
});

// src/utils/xdrDecoder.ts
function decodeInvoice(raw) {
  const dueDate = Number(raw["due_date"]);
  const discountRate = Number(raw["discount_rate"]);
  return {
    id: BigInt(String(raw["id"])),
    freelancer: String(raw["freelancer"]),
    payer: String(raw["payer"]),
    token: String(raw["token"]),
    amount: BigInt(String(raw["amount"])),
    dueDate,
    discountRate,
    status: parseInvoiceStatus(raw["status"]),
    funder: raw["funder"] ? String(raw["funder"]) : void 0,
    fundedAt: raw["funded_at"] ? Number(raw["funded_at"]) : void 0,
    amountFunded: BigInt(String(raw["amount_funded"])),
    amountPaid: BigInt(String(raw["amount_paid"])),
    referralCode: raw["referral_code"] ? Buffer.from(raw["referral_code"]).toString("hex") : void 0,
    submitterReputation: Number(raw["submitter_reputation"]),
    effectiveYieldBps: computeEffectiveYieldBps2(discountRate, dueDate)
  };
}
function parseInvoiceStatus(status) {
  if (typeof status === "string") {
    return status;
  }
  if (status && typeof status === "object" && "tag" in status) {
    return String(status.tag);
  }
  return "Pending";
}
function computeEffectiveYieldBps2(discountRateBps, dueDateUnix) {
  const nowUnix = Math.floor(Date.now() / 1e3);
  const secondsToMaturity = Math.max(0, dueDateUnix - nowUnix);
  const daysToMaturity = secondsToMaturity / 86400;
  return Math.round(discountRateBps * daysToMaturity / 365);
}
function decodeReputationScore(raw, address) {
  return {
    address: String(raw["address"] ?? address),
    score: Number(raw["score"] ?? 0),
    invoicesSubmitted: Number(raw["invoices_submitted"] ?? 0),
    invoicesPaid: Number(raw["invoices_paid"] ?? 0),
    invoicesDefaulted: Number(raw["invoices_defaulted"] ?? 0)
  };
}
function decodeContractStats(raw) {
  const volumeByToken = {};
  const rawTokenVolumes = raw["token_volumes"];
  if (Array.isArray(rawTokenVolumes)) {
    for (const [token, volume] of rawTokenVolumes) {
      volumeByToken[token] = BigInt(volume);
    }
  }
  return {
    totalInvoices: BigInt(String(raw["total_invoices"] ?? "0")),
    totalFunded: BigInt(String(raw["total_funded"] ?? "0")),
    totalPaid: BigInt(String(raw["total_paid"] ?? "0")),
    totalVolumeUsdc: BigInt(String(raw["total_volume_usdc"] ?? "0")),
    totalVolumeEurc: BigInt(String(raw["total_volume_eurc"] ?? "0")),
    totalVolumeXlm: BigInt(String(raw["total_volume_xlm"] ?? "0")),
    volumeByToken,
    totalVolumeUsdNormalized: BigInt(
      String(raw["total_volume_usd_normalized"] ?? "0")
    )
  };
}
function decodeGovernanceProposal(raw) {
  const statusTag = raw["status"]?.tag ?? String(raw["status"]);
  return {
    id: BigInt(String(raw["id"])),
    action: Number(raw["action"]),
    proposedValue: BigInt(String(raw["proposed_value"] ?? 0)),
    descriptionHash: raw["description_hash"] ? Buffer.from(raw["description_hash"]).toString("hex") : "",
    proposer: String(raw["proposer"]),
    votesFor: BigInt(String(raw["votes_for"] ?? 0)),
    votesAgainst: BigInt(String(raw["votes_against"] ?? 0)),
    status: parseProposalStatus(statusTag),
    votingEndsAt: Number(raw["voting_ends_at"] ?? 0)
  };
}
function parseProposalStatus(status) {
  if (status === "Active" || status === "Passed" || status === "Rejected" || status === "Executed") {
    return status;
  }
  return "Active";
}
var init_xdrDecoder = __esm({
  "src/utils/xdrDecoder.ts"() {
    "use strict";
  }
});

// src/methods/reputation.ts
var reputation_exports = {};
__export(reputation_exports, {
  getReputation: () => getReputation
});
import {
  Contract as Contract3,
  SorobanRpc as SorobanRpc3,
  TransactionBuilder as TransactionBuilder3,
  Account as Account3,
  BASE_FEE as BASE_FEE3,
  scValToNative as scValToNative3,
  Address as Address3,
  Networks as Networks3
} from "@stellar/stellar-sdk";
function isValidGAddress(address) {
  return G_ADDRESS_RE.test(address);
}
async function getReputation(server, contractId, address, networkPassphrase = Networks3.TESTNET) {
  if (!isValidGAddress(address)) {
    throw new Error(
      `Invalid Stellar address: "${address}". Must be a G\u2026 public key.`
    );
  }
  const contract = new Contract3(contractId);
  const op = contract.call(
    "get_reputation",
    new Address3(address).toScVal()
  );
  const sourceAccount = new Account3(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "0"
  );
  const simTx = new TransactionBuilder3(sourceAccount, {
    fee: BASE_FEE3,
    networkPassphrase
  }).addOperation(op).setTimeout(30).build();
  const sim = await retry(() => server.simulateTransaction(simTx));
  if (SorobanRpc3.Api.isSimulationError(sim)) {
    throw new Error(`get_reputation simulation failed: ${sim.error}`);
  }
  if (!sim.result?.retval) {
    return decodeReputationScore({}, address);
  }
  const raw = scValToNative3(sim.result.retval);
  return decodeReputationScore(raw, address);
}
var G_ADDRESS_RE;
var init_reputation = __esm({
  "src/methods/reputation.ts"() {
    "use strict";
    init_retry();
    init_xdrDecoder();
    G_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
  }
});

// src/methods/stats.ts
var stats_exports = {};
__export(stats_exports, {
  getContractStats: () => getContractStats
});
import {
  Contract as Contract4,
  SorobanRpc as SorobanRpc4,
  TransactionBuilder as TransactionBuilder4,
  Account as Account4,
  BASE_FEE as BASE_FEE4,
  scValToNative as scValToNative4,
  Networks as Networks4
} from "@stellar/stellar-sdk";
async function getContractStats(server, contractId, networkPassphrase = Networks4.TESTNET) {
  const contract = new Contract4(contractId);
  const op = contract.call("get_contract_stats");
  const sourceAccount = new Account4(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "0"
  );
  const simTx = new TransactionBuilder4(sourceAccount, {
    fee: BASE_FEE4,
    networkPassphrase
  }).addOperation(op).setTimeout(30).build();
  const sim = await retry(() => server.simulateTransaction(simTx));
  if (SorobanRpc4.Api.isSimulationError(sim)) {
    throw new Error(`get_contract_stats simulation failed: ${sim.error}`);
  }
  if (!sim.result?.retval) {
    return {
      totalInvoices: 0n,
      totalFunded: 0n,
      totalPaid: 0n,
      totalVolumeUsdc: 0n,
      totalVolumeEurc: 0n,
      totalVolumeXlm: 0n,
      volumeByToken: {},
      totalVolumeUsdNormalized: 0n
    };
  }
  const raw = scValToNative4(sim.result.retval);
  return decodeContractStats(raw);
}
var init_stats = __esm({
  "src/methods/stats.ts"() {
    "use strict";
    init_retry();
    init_xdrDecoder();
  }
});

// src/methods/fundInvoice.ts
import {
  Contract as Contract2,
  SorobanRpc as SorobanRpc2,
  TransactionBuilder as TransactionBuilder2,
  Networks as Networks2,
  BASE_FEE as BASE_FEE2,
  scValToNative as scValToNative2,
  nativeToScVal as nativeToScVal2,
  Address as Address2,
  Account as Account2,
  Transaction
} from "@stellar/stellar-sdk";

// src/utils/allowance.ts
import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  scValToNative,
  nativeToScVal,
  Address
} from "@stellar/stellar-sdk";
async function getAllowance(server, params, sourceAccount) {
  const tokenContract = new Contract(params.tokenAddress);
  const op = tokenContract.call(
    "allowance",
    new Address(params.owner).toScVal(),
    new Address(params.spender).toScVal()
  );
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET
  }).addOperation(op).setTimeout(30).build();
  const simResult = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(`Allowance simulation failed: ${simResult.error}`);
  }
  if (!simResult.result?.retval) {
    return { amount: 0n, expirationLedger: 0 };
  }
  const native = scValToNative(simResult.result.retval);
  if (typeof native === "object" && native !== null && "amount" in native) {
    const obj = native;
    return {
      amount: BigInt(String(obj["amount"])),
      expirationLedger: Number(obj["expiration_ledger"] ?? 0)
    };
  }
  return {
    amount: BigInt(String(native)),
    expirationLedger: 0
  };
}
async function buildApproveTransaction(server, tokenAddress, ownerAccount, spenderAddress, amount, networkPassphrase = Networks.TESTNET) {
  const tokenContract = new Contract(tokenAddress);
  const ledgerInfo = await server.getLatestLedger();
  const expirationLedger = ledgerInfo.sequence + 720;
  const op = tokenContract.call(
    "approve",
    new Address(ownerAccount.accountId()).toScVal(),
    new Address(spenderAddress).toScVal(),
    nativeToScVal(amount, { type: "i128" }),
    nativeToScVal(expirationLedger, { type: "u32" })
  );
  const tx = new TransactionBuilder(ownerAccount, {
    fee: BASE_FEE,
    networkPassphrase
  }).addOperation(op).setTimeout(30).build();
  const preparedTx = await server.prepareTransaction(tx);
  return preparedTx.toEnvelope().toXDR("base64");
}
function isAllowanceSufficient(allowance, required, minExpirationLedger) {
  if (allowance.amount < required) return false;
  if (minExpirationLedger !== void 0 && allowance.expirationLedger > 0 && allowance.expirationLedger < minExpirationLedger) {
    return false;
  }
  return true;
}

// src/methods/fundInvoice.ts
init_retry();
function computeEffectiveYieldBps(discountRateBps, dueDateUnix, nowUnix = Math.floor(Date.now() / 1e3)) {
  const secondsToMaturity = Math.max(0, dueDateUnix - nowUnix);
  const daysToMaturity = secondsToMaturity / 86400;
  return Math.round(discountRateBps * daysToMaturity / 365);
}
async function fetchInvoice(server, contractAddress, invoiceId, sourceAccount, networkPassphrase) {
  const contract = new Contract2(contractAddress);
  const op = contract.call(
    "get_invoice",
    nativeToScVal2(invoiceId, { type: "u64" })
  );
  const tx = new TransactionBuilder2(sourceAccount, {
    fee: BASE_FEE2,
    networkPassphrase
  }).addOperation(op).setTimeout(30).build();
  const sim = await retry(() => server.simulateTransaction(tx));
  if (SorobanRpc2.Api.isSimulationError(sim)) {
    throw new Error(`get_invoice simulation failed: ${sim.error}`);
  }
  if (!sim.result?.retval) {
    throw new Error(`Invoice ${invoiceId} not found`);
  }
  const raw = scValToNative2(sim.result.retval);
  return {
    id: BigInt(String(raw["id"])),
    token: String(raw["token"]),
    amount: BigInt(String(raw["amount"])),
    dueDate: Number(raw["due_date"]),
    discountRate: Number(raw["discount_rate"]),
    status: String(raw["status"])
  };
}
async function signAndSubmit(server, envelopeXdr, signer, networkPassphrase) {
  const tx = new Transaction(envelopeXdr, networkPassphrase);
  tx.sign(signer);
  const result = await server.sendTransaction(tx);
  if (result.status === "ERROR") {
    throw new Error(
      `Transaction failed: ${JSON.stringify(result.errorResult)}`
    );
  }
  return result.hash;
}
async function verifyOracle(server, contractAddress, sourceAccount, networkPassphrase) {
  const contract = new Contract2(contractAddress);
  const op = contract.call("get_price_oracle");
  const tx = new TransactionBuilder2(sourceAccount, {
    fee: BASE_FEE2,
    networkPassphrase
  }).addOperation(op).setTimeout(30).build();
  const sim = await retry(() => server.simulateTransaction(tx));
  if (SorobanRpc2.Api.isSimulationError(sim)) {
    throw new Error(`Oracle verification failed: ${sim.error}`);
  }
  if (!sim.result?.retval) {
    throw new Error(
      "Oracle verification required but no price oracle is configured on the contract"
    );
  }
  const oracleAddress = scValToNative2(sim.result.retval);
  if (!oracleAddress) {
    throw new Error(
      "Oracle verification required but no price oracle is configured on the contract"
    );
  }
}
async function fundInvoice(server, contractAddress, lpKeypair, invoiceId, options = {}, networkPassphrase = Networks2.TESTNET) {
  const {
    requireOracleVerification = false,
    onApprovalRequired,
    onApprovalSent,
    onFunded
  } = options;
  const lpAddress = lpKeypair.publicKey();
  const accountData = await retry(() => server.getAccount(lpAddress));
  let sequence = accountData.sequence;
  const makeAccount = (seq) => new Account2(lpAddress, seq);
  const invoice = await fetchInvoice(
    server,
    contractAddress,
    invoiceId,
    makeAccount(sequence),
    networkPassphrase
  );
  if (invoice.status !== "Pending" && invoice.status !== "PartiallyFunded") {
    throw new Error(
      `Invoice ${invoiceId} cannot be funded (status: ${invoice.status})`
    );
  }
  if (requireOracleVerification) {
    await verifyOracle(
      server,
      contractAddress,
      makeAccount(sequence),
      networkPassphrase
    );
  }
  const ledgerInfo = await retry(() => server.getLatestLedger());
  const currentLedger = ledgerInfo.sequence;
  const allowance = await getAllowance(
    server,
    { tokenAddress: invoice.token, owner: lpAddress, spender: contractAddress },
    makeAccount(sequence)
  );
  const needsApproval = !isAllowanceSufficient(
    allowance,
    invoice.amount,
    currentLedger + 10
    // require at least 10 ledgers validity remaining
  );
  if (needsApproval) {
    onApprovalRequired?.({
      requiredAmount: invoice.amount,
      currentAllowance: allowance.amount
    });
    const approveXdr = await buildApproveTransaction(
      server,
      invoice.token,
      makeAccount(sequence),
      contractAddress,
      invoice.amount,
      networkPassphrase
    );
    const approveTxHash = await signAndSubmit(
      server,
      approveXdr,
      lpKeypair,
      networkPassphrase
    );
    onApprovalSent?.({ approveTxHash });
    sequence = String(BigInt(sequence) + 1n);
  }
  const contract = new Contract2(contractAddress);
  const fundOp = contract.call(
    "fund_invoice",
    new Address2(lpAddress).toScVal(),
    nativeToScVal2(invoiceId, { type: "u64" }),
    nativeToScVal2(invoice.amount, { type: "i128" })
  );
  const fundTx = new TransactionBuilder2(makeAccount(sequence), {
    fee: BASE_FEE2,
    networkPassphrase
  }).addOperation(fundOp).setTimeout(30).build();
  const preparedFundTx = await retry(() => server.prepareTransaction(fundTx));
  preparedFundTx.sign(lpKeypair);
  const fundSendResult = await retry(() => server.sendTransaction(
    preparedFundTx
  ));
  if (fundSendResult.status === "ERROR") {
    throw new Error(
      `fund_invoice failed: ${JSON.stringify(fundSendResult.errorResult)}`
    );
  }
  const effectiveYieldBps = computeEffectiveYieldBps(
    invoice.discountRate,
    invoice.dueDate
  );
  onFunded?.({ effectiveYieldBps, invoiceId });
  return { txHash: fundSendResult.hash, effectiveYieldBps };
}

// src/index.ts
init_reputation();
init_stats();

// src/errors.ts
var _ILNError = class _ILNError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = this.constructor.name;
  }
  static fromError(error) {
    const errorString = String(error);
    const match = errorString.match(/Error\(Contract, (\d+)\)/);
    if (match) {
      const code = parseInt(match[1] || "", 10);
      switch (code) {
        case 1:
          return new _ILNError.InvoiceNotFound();
        case 2:
          return new _ILNError.AlreadyFunded();
        case 3:
          return new _ILNError.AlreadyPaid();
        case 4:
          return new _ILNError.NotFunded();
        case 5:
          return new _ILNError.Unauthorized();
        case 6:
          return new _ILNError.InvalidAmount();
        case 7:
          return new _ILNError.InvalidDiscountRate();
        case 8:
          return new _ILNError.InvalidDueDate();
        case 9:
          return new _ILNError.InvoiceDefaulted();
        case 10:
          return new _ILNError.NothingToClaim();
        case 11:
          return new _ILNError.NotYetDefaulted();
        case 12:
          return new _ILNError.OverfundingRejected();
        case 13:
          return new _ILNError.InvoiceExpired();
        case 14:
          return new _ILNError.BatchTooLarge();
        case 15:
          return new _ILNError.AlreadyCancelled();
        case 16:
          return new _ILNError.AlreadyInitialized();
        case 17:
          return new _ILNError.AlreadyAppealed();
        case 18:
          return new _ILNError.AppealWindowClosed();
        case 19:
          return new _ILNError.NotDefaulted();
        case 20:
          return new _ILNError.AlreadyInQueue();
        case 21:
          return new _ILNError.NotApprovedFunder();
        case 22:
          return new _ILNError.InvoiceAppealed();
        case 23:
          return new _ILNError.AlreadyDisputed();
        case 24:
          return new _ILNError.NotDisputed();
        case 25:
          return new _ILNError.InvoiceDisputed();
        case 26:
          return new _ILNError.ContractPaused();
        case 27:
          return new _ILNError.DueDateTooSoon();
        case 28:
          return new _ILNError.DueDateTooFar();
        case 29:
          return new _ILNError.SelfInvoice();
        case 30:
          return new _ILNError.OverpaymentRejected();
        case 31:
          return new _ILNError.PayerReputationTooLow();
        case 32:
          return new _ILNError.ArithmeticOverflow();
        case 33:
          return new _ILNError.FeeOnTransferToken();
        case 34:
          return new _ILNError.PayerUnverified();
        case 35:
          return new _ILNError.OracleDataStale();
        case 36:
          return new _ILNError.AmountTooSmall();
        case 37:
          return new _ILNError.InvoiceNotCancellable();
      }
    }
    return new Error(errorString);
  }
};
_ILNError.InvoiceNotFound = class InvoiceNotFound extends _ILNError {
  constructor(msg = "Invoice not found") {
    super(msg, 1);
  }
};
_ILNError.AlreadyFunded = class AlreadyFunded extends _ILNError {
  constructor(msg = "Invoice already funded") {
    super(msg, 2);
  }
};
_ILNError.AlreadyPaid = class AlreadyPaid extends _ILNError {
  constructor(msg = "Invoice already paid") {
    super(msg, 3);
  }
};
_ILNError.NotFunded = class NotFunded extends _ILNError {
  constructor(msg = "Invoice not funded") {
    super(msg, 4);
  }
};
_ILNError.Unauthorized = class Unauthorized extends _ILNError {
  constructor(msg = "Unauthorized") {
    super(msg, 5);
  }
};
_ILNError.InvalidAmount = class InvalidAmount extends _ILNError {
  constructor(msg = "Invalid amount") {
    super(msg, 6);
  }
};
_ILNError.InvalidDiscountRate = class InvalidDiscountRate extends _ILNError {
  constructor(msg = "Invalid discount rate") {
    super(msg, 7);
  }
};
_ILNError.InvalidDueDate = class InvalidDueDate extends _ILNError {
  constructor(msg = "Invalid due date") {
    super(msg, 8);
  }
};
_ILNError.InvoiceDefaulted = class InvoiceDefaulted extends _ILNError {
  constructor(msg = "Invoice defaulted") {
    super(msg, 9);
  }
};
_ILNError.NothingToClaim = class NothingToClaim extends _ILNError {
  constructor(msg = "Nothing to claim") {
    super(msg, 10);
  }
};
_ILNError.NotYetDefaulted = class NotYetDefaulted extends _ILNError {
  constructor(msg = "Not yet defaulted") {
    super(msg, 11);
  }
};
_ILNError.OverfundingRejected = class OverfundingRejected extends _ILNError {
  constructor(msg = "Overfunding rejected") {
    super(msg, 12);
  }
};
_ILNError.InvoiceExpired = class InvoiceExpired extends _ILNError {
  constructor(msg = "Invoice expired") {
    super(msg, 13);
  }
};
_ILNError.BatchTooLarge = class BatchTooLarge extends _ILNError {
  constructor(msg = "Batch too large") {
    super(msg, 14);
  }
};
_ILNError.AlreadyCancelled = class AlreadyCancelled extends _ILNError {
  constructor(msg = "Already cancelled") {
    super(msg, 15);
  }
};
_ILNError.AlreadyInitialized = class AlreadyInitialized extends _ILNError {
  constructor(msg = "Already initialized") {
    super(msg, 16);
  }
};
_ILNError.AlreadyAppealed = class AlreadyAppealed extends _ILNError {
  constructor(msg = "Already appealed") {
    super(msg, 17);
  }
};
_ILNError.AppealWindowClosed = class AppealWindowClosed extends _ILNError {
  constructor(msg = "Appeal window closed") {
    super(msg, 18);
  }
};
_ILNError.NotDefaulted = class NotDefaulted extends _ILNError {
  constructor(msg = "Not defaulted") {
    super(msg, 19);
  }
};
_ILNError.AlreadyInQueue = class AlreadyInQueue extends _ILNError {
  constructor(msg = "Already in queue") {
    super(msg, 20);
  }
};
_ILNError.NotApprovedFunder = class NotApprovedFunder extends _ILNError {
  constructor(msg = "Not approved funder") {
    super(msg, 21);
  }
};
_ILNError.InvoiceAppealed = class InvoiceAppealed extends _ILNError {
  constructor(msg = "Invoice appealed") {
    super(msg, 22);
  }
};
_ILNError.AlreadyDisputed = class AlreadyDisputed extends _ILNError {
  constructor(msg = "Already disputed") {
    super(msg, 23);
  }
};
_ILNError.NotDisputed = class NotDisputed extends _ILNError {
  constructor(msg = "Not disputed") {
    super(msg, 24);
  }
};
_ILNError.InvoiceDisputed = class InvoiceDisputed extends _ILNError {
  constructor(msg = "Invoice disputed") {
    super(msg, 25);
  }
};
_ILNError.ContractPaused = class ContractPaused extends _ILNError {
  constructor(msg = "Contract paused") {
    super(msg, 26);
  }
};
_ILNError.DueDateTooSoon = class DueDateTooSoon extends _ILNError {
  constructor(msg = "Due date too soon") {
    super(msg, 27);
  }
};
_ILNError.DueDateTooFar = class DueDateTooFar extends _ILNError {
  constructor(msg = "Due date too far") {
    super(msg, 28);
  }
};
_ILNError.SelfInvoice = class SelfInvoice extends _ILNError {
  constructor(msg = "Self invoice") {
    super(msg, 29);
  }
};
_ILNError.OverpaymentRejected = class OverpaymentRejected extends _ILNError {
  constructor(msg = "Overpayment rejected") {
    super(msg, 30);
  }
};
_ILNError.PayerReputationTooLow = class PayerReputationTooLow extends _ILNError {
  constructor(msg = "Payer reputation too low") {
    super(msg, 31);
  }
};
_ILNError.ArithmeticOverflow = class ArithmeticOverflow extends _ILNError {
  constructor(msg = "Arithmetic overflow") {
    super(msg, 32);
  }
};
_ILNError.FeeOnTransferToken = class FeeOnTransferToken extends _ILNError {
  constructor(msg = "Fee on transfer token") {
    super(msg, 33);
  }
};
_ILNError.PayerUnverified = class PayerUnverified extends _ILNError {
  constructor(msg = "Payer unverified") {
    super(msg, 34);
  }
};
_ILNError.OracleDataStale = class OracleDataStale extends _ILNError {
  constructor(msg = "Oracle data stale") {
    super(msg, 35);
  }
};
_ILNError.AmountTooSmall = class AmountTooSmall extends _ILNError {
  constructor(msg = "Amount too small") {
    super(msg, 36);
  }
};
_ILNError.InvoiceNotCancellable = class InvoiceNotCancellable extends _ILNError {
  constructor(msg = "Invoice not cancellable") {
    super(msg, 37);
  }
};
_ILNError.InvalidAddress = class InvalidAddress extends _ILNError {
  constructor(msg = "Invalid address") {
    super(msg, 38);
  }
};
_ILNError.InvalidTransfer = class InvalidTransfer extends _ILNError {
  constructor(msg = "Invalid transfer") {
    super(msg, 39);
  }
};
_ILNError.InsufficientAmount = class InsufficientAmount extends _ILNError {
  constructor(msg = "Insufficient amount") {
    super(msg, 999);
  }
};
var ILNError = _ILNError;

// src/utils/validate.ts
var G_ADDRESS_LENGTH = 56;
var C_ADDRESS_LENGTH = 56;
var MIN_DISCOUNT_BPS = 1;
var MAX_DISCOUNT_BPS = 5e3;
var MIN_DUE_DATE_MS = 24 * 60 * 60 * 1e3;
var MAX_DUE_DATE_MS = 365 * 24 * 60 * 60 * 1e3;
var TOKEN_DECIMALS = {
  USDC: 7,
  EURC: 7,
  XLM: 7
};
function validateGAddress(address) {
  if (typeof address !== "string" || address.length === 0) {
    throw new ILNError.InvalidAddress("Address must be a non-empty string");
  }
  if (!address.startsWith("G")) {
    throw new ILNError.InvalidAddress(
      `Invalid Stellar address "${address}": must start with "G"`
    );
  }
  if (address.length !== G_ADDRESS_LENGTH) {
    throw new ILNError.InvalidAddress(
      `Invalid Stellar address "${address}": must be ${G_ADDRESS_LENGTH} characters`
    );
  }
}
function validateContractId(contractId) {
  if (typeof contractId !== "string" || contractId.length === 0) {
    throw new ILNError.InvalidAddress("Contract ID must be a non-empty string");
  }
  if (!contractId.startsWith("C") || contractId.length !== C_ADDRESS_LENGTH) {
    throw new ILNError.InvalidAddress(
      `Invalid contract ID "${contractId}": must start with "C" and be ${C_ADDRESS_LENGTH} characters`
    );
  }
}
function validateAmount(amount, min, token) {
  if (typeof amount !== "bigint") {
    throw new ILNError.InvalidAmount("Amount must be a bigint (token base units)");
  }
  if (amount <= 0n) {
    throw new ILNError.InvalidAmount("Amount must be greater than 0");
  }
  if (amount < min) {
    throw new ILNError.InvalidAmount(
      `Amount ${amount} is below the minimum of ${min} for ${token}`
    );
  }
  const decimals = TOKEN_DECIMALS[token];
  if (decimals === void 0 && !token.startsWith("C")) {
    throw new ILNError.InvalidAmount(
      `Unknown token "${token}": cannot verify amount precision`
    );
  }
}
function validateDiscountRate(rate) {
  if (!Number.isInteger(rate)) {
    throw new ILNError.InvalidDiscountRate("Discount rate must be an integer (bps)");
  }
  if (rate < MIN_DISCOUNT_BPS || rate > MAX_DISCOUNT_BPS) {
    throw new ILNError.InvalidDiscountRate(
      `Discount rate must be between ${MIN_DISCOUNT_BPS} and ${MAX_DISCOUNT_BPS} bps`
    );
  }
}
function validateDueDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new ILNError.InvalidDueDate("Due date must be a valid Date");
  }
  const delta = date.getTime() - Date.now();
  if (delta < MIN_DUE_DATE_MS) {
    throw new ILNError.DueDateTooSoon("Due date must be at least 24 hours from now");
  }
  if (delta > MAX_DUE_DATE_MS) {
    throw new ILNError.DueDateTooFar("Due date must be within 365 days from now");
  }
}

// src/signers/KeypairSigner.ts
import { Keypair as Keypair2, SorobanRpc as SorobanRpc5 } from "@stellar/stellar-sdk";
function isTestEnvironment() {
  return process.env["NODE_ENV"] === "test" || process.env["JEST_WORKER_ID"] !== void 0 || process.env["VITEST"] !== void 0;
}
function warnIfHardcodedSecret(secret) {
  if (isTestEnvironment()) return;
  const knownExamples = /* @__PURE__ */ new Set([
    "SBQM45DNQRUNKDBPTXCAT7CRQLJHOD2NVEP2EKUND7HM7GFCBFTAY2EZ",
    "SDASDASDASDASDASDASDASDASDASDASDASDASDASDASDASDASDA"
  ]);
  if (knownExamples.has(secret)) {
    console.warn(
      "[KeypairSigner] WARNING: You appear to be using a well-known example secret key. Never use example keys in production."
    );
    return;
  }
  console.warn(
    "[KeypairSigner] WARNING: Passing a secret key as a plain string is risky. Load it from an environment variable instead: new KeypairSigner(process.env.SECRET_KEY!)"
  );
}
var KeypairSigner = class _KeypairSigner {
  /**
   * @param keypairOrSecret - A `Keypair` instance **or** a Stellar secret key
   *   string starting with `S`. When a plain string is supplied outside of a
   *   test environment a security warning is emitted.
   */
  constructor(keypairOrSecret) {
    if (typeof keypairOrSecret === "string") {
      warnIfHardcodedSecret(keypairOrSecret);
      this._keypair = Keypair2.fromSecret(keypairOrSecret);
    } else {
      this._keypair = keypairOrSecret;
    }
  }
  // --------------------------------------------------------------------------
  // ISigner
  // --------------------------------------------------------------------------
  /** Stellar G… public key of this signer. */
  get publicKey() {
    return this._keypair.publicKey();
  }
  /**
   * Simulate the transaction to obtain the Soroban footprint, sign the
   * prepared transaction, and return the signed XDR envelope as base-64.
   *
   * Steps:
   *   1. `server.prepareTransaction(tx)` — attaches footprint + auth entries.
   *   2. `preparedTx.sign(keypair)` — ECDSA/Ed25519 signature applied.
   *   3. Returns `preparedTx.toEnvelope().toXDR("base64")`.
   *
   * @param tx     - Unsigned transaction with at least one Soroban operation
   * @param server - Soroban RPC server used for simulation
   * @returns Signed base-64 XDR envelope ready for `server.sendTransaction()`
   *
   * @throws {Error} When Soroban simulation fails (contract error, bad auth,
   *   resource limit exceeded, etc.)
   */
  async signTransaction(tx, server) {
    const preparedTx = await server.prepareTransaction(tx);
    if (SorobanRpc5.Api.isSimulationError(preparedTx)) {
      throw new Error(
        `Soroban simulation failed: ${preparedTx.error}`
      );
    }
    preparedTx.sign(this._keypair);
    return preparedTx.toEnvelope().toXDR("base64");
  }
  // --------------------------------------------------------------------------
  // Convenience
  // --------------------------------------------------------------------------
  /**
   * Expose the underlying keypair for use-cases that need raw sign/verify
   * access (e.g. building multi-sig transactions).
   *
   * Treat the returned keypair as read-only; do not call `keypair.sign()`
   * directly on transaction envelopes — use `signTransaction()` so the
   * simulation step is always executed.
   */
  get keypair() {
    return this._keypair;
  }
  /**
   * Create a KeypairSigner from a secret key stored in an environment
   * variable.
   *
   * ```ts
   * const signer = KeypairSigner.fromEnv("LP_SECRET_KEY");
   * ```
   *
   * @param envVar - Name of the environment variable holding the secret key
   * @throws {Error} When the environment variable is not set
   */
  static fromEnv(envVar) {
    const secret = process.env[envVar];
    if (!secret) {
      throw new Error(
        `KeypairSigner.fromEnv: environment variable "${envVar}" is not set`
      );
    }
    const kp = Keypair2.fromSecret(secret);
    return new _KeypairSigner(kp);
  }
};

// src/signers/FreighterSigner.ts
import { Networks as Networks5, SorobanRpc as SorobanRpc6 } from "@stellar/stellar-sdk";
var ILNError2 = class _ILNError2 extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ILNError";
    this.code = code;
  }
  static WalletNotInstalled() {
    return new _ILNError2(
      "WALLET_NOT_INSTALLED" /* WalletNotInstalled */,
      "Freighter is not installed. Please install the Freighter browser extension."
    );
  }
  static UserRejected() {
    return new _ILNError2(
      "USER_REJECTED" /* UserRejected */,
      "The user rejected the Freighter request."
    );
  }
  static NetworkMismatch(expected, actual) {
    return new _ILNError2(
      "NETWORK_MISMATCH" /* NetworkMismatch */,
      `Network mismatch: SDK expects "${expected}" but Freighter is on "${actual}". Please switch your wallet network.`
    );
  }
  static NotConnected() {
    return new _ILNError2(
      "NOT_CONNECTED" /* NotConnected */,
      "Freighter is locked or not connected. Please unlock the extension."
    );
  }
};
var ILNErrorCode = /* @__PURE__ */ ((ILNErrorCode2) => {
  ILNErrorCode2["WalletNotInstalled"] = "WALLET_NOT_INSTALLED";
  ILNErrorCode2["UserRejected"] = "USER_REJECTED";
  ILNErrorCode2["NetworkMismatch"] = "NETWORK_MISMATCH";
  ILNErrorCode2["NotConnected"] = "NOT_CONNECTED";
  ILNErrorCode2["SigningFailed"] = "SIGNING_FAILED";
  return ILNErrorCode2;
})(ILNErrorCode || {});
var PASSPHRASE_TO_FREIGHTER = {
  [Networks5.PUBLIC]: "PUBLIC",
  [Networks5.TESTNET]: "TESTNET"
};
var FREIGHTER_TO_PASSPHRASE = {
  PUBLIC: Networks5.PUBLIC,
  TESTNET: Networks5.TESTNET,
  FUTURENET: "Test SDF Future Network ; October 2022"
};
var FreighterSigner = class {
  /**
   * @param opts.networkPassphrase - Stellar network passphrase the SDK is
   *   targeting (e.g. `Networks.TESTNET`). Used to verify Freighter's active
   *   network before signing.
   */
  constructor(opts) {
    this._publicKey = null;
    this._accessRequested = false;
    this._networkPassphrase = opts.networkPassphrase;
  }
  // --------------------------------------------------------------------------
  // ISigner
  // --------------------------------------------------------------------------
  /**
   * The Freighter account's G… public key.
   *
   * Returns an empty string `""` until `connect()` has been called
   * successfully. Use `isConnected` to check whether the public key is
   * available, or call `connect()` early (e.g. on page load) so the
   * key is populated before it's needed.
   */
  get publicKey() {
    return this._publicKey ?? "";
  }
  /**
   * Explicitly connect to Freighter, request access, and cache the public key.
   *
   * Call this early (e.g. on page load) so `publicKey` is available
   * synchronously afterwards.
   *
   * @returns The public key (G…)
   * @throws {ILNError} WalletNotInstalled | NotConnected | UserRejected | NetworkMismatch
   */
  async connect() {
    this._ensureInstalled();
    if (!await this._api().isConnected()) {
      throw ILNError2.NotConnected();
    }
    const pk = await this._api().getPublicKey();
    if (!pk || pk.length === 0) {
      throw ILNError2.UserRejected();
    }
    await this._verifyNetwork();
    this._publicKey = pk;
    this._accessRequested = true;
    return pk;
  }
  /**
   * Simulate the transaction, then sign with Freighter and return the
   * signed XDR envelope.
   *
   * Steps:
   *  1. `server.prepareTransaction(tx)` — attaches Soroban footprint
   *  2. Serialize to base-64 XDR
   *  3. Pass to Freighter's `signTransaction`
   *  4. Return the signed XDR
   *
   * @param tx     - Unsigned transaction with Soroban operations
   * @param server - Soroban RPC server for simulation
   * @returns Signed base-64 XDR envelope
   * @throws {ILNError} WalletNotInstalled | NotConnected | UserRejected | NetworkMismatch
   */
  async signTransaction(tx, server) {
    if (!this._publicKey) {
      await this.connect();
    }
    const preparedTx = await server.prepareTransaction(tx);
    if (SorobanRpc6.Api.isSimulationError(preparedTx)) {
      throw new Error(
        `Soroban simulation failed: ${preparedTx.error}`
      );
    }
    const envelopeXdr = preparedTx.toEnvelope().toXDR("base64");
    const freighterNetwork = PASSPHRASE_TO_FREIGHTER[this._networkPassphrase];
    if (!freighterNetwork) {
      throw new Error(
        `Unknown network passphrase: ${this._networkPassphrase}`
      );
    }
    let signedXdr;
    try {
      signedXdr = await this._api().signTransaction(envelopeXdr, {
        network: freighterNetwork
      });
    } catch (err) {
      throw this._classifySignError(err);
    }
    if (!signedXdr || signedXdr.length === 0) {
      throw ILNError2.UserRejected();
    }
    return signedXdr;
  }
  // --------------------------------------------------------------------------
  // Accessors
  // --------------------------------------------------------------------------
  /** The configured network passphrase. */
  get networkPassphrase() {
    return this._networkPassphrase;
  }
  /** True once `connect()` has succeeded. */
  get isConnected() {
    return this._accessRequested && this._publicKey !== null;
  }
  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------
  /** Throw if the Freighter extension isn't installed. */
  _ensureInstalled() {
    const g = globalThis;
    if (typeof g.window === "undefined" || !g.window.freighterApi) {
      throw ILNError2.WalletNotInstalled();
    }
  }
  /** Return the Freighter API object (asserts it's installed). */
  _api() {
    this._ensureInstalled();
    return globalThis.window.freighterApi;
  }
  /**
   * Compare the wallet's active network against the configured passphrase.
   * Throws `NetworkMismatch` when they diverge.
   */
  async _verifyNetwork() {
    let walletNetwork;
    try {
      walletNetwork = await this._api().getNetwork();
    } catch {
      return;
    }
    const expectedPassphrase = FREIGHTER_TO_PASSPHRASE[walletNetwork];
    if (!expectedPassphrase) return;
    if (expectedPassphrase !== this._networkPassphrase) {
      throw ILNError2.NetworkMismatch(
        this._networkPassphrase,
        expectedPassphrase
      );
    }
  }
  /** Classify a raw error from Freighter into a typed ILNError. */
  _classifySignError(err) {
    const msg = typeof err === "string" ? err : err?.message ?? "";
    const lowered = msg.toLowerCase();
    if (lowered.includes("rejected") || lowered.includes("denied") || lowered.includes("cancelled") || lowered.includes("canceled")) {
      return ILNError2.UserRejected();
    }
    if (lowered.includes("network mismatch") || lowered.includes("network") && lowered.includes("switch")) {
      return ILNError2.NetworkMismatch(this._networkPassphrase, "unknown");
    }
    return new ILNError2("SIGNING_FAILED" /* SigningFailed */, msg || "Freighter signing failed");
  }
};

// src/events/subscribe.ts
import { xdr, scValToNative as scValToNative5 } from "@stellar/stellar-sdk";
var INITIAL_BACKOFF_MS = 500;
var MAX_BACKOFF_MS = 3e4;
var BACKOFF_FACTOR = 2;
function decodeScVal(base64Xdr) {
  try {
    const scVal = xdr.ScVal.fromXDR(base64Xdr, "base64");
    return scValToNative5(scVal);
  } catch {
    return null;
  }
}
function extractEventType(topics) {
  if (!topics) return null;
  if (!topics.length) return null;
  const decoded = decodeScVal(topics[0] || "");
  if (typeof decoded === "string") return decoded;
  return null;
}
function parseContractEvent(raw) {
  const eventType = extractEventType(raw.topic);
  if (!eventType) return null;
  const topics = (raw.topic || []).slice(1).map(decodeScVal);
  const value = decodeScVal(raw.value || "");
  const body = typeof value === "object" && value !== null ? value : {};
  const big = (v) => {
    try {
      return BigInt(String(v));
    } catch {
      return 0n;
    }
  };
  const num = (v) => Number(v ?? 0);
  const str = (v) => String(v ?? "");
  const bool = (v) => Boolean(v);
  switch (eventType) {
    case "submitted":
      return {
        timestamp: num(body["timestamp"] ?? raw.ledgerClosedAt),
        txHash: raw.txHash || "" || "",
        type: "submitted",
        invoiceId: big(topics[0] || ""),
        freelancer: str(topics[1]),
        payer: str(topics[2]),
        token: str(body["token"]),
        amount: big(body["amount"]),
        dueDate: big(body["due_date"]),
        discountRate: num(body["discount_rate"]),
        status: str(body["status"])
      };
    case "funded":
      return {
        timestamp: num(body["timestamp"] ?? raw.ledgerClosedAt),
        txHash: raw.txHash || "" || "",
        type: "funded",
        invoiceId: big(topics[0] || ""),
        funder: str(topics[1]),
        freelancer: str(body["freelancer"]),
        payer: str(body["payer"]),
        token: str(body["token"]),
        fundAmount: big(body["fund_amount"]),
        amountFunded: big(body["amount_funded"]),
        invoiceAmount: big(body["invoice_amount"]),
        dueDate: big(body["due_date"]),
        discountRate: num(body["discount_rate"]),
        fundedAt: body["funded_at"] != null ? big(body["funded_at"]) : null,
        status: str(body["status"]),
        lp: str(body["lp"]),
        effectiveYieldBps: num(body["effective_yield_bps"])
      };
    case "paid":
      return {
        timestamp: num(body["timestamp"] ?? raw.ledgerClosedAt),
        txHash: raw.txHash || "" || "",
        type: "paid",
        invoiceId: big(topics[0] || ""),
        payer: str(topics[1]),
        lp: str(topics[2]),
        freelancer: str(body["freelancer"]),
        token: str(body["token"]),
        amountPaid: big(body["amount_paid"]),
        lpEarned: big(body["lp_earned"]),
        lpPayout: big(body["lp_payout"]),
        settlementTimestamp: big(body["settlement_timestamp"]),
        paidOnTime: bool(body["paid_on_time"]),
        status: str(body["status"])
      };
    case "partially_paid":
      return {
        timestamp: num(body["timestamp"] ?? raw.ledgerClosedAt),
        txHash: raw.txHash || "" || "",
        type: "partially_paid",
        invoiceId: big(topics[0] || ""),
        payer: str(topics[1]),
        amountPaidNow: big(body["amount_paid_now"]),
        totalAmountPaid: big(body["total_amount_paid"]),
        remainingAmount: big(body["remaining_amount"])
      };
    case "defaulted":
      return {
        timestamp: num(body["timestamp"] ?? raw.ledgerClosedAt),
        txHash: raw.txHash || "" || "",
        type: "defaulted",
        invoiceId: big(topics[0] || ""),
        funder: str(topics[1]),
        freelancer: str(body["freelancer"]),
        payer: str(body["payer"]),
        token: str(body["token"]),
        amount: big(body["amount"]),
        dueDate: big(body["due_date"]),
        defaultedAt: big(body["defaulted_at"]),
        discountAmount: big(body["discount_amount"]),
        status: str(body["status"])
      };
    case "default_appealed":
    case "appealed":
      return {
        timestamp: num(body["timestamp"] ?? raw.ledgerClosedAt),
        txHash: raw.txHash || "" || "",
        type: "appealed",
        invoiceId: big(topics[0] || ""),
        payer: str(topics[1]),
        evidenceHash: str(body["evidence_hash"]),
        appealedAt: big(body["appealed_at"])
      };
    case "appeal_resolved":
      return {
        timestamp: num(body["timestamp"] ?? raw.ledgerClosedAt),
        txHash: raw.txHash || "" || "",
        type: "appeal_resolved",
        invoiceId: big(topics[0] || ""),
        payer: str(topics[1]),
        upheld: bool(body["upheld"]),
        resolvedAt: big(body["resolved_at"])
      };
    case "disputed":
      return {
        timestamp: num(body["timestamp"] ?? raw.ledgerClosedAt),
        txHash: raw.txHash || "" || "",
        type: "disputed",
        invoiceId: big(topics[0] || ""),
        payer: str(topics[1]),
        reasonHash: str(body["reason_hash"]),
        disputedAt: big(body["disputed_at"])
      };
    case "dispute_resolved":
      return {
        timestamp: num(body["timestamp"] ?? raw.ledgerClosedAt),
        txHash: raw.txHash || "" || "",
        type: "dispute_resolved",
        invoiceId: big(topics[0] || ""),
        resolutionHash: str(topics[1]),
        resolution: num(body["resolution"]),
        resolvedAt: big(body["resolved_at"])
      };
    case "token_added":
      return {
        timestamp: num(body["timestamp"] ?? raw.ledgerClosedAt),
        txHash: raw.txHash || "" || "",
        type: "token_added",
        token: str(topics[0] || ""),
        decimals: num(body["decimals"])
      };
    case "token_removed":
      return {
        timestamp: num(body["timestamp"] ?? raw.ledgerClosedAt),
        txHash: raw.txHash || "" || "",
        type: "token_removed",
        token: str(topics[0])
      };
    case "transferred":
      return {
        timestamp: num(body["timestamp"] ?? raw.ledgerClosedAt),
        txHash: raw.txHash || "" || "",
        type: "transferred",
        invoiceId: big(topics[0] || ""),
        oldFreelancer: str(body["old_freelancer"]),
        newFreelancer: str(body["new_freelancer"]),
        status: str(body["status"])
      };
    case "cancelled":
      return {
        timestamp: num(body["timestamp"] ?? raw.ledgerClosedAt),
        txHash: raw.txHash || "" || "",
        type: "cancelled",
        invoiceId: big(topics[0] || ""),
        freelancer: str(body["freelancer"]),
        status: str(body["status"])
      };
    case "paused":
      return { txHash: raw.txHash || "", type: "paused", timestamp: num(body["timestamp"]) };
    case "unpaused":
      return { txHash: raw.txHash || "", type: "unpaused", timestamp: num(body["timestamp"]) };
    case "upgraded":
      return {
        timestamp: num(body["timestamp"] ?? raw.ledgerClosedAt),
        txHash: raw.txHash || "" || "",
        type: "upgraded",
        admin: str(topics[0] || ""),
        newWasmHash: str(body["new_wasm_hash"])
      };
    case "admin_changed":
      return {
        timestamp: num(body["timestamp"] ?? raw.ledgerClosedAt),
        txHash: raw.txHash || "" || "",
        type: "admin_changed",
        oldAdmin: str(body["old_admin"]),
        newAdmin: str(body["new_admin"])
      };
    case "parameter_updated":
      return {
        timestamp: num(body["timestamp"] ?? raw.ledgerClosedAt),
        txHash: raw.txHash || "" || "",
        type: "parameter_updated",
        paramName: str(topics[0]),
        oldValue: big(body["old_value"]),
        newValue: big(body["new_value"]),
        updatedBy: str(body["updated_by"])
      };
    case "fund_requested":
      return {
        timestamp: num(body["timestamp"] ?? raw.ledgerClosedAt),
        txHash: raw.txHash || "" || "",
        type: "fund_requested",
        invoiceId: big(topics[0] || ""),
        lp: str(topics[1]),
        score: num(body["score"])
      };
    case "fund_queue_resolved":
      return {
        timestamp: num(body["timestamp"] ?? raw.ledgerClosedAt),
        txHash: raw.txHash || "" || "",
        type: "fund_queue_resolved",
        invoiceId: big(topics[0] || ""),
        approvedLp: str(topics[1]),
        score: num(body["score"])
      };
    default:
      return null;
  }
}
function matchesFilter(event, filter) {
  if (filter.types?.length && !filter.types.includes(event.type)) {
    return false;
  }
  if (filter.invoiceId !== void 0) {
    const id = event["invoiceId"];
    if (id === void 0 || BigInt(String(id)) !== filter.invoiceId) return false;
  }
  if (filter.address !== void 0) {
    const addr = filter.address.toLowerCase();
    const values = Object.values(event);
    const found = values.some(
      (v) => typeof v === "string" && v.toLowerCase() === addr
    );
    if (!found) return false;
  }
  return true;
}
function subscribe(horizon, contractId, filter, handler, onError) {
  let stopped = false;
  let reconnectTimer = null;
  let closeStream = null;
  let backoffMs = INITIAL_BACKOFF_MS;
  function connect() {
    if (stopped) return;
    try {
      const builder = horizon.contractEvents().forContract(contractId).limit(200);
      closeStream = builder.stream({
        onmessage(raw) {
          if (stopped) return;
          try {
            const event = parseContractEvent(raw);
            if (event && matchesFilter(event, filter)) {
              handler(event);
            }
          } catch (parseErr) {
            onError?.(parseErr);
          }
        },
        onerror(err) {
          if (stopped) return;
          onError?.(err);
          closeStream?.();
          closeStream = null;
          scheduleReconnect();
        }
      });
      backoffMs = INITIAL_BACKOFF_MS;
    } catch (err) {
      onError?.(err);
      scheduleReconnect();
    }
  }
  function scheduleReconnect() {
    if (stopped) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoffMs);
    backoffMs = Math.min(backoffMs * BACKOFF_FACTOR, MAX_BACKOFF_MS);
  }
  connect();
  return function unsubscribe() {
    stopped = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    closeStream?.();
    closeStream = null;
  };
}

// src/client.ts
import { SorobanRpc as SorobanRpc7 } from "@stellar/stellar-sdk";
var TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
var MAINNET_RPC_URL = "https://soroban.stellar.org";
var ILNClient = class _ILNClient {
  constructor(config) {
    this.rpc = new SorobanRpc7.Server(config.rpcUrl);
    this.networkPassphrase = config.networkPassphrase;
    this.contractId = config.contractId;
    this.signer = config.signer;
  }
  // --------------------------------------------------------------------------
  // Factory methods
  // --------------------------------------------------------------------------
  /**
   * Create a client pre-configured for Stellar Testnet.
   *
   * @param signer   - Optional signer for authenticated methods
   * @param options  - Override defaults (rpcUrl, contractId)
   *
   * @example
   * ```ts
   * const client = ILNClient.testnet(freighterSigner);
   * ```
   */
  static testnet(signer, options) {
    return new _ILNClient({
      rpcUrl: options?.rpcUrl ?? TESTNET_RPC_URL,
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: options?.contractId ?? // Published testnet deployment: the canonical contract ID from
      // the latest testnet CI/CD deployment. Update here when redeploying.
      "CCVXGPKFAN374T62PLZAHWIS4UKUVTOYRD72HT36SGWWX7LRD5VFUUJD",
      ...signer ? { signer } : {}
    });
  }
  /**
   * Create a client pre-configured for Stellar Mainnet (Pubnet).
   *
   * @param signer   - Optional signer for authenticated methods
   * @param options  - Override defaults (rpcUrl, contractId)
   *
   * @example
   * ```ts
   * const client = ILNClient.mainnet(freighterSigner);
   * ```
   */
  static mainnet(signer, options) {
    return new _ILNClient({
      rpcUrl: options?.rpcUrl ?? MAINNET_RPC_URL,
      networkPassphrase: "Public Global Stellar Network ; September 2015",
      contractId: options?.contractId ?? // TODO: replace with actual mainnet contract ID after mainnet deployment
      "",
      ...signer ? { signer } : {}
    });
  }
  /**
   * Create a client with fully custom configuration.
   *
   * Use this for local development (standalone network), Futurenet, or
   * private Stellar deployments.
   *
   * @param config - Full ILNClientConfig
   */
  static custom(config) {
    return new _ILNClient(config);
  }
  // --------------------------------------------------------------------------
  // Methods
  // --------------------------------------------------------------------------
  /**
   * Fetch the detailed reputation profile for an address.
   *
   * Read-only; does not require a signer.
   *
   * @param address - Stellar G… address to query
   * @returns ReputationProfile (zeroed for unknown addresses)
   */
  async getReputation(address) {
    if (!this._getReputation) {
      this._getReputation = (await Promise.resolve().then(() => (init_reputation(), reputation_exports))).getReputation;
    }
    return this._getReputation(this.rpc, this.contractId, address, this.networkPassphrase);
  }
  /**
   * Fetch protocol-wide statistics.
   *
   * Read-only; does not require a signer.
   *
   * @returns ContractStats
   */
  async getContractStats() {
    if (!this._getContractStats) {
      this._getContractStats = (await Promise.resolve().then(() => (init_stats(), stats_exports))).getContractStats;
    }
    return this._getContractStats(this.rpc, this.contractId, this.networkPassphrase);
  }
};
var ILNSingleton = class {
  constructor() {
    this._client = null;
  }
  configure(config) {
    this._client = new ILNClient(config);
  }
  /** Access the underlying client. Throws if not configured. */
  get client() {
    if (!this._client) {
      throw new Error(
        "ILN singleton not configured. Call iln.configure({...}) first."
      );
    }
    return this._client;
  }
  async getReputation(address) {
    return this.client.getReputation(address);
  }
  async getContractStats() {
    return this.client.getContractStats();
  }
};
var iln = new ILNSingleton();

// src/methods/queries.ts
import {
  Contract as Contract5,
  SorobanRpc as SorobanRpc8,
  TransactionBuilder as TransactionBuilder5,
  BASE_FEE as BASE_FEE5,
  scValToNative as scValToNative6,
  nativeToScVal as nativeToScVal3
} from "@stellar/stellar-sdk";
init_xdrDecoder();
init_retry();
async function getInvoice(server, contractAddress, invoiceId, sourceAccount, networkPassphrase) {
  const contract = new Contract5(contractAddress);
  const op = contract.call(
    "get_invoice",
    nativeToScVal3(invoiceId, { type: "u64" })
  );
  const tx = new TransactionBuilder5(sourceAccount, {
    fee: BASE_FEE5,
    networkPassphrase
  }).addOperation(op).setTimeout(30).build();
  const sim = await retry(() => server.simulateTransaction(tx));
  if (SorobanRpc8.Api.isSimulationError(sim)) {
    if (String(sim.error).includes("NotFound") || String(sim.error).includes("Error(Contract, 1)")) {
      throw new ILNError.InvoiceNotFound(`Invoice ${invoiceId} not found`);
    }
    throw ILNError.fromError(sim.error);
  }
  if (!sim.result?.retval) {
    throw new ILNError.InvoiceNotFound(`Invoice ${invoiceId} not found`);
  }
  const raw = scValToNative6(sim.result.retval);
  return decodeInvoice(raw);
}
async function listInvoicesBySubmitter(server, contractAddress, submitter, sourceAccount, networkPassphrase, page = 0, pageSize = 50) {
  const contract = new Contract5(contractAddress);
  const op = contract.call(
    "list_invoices_by_submitter",
    nativeToScVal3(submitter, { type: "address" }),
    nativeToScVal3(page, { type: "u32" }),
    nativeToScVal3(pageSize, { type: "u32" })
  );
  const tx = new TransactionBuilder5(sourceAccount, {
    fee: BASE_FEE5,
    networkPassphrase
  }).addOperation(op).setTimeout(30).build();
  const sim = await retry(() => server.simulateTransaction(tx));
  if (SorobanRpc8.Api.isSimulationError(sim)) {
    throw ILNError.fromError(sim.error);
  }
  if (!sim.result?.retval) {
    return [];
  }
  const rawArr = scValToNative6(sim.result.retval);
  return rawArr.map((raw) => decodeInvoice(raw));
}
async function listInvoicesByLP(server, contractAddress, lp, sourceAccount, networkPassphrase, page = 0, pageSize = 50) {
  const contract = new Contract5(contractAddress);
  const op = contract.call(
    "list_invoices_by_lp",
    nativeToScVal3(lp, { type: "address" }),
    nativeToScVal3(page, { type: "u32" }),
    nativeToScVal3(pageSize, { type: "u32" })
  );
  const tx = new TransactionBuilder5(sourceAccount, {
    fee: BASE_FEE5,
    networkPassphrase
  }).addOperation(op).setTimeout(30).build();
  const sim = await retry(() => server.simulateTransaction(tx));
  if (SorobanRpc8.Api.isSimulationError(sim)) {
    throw ILNError.fromError(sim.error);
  }
  if (!sim.result?.retval) {
    return [];
  }
  const rawArr = scValToNative6(sim.result.retval);
  return rawArr.map((raw) => decodeInvoice(raw));
}

// src/methods/submitInvoice.ts
import {
  Contract as Contract6,
  SorobanRpc as SorobanRpc9,
  TransactionBuilder as TransactionBuilder6,
  BASE_FEE as BASE_FEE6,
  nativeToScVal as nativeToScVal4,
  scValToNative as scValToNative7,
  xdr as xdr2
} from "@stellar/stellar-sdk";
init_retry();
async function submitInvoice(server, contractAddress, params, sourceAccount, signTransaction, networkPassphrase) {
  if (params.amount <= 0n) {
    throw new ILNError.InvalidAmount("Invoice amount must be greater than 0");
  }
  validateDiscountRate(params.discountRate);
  const dueDateUnix = params.dueDate instanceof Date ? Math.floor(params.dueDate.getTime() / 1e3) : params.dueDate;
  const nowUnix = Math.floor(Date.now() / 1e3);
  const minDuration = 24 * 60 * 60;
  const maxDuration = 365 * 24 * 60 * 60;
  if (dueDateUnix < nowUnix + minDuration) {
    throw new ILNError.DueDateTooSoon("Due date is too soon (minimum 24 hours)");
  }
  if (dueDateUnix > nowUnix + maxDuration) {
    throw new ILNError.DueDateTooFar("Due date is too far (maximum 365 days)");
  }
  validateGAddress(params.payer);
  const contract = new Contract6(contractAddress);
  const submitterAddress = sourceAccount.accountId();
  const tokenArg = nativeToScVal4(params.token, { type: "address" });
  let refArg;
  if (params.referralCode) {
    const refBuffer = Buffer.from(params.referralCode, "hex");
    refArg = xdr2.ScVal.scvVec([
      xdr2.ScVal.scvU32(1),
      nativeToScVal4(refBuffer, { type: "bytes" })
    ]);
  } else {
    refArg = xdr2.ScVal.scvVec([
      xdr2.ScVal.scvU32(0),
      xdr2.ScVal.scvVoid()
    ]);
  }
  const op = contract.call(
    "submit_invoice",
    nativeToScVal4(submitterAddress, { type: "address" }),
    nativeToScVal4(params.payer, { type: "address" }),
    nativeToScVal4(params.amount, { type: "i128" }),
    nativeToScVal4(dueDateUnix, { type: "u64" }),
    nativeToScVal4(params.discountRate, { type: "u32" }),
    tokenArg,
    refArg
  );
  const tx = new TransactionBuilder6(sourceAccount, {
    fee: BASE_FEE6,
    networkPassphrase
  }).addOperation(op).setTimeout(30).build();
  const sim = await retry(() => server.simulateTransaction(tx));
  if (SorobanRpc9.Api.isSimulationError(sim)) {
    throw ILNError.fromError(sim.error);
  }
  const assembledTx = SorobanRpc9.assembleTransaction(tx, sim).build();
  const signedTx = await signTransaction(assembledTx);
  const sendResult = await retry(() => server.sendTransaction(signedTx));
  if (sendResult.errorResult) {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }
  let status = await retry(() => server.getTransaction(sendResult.hash));
  let retries = 0;
  while (status.status === SorobanRpc9.Api.GetTransactionStatus.NOT_FOUND && retries < 15) {
    await new Promise((r) => setTimeout(r, 2e3));
    status = await retry(() => server.getTransaction(sendResult.hash));
    retries++;
  }
  if (status.status === SorobanRpc9.Api.GetTransactionStatus.FAILED) {
    throw new Error("Transaction failed during execution");
  }
  let invoiceId = 0n;
  if (status.status === SorobanRpc9.Api.GetTransactionStatus.SUCCESS && status.returnValue) {
    invoiceId = BigInt(String(scValToNative7(status.returnValue)));
  }
  return { invoiceId, txHash: sendResult.hash };
}

// src/methods/transferLPPosition.ts
import {
  Contract as Contract7,
  SorobanRpc as SorobanRpc10,
  TransactionBuilder as TransactionBuilder7,
  BASE_FEE as BASE_FEE7,
  nativeToScVal as nativeToScVal5
} from "@stellar/stellar-sdk";
async function transferLPPosition(server, contractAddress, invoiceId, newLP, sourceAccount, signTransaction, networkPassphrase) {
  validateGAddress(newLP);
  const currentLP = sourceAccount.accountId();
  if (newLP === currentLP) {
    throw new ILNError.InvalidTransfer(
      "New LP must be different from the current LP"
    );
  }
  const contract = new Contract7(contractAddress);
  const op = contract.call(
    "transfer_lp_position",
    nativeToScVal5(invoiceId, { type: "u64" }),
    nativeToScVal5(currentLP, { type: "address" }),
    nativeToScVal5(newLP, { type: "address" })
  );
  const tx = new TransactionBuilder7(sourceAccount, {
    fee: BASE_FEE7,
    networkPassphrase
  }).addOperation(op).setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc10.Api.isSimulationError(sim)) {
    throw ILNError.fromError(sim.error);
  }
  const assembledTx = SorobanRpc10.assembleTransaction(tx, sim).build();
  const signedTx = await signTransaction(assembledTx);
  const sendResult = await server.sendTransaction(signedTx);
  if (sendResult.errorResult) {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }
  let status = await server.getTransaction(sendResult.hash);
  let retries = 0;
  while (status.status === SorobanRpc10.Api.GetTransactionStatus.NOT_FOUND && retries < 15) {
    await new Promise((r) => setTimeout(r, 2e3));
    status = await server.getTransaction(sendResult.hash);
    retries++;
  }
  if (status.status === SorobanRpc10.Api.GetTransactionStatus.FAILED) {
    throw new Error("Transaction failed during execution");
  }
  return { txHash: sendResult.hash };
}

// src/methods/cancelInvoice.ts
import {
  Contract as Contract8,
  SorobanRpc as SorobanRpc11,
  TransactionBuilder as TransactionBuilder8,
  BASE_FEE as BASE_FEE8,
  nativeToScVal as nativeToScVal6
} from "@stellar/stellar-sdk";
init_retry();
async function cancelInvoice(server, contractAddress, invoiceId, sourceAccount, signTransaction, networkPassphrase) {
  const invoice = await getInvoice(
    server,
    contractAddress,
    invoiceId,
    sourceAccount,
    networkPassphrase
  );
  if (invoice.status !== "Pending") {
    throw new ILNError.InvoiceNotCancellable(`Invoice is in ${invoice.status} state, not Pending`);
  }
  const submitterAddress = sourceAccount.accountId();
  if (invoice.freelancer !== submitterAddress) {
    throw new ILNError.Unauthorized("Only the invoice submitter can cancel it");
  }
  const contract = new Contract8(contractAddress);
  const op = contract.call(
    "cancel_invoice",
    nativeToScVal6(submitterAddress, { type: "address" }),
    nativeToScVal6(invoiceId, { type: "u64" })
  );
  const tx = new TransactionBuilder8(sourceAccount, {
    fee: BASE_FEE8,
    networkPassphrase
  }).addOperation(op).setTimeout(30).build();
  const sim = await retry(() => server.simulateTransaction(tx));
  if (SorobanRpc11.Api.isSimulationError(sim)) {
    throw ILNError.fromError(sim.error);
  }
  const assembledTx = SorobanRpc11.assembleTransaction(tx, sim).build();
  const signedTx = await signTransaction(assembledTx);
  const sendResult = await retry(() => server.sendTransaction(signedTx));
  if (sendResult.errorResult) {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }
  let status = await retry(() => server.getTransaction(sendResult.hash));
  let retries = 0;
  while (status.status === SorobanRpc11.Api.GetTransactionStatus.NOT_FOUND && retries < 15) {
    await new Promise((r) => setTimeout(r, 2e3));
    status = await retry(() => server.getTransaction(sendResult.hash));
    retries++;
  }
  if (status.status === SorobanRpc11.Api.GetTransactionStatus.FAILED) {
    throw new Error("Transaction failed during execution");
  }
  return { txHash: sendResult.hash };
}

// src/methods/markPaid.ts
import {
  Contract as Contract9,
  SorobanRpc as SorobanRpc12,
  TransactionBuilder as TransactionBuilder9,
  BASE_FEE as BASE_FEE9,
  nativeToScVal as nativeToScVal7
} from "@stellar/stellar-sdk";
init_retry();
async function markPaid(server, contractAddress, invoiceId, amount, sourceAccount, signTransaction, networkPassphrase) {
  const invoice = await getInvoice(server, contractAddress, invoiceId, sourceAccount, networkPassphrase);
  const outstanding = invoice.amount - invoice.amountPaid;
  const paymentAmount = amount !== void 0 ? amount : outstanding;
  if (paymentAmount <= 0n) {
    throw new ILNError.InsufficientAmount("Payment amount must be greater than 0");
  }
  if (paymentAmount > outstanding) {
    throw new ILNError.InsufficientAmount("Payment amount exceeds outstanding balance");
  }
  const contract = new Contract9(contractAddress);
  const payerAddress = sourceAccount.accountId();
  const op = contract.call(
    "mark_paid",
    nativeToScVal7(invoiceId, { type: "u64" }),
    nativeToScVal7(payerAddress, { type: "address" }),
    nativeToScVal7(paymentAmount, { type: "i128" })
  );
  const tx = new TransactionBuilder9(sourceAccount, {
    fee: BASE_FEE9,
    networkPassphrase
  }).addOperation(op).setTimeout(30).build();
  const sim = await retry(() => server.simulateTransaction(tx));
  if (SorobanRpc12.Api.isSimulationError(sim)) {
    throw ILNError.fromError(sim.error);
  }
  const assembledTx = SorobanRpc12.assembleTransaction(tx, sim).build();
  const signedTx = await signTransaction(assembledTx);
  const sendResult = await retry(() => server.sendTransaction(signedTx));
  if (sendResult.errorResult) {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }
  let status = await retry(() => server.getTransaction(sendResult.hash));
  let retries = 0;
  while (status.status === SorobanRpc12.Api.GetTransactionStatus.NOT_FOUND && retries < 15) {
    await new Promise((r) => setTimeout(r, 2e3));
    status = await retry(() => server.getTransaction(sendResult.hash));
    retries++;
  }
  if (status.status === SorobanRpc12.Api.GetTransactionStatus.FAILED) {
    throw new Error("Transaction failed during execution");
  }
  const remainingBalance = outstanding - paymentAmount;
  return {
    txHash: sendResult.hash,
    remainingBalance,
    fullySettled: remainingBalance === 0n
  };
}

// src/methods/governance.ts
import {
  Contract as Contract10,
  SorobanRpc as SorobanRpc13,
  TransactionBuilder as TransactionBuilder10,
  BASE_FEE as BASE_FEE10,
  nativeToScVal as nativeToScVal8,
  scValToNative as scValToNative8
} from "@stellar/stellar-sdk";

// src/types/governance.ts
import { ProposalAction, ProposalStatus } from "@invoice-liquidity/types";

// src/methods/governance.ts
init_retry();
init_xdrDecoder();
async function sendGovernanceCall(server, sourceAccount, networkPassphrase, op, signTransaction) {
  const tx = new TransactionBuilder10(sourceAccount, {
    fee: BASE_FEE10,
    networkPassphrase
  }).addOperation(op).setTimeout(30).build();
  const sim = await retry(() => server.simulateTransaction(tx));
  if (SorobanRpc13.Api.isSimulationError(sim)) {
    throw ILNError.fromError(sim.error);
  }
  const assembledTx = SorobanRpc13.assembleTransaction(tx, sim).build();
  const signedTx = await signTransaction(assembledTx);
  const sendResult = await retry(() => server.sendTransaction(signedTx));
  if (sendResult.errorResult) {
    throw new Error(`Transaction failed: ${sendResult.errorResult}`);
  }
  let status = await retry(() => server.getTransaction(sendResult.hash));
  let retries = 0;
  while (status.status === SorobanRpc13.Api.GetTransactionStatus.NOT_FOUND && retries < 15) {
    await new Promise((r) => setTimeout(r, 2e3));
    status = await retry(() => server.getTransaction(sendResult.hash));
    retries++;
  }
  if (status.status === SorobanRpc13.Api.GetTransactionStatus.FAILED) {
    throw new Error("Transaction failed during execution");
  }
  const returnValue = status.status === SorobanRpc13.Api.GetTransactionStatus.SUCCESS && status.returnValue ? scValToNative8(status.returnValue) : void 0;
  return { txHash: sendResult.hash, returnValue };
}
async function createProposal(server, contractAddress, action, proposedValue, descriptionHash, sourceAccount, signTransaction, networkPassphrase) {
  const contract = new Contract10(contractAddress);
  const op = contract.call(
    "create_proposal",
    nativeToScVal8(sourceAccount.accountId(), { type: "address" }),
    nativeToScVal8(action, { type: "u32" }),
    nativeToScVal8(proposedValue, { type: "i128" }),
    nativeToScVal8(Buffer.from(descriptionHash, "hex"), { type: "bytes" })
  );
  const { txHash, returnValue } = await sendGovernanceCall(
    server,
    sourceAccount,
    networkPassphrase,
    op,
    signTransaction
  );
  return {
    proposalId: returnValue !== void 0 ? BigInt(String(returnValue)) : 0n,
    txHash
  };
}
async function castVote(server, contractAddress, proposalId, support, sourceAccount, signTransaction, networkPassphrase) {
  const contract = new Contract10(contractAddress);
  const op = contract.call(
    "cast_vote",
    nativeToScVal8(sourceAccount.accountId(), { type: "address" }),
    nativeToScVal8(proposalId, { type: "u64" }),
    nativeToScVal8(support, { type: "bool" })
  );
  const { txHash } = await sendGovernanceCall(
    server,
    sourceAccount,
    networkPassphrase,
    op,
    signTransaction
  );
  return { txHash };
}
async function executeProposal(server, contractAddress, proposalId, sourceAccount, signTransaction, networkPassphrase) {
  const contract = new Contract10(contractAddress);
  const op = contract.call(
    "execute_proposal",
    nativeToScVal8(sourceAccount.accountId(), { type: "address" }),
    nativeToScVal8(proposalId, { type: "u64" })
  );
  const { txHash } = await sendGovernanceCall(
    server,
    sourceAccount,
    networkPassphrase,
    op,
    signTransaction
  );
  return { txHash };
}
async function getProposal(server, contractAddress, id, sourceAccount, networkPassphrase) {
  const contract = new Contract10(contractAddress);
  const op = contract.call("get_proposal", nativeToScVal8(id, { type: "u64" }));
  const tx = new TransactionBuilder10(sourceAccount, {
    fee: BASE_FEE10,
    networkPassphrase
  }).addOperation(op).setTimeout(30).build();
  const sim = await retry(() => server.simulateTransaction(tx));
  if (SorobanRpc13.Api.isSimulationError(sim)) {
    throw ILNError.fromError(sim.error);
  }
  if (!sim.result?.retval) {
    throw new ILNError(`Proposal ${id} not found`);
  }
  const raw = scValToNative8(sim.result.retval);
  return decodeGovernanceProposal(raw);
}
async function listProposals(server, contractAddress, sourceAccount, networkPassphrase, filter) {
  const contract = new Contract10(contractAddress);
  const op = contract.call("list_proposals");
  const tx = new TransactionBuilder10(sourceAccount, {
    fee: BASE_FEE10,
    networkPassphrase
  }).addOperation(op).setTimeout(30).build();
  const sim = await retry(() => server.simulateTransaction(tx));
  if (SorobanRpc13.Api.isSimulationError(sim)) {
    throw ILNError.fromError(sim.error);
  }
  if (!sim.result?.retval) {
    return [];
  }
  const rawArr = scValToNative8(sim.result.retval);
  let proposals = rawArr.map((raw) => decodeGovernanceProposal(raw));
  if (filter?.status) {
    proposals = proposals.filter((p) => p.status === filter.status);
  }
  if (filter?.proposer) {
    proposals = proposals.filter((p) => p.proposer === filter.proposer);
  }
  return proposals;
}

// src/methods/disputeInvoice.ts
init_retry();
import { Contract as Contract11, xdr as xdr3 } from "@stellar/stellar-sdk";
async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  if (typeof process !== "undefined" && process.versions?.node) {
    const { createHash } = await import("crypto");
    return createHash("sha256").update(bytes).digest("hex");
  }
  const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function disputeInvoice(params) {
  const { rpc, contractAddress, signer, invoiceId, evidence, fee = 100 } = params;
  const evidenceHash = await sha256Hex(evidence);
  const hashBytes = Buffer.from(evidenceHash, "hex");
  const contract = new Contract11(contractAddress);
  const operation = contract.call(
    "dispute_invoice",
    xdr3.ScVal.scvU64(xdr3.Uint64.fromString(invoiceId.toString())),
    xdr3.ScVal.scvBytes(hashBytes)
  );
  const account = await retry(() => rpc.getAccount(signer.publicKey));
  const { TransactionBuilder: TransactionBuilder12 } = await import("@stellar/stellar-sdk");
  const networkPassphrase = (await rpc.getNetwork()).passphrase;
  const built = await retry(() => rpc.prepareTransaction(
    new TransactionBuilder12(account, {
      fee: String(fee),
      networkPassphrase
    }).addOperation(operation).setTimeout(30).build()
  ));
  const signed = await signer.signTransaction(built, rpc);
  const response = await retry(() => rpc.sendTransaction(signed));
  return { txHash: response.hash, evidenceHash };
}

// src/utils/tokenRegistry.ts
var REGISTRY = {
  testnet: {
    USDC: {
      symbol: "USDC",
      contractAddress: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      decimals: 7,
      minimumAmount: 1000000n
      // 0.1 USDC
    },
    EURC: {
      symbol: "EURC",
      contractAddress: "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO575XC74F3X6U",
      decimals: 7,
      minimumAmount: 1000000n
    },
    XLM: {
      symbol: "XLM",
      contractAddress: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      decimals: 7,
      minimumAmount: 10000000n
      // 1 XLM
    }
  },
  mainnet: {
    USDC: {
      symbol: "USDC",
      contractAddress: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
      decimals: 7,
      minimumAmount: 1000000n
    },
    EURC: {
      symbol: "EURC",
      contractAddress: "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV",
      decimals: 7,
      minimumAmount: 1000000n
    },
    XLM: {
      symbol: "XLM",
      contractAddress: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
      decimals: 7,
      minimumAmount: 10000000n
    }
  }
};
var TokenRegistry = class {
  constructor(network = "testnet") {
    this.network = network;
  }
  /**
   * Look up a token by symbol.
   * @throws {Error} when the symbol is not found for the current network.
   */
  get(symbol) {
    const entry = REGISTRY[this.network][symbol.toUpperCase()];
    if (!entry) {
      throw new Error(
        `Token "${symbol}" is not registered for network "${this.network}". Supported: ${Object.keys(REGISTRY[this.network]).join(", ")}`
      );
    }
    return entry;
  }
  /** Returns all registered tokens for the current network. */
  list() {
    return Object.values(REGISTRY[this.network]);
  }
  /**
   * Register a custom token at runtime (e.g. project-specific SAC tokens).
   * Custom entries override built-ins for the same symbol.
   */
  register(info) {
    REGISTRY[this.network][info.symbol.toUpperCase()] = info;
  }
  /**
   * Convert a human-readable amount to base units.
   * @example registry.toBaseUnits("USDC", 10.5) // 105_000_000n
   */
  toBaseUnits(symbol, humanAmount) {
    const { decimals } = this.get(symbol);
    return BigInt(Math.round(humanAmount * 10 ** decimals));
  }
  /**
   * Convert base units back to a human-readable number.
   * @example registry.fromBaseUnits("USDC", 105_000_000n) // 10.5
   */
  fromBaseUnits(symbol, baseAmount) {
    const { decimals } = this.get(symbol);
    return Number(baseAmount) / 10 ** decimals;
  }
};
var tokenRegistry = new TokenRegistry("testnet");

// src/utils/feeCalculator.ts
import {
  Contract as Contract12,
  SorobanRpc as SorobanRpc15,
  TransactionBuilder as TransactionBuilder11,
  BASE_FEE as BASE_FEE11,
  Networks as Networks6,
  Address as Address4,
  nativeToScVal as nativeToScVal9
} from "@stellar/stellar-sdk";
var STROOPS_PER_XLM = 10000000n;
async function estimateFee(operation, server, sourceAccount, networkPassphrase = Networks6.TESTNET, options = {}) {
  const { feeBuffer = 1.2 } = options;
  const tx = new TransactionBuilder11(sourceAccount, {
    fee: BASE_FEE11,
    networkPassphrase
  }).addOperation(operation).setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc15.Api.isSimulationError(sim)) {
    throw new Error(`Fee simulation failed: ${sim.error}`);
  }
  const baseFeeStroops = BigInt(sim.minResourceFee ?? "0");
  const bufferedStroops = BigInt(Math.ceil(Number(baseFeeStroops) * feeBuffer));
  const xlm = Number(bufferedStroops) / Number(STROOPS_PER_XLM);
  return {
    feeStroops: bufferedStroops,
    feeXLM: xlm.toFixed(7)
  };
}
async function estimateSubmitFee(params, server, contractAddress, sourceAccount, networkPassphrase = Networks6.TESTNET, options = {}) {
  const contract = new Contract12(contractAddress);
  const op = contract.call(
    "submit_invoice",
    new Address4(params.payer).toScVal(),
    nativeToScVal9(params.amount, { type: "i128" }),
    new Address4(params.token).toScVal(),
    nativeToScVal9(params.discountRate, { type: "u32" }),
    nativeToScVal9(params.dueDate, { type: "u64" }),
    nativeToScVal9(params.referralCode ?? null, { type: "string" })
  );
  return estimateFee(op, server, sourceAccount, networkPassphrase, options);
}
async function estimateFundFee(invoiceId, lpAddress, amount, server, contractAddress, sourceAccount, networkPassphrase = Networks6.TESTNET, options = {}) {
  const contract = new Contract12(contractAddress);
  const op = contract.call(
    "fund_invoice",
    new Address4(lpAddress).toScVal(),
    nativeToScVal9(invoiceId, { type: "u64" }),
    nativeToScVal9(amount, { type: "i128" })
  );
  return estimateFee(op, server, sourceAccount, networkPassphrase, options);
}
export {
  FreighterSigner,
  ILNClient,
  ILNError,
  ILNErrorCode,
  KeypairSigner,
  ProposalAction,
  ProposalStatus,
  TokenRegistry,
  buildApproveTransaction,
  cancelInvoice,
  castVote,
  computeEffectiveYieldBps,
  createProposal,
  disputeInvoice,
  estimateFee,
  estimateFundFee,
  estimateSubmitFee,
  executeProposal,
  fundInvoice,
  getAllowance,
  getContractStats,
  getInvoice,
  getProposal,
  getReputation,
  iln,
  isAllowanceSufficient,
  listInvoicesByLP,
  listInvoicesBySubmitter,
  listProposals,
  markPaid,
  matchesFilter,
  parseContractEvent,
  sha256Hex,
  submitInvoice,
  subscribe,
  tokenRegistry,
  transferLPPosition,
  validateAmount,
  validateContractId,
  validateDiscountRate,
  validateDueDate,
  validateGAddress
};
//# sourceMappingURL=index.js.map