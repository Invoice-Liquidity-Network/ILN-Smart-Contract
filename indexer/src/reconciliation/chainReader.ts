/**
 * Direct on-chain reads used by the reconciliation job.
 *
 * Performs read-only Soroban contract invocations (simulation only — no
 * submission, no fees) against the deployed invoice-liquidity contract so
 * indexed rows can be compared against chain truth.
 */

import {
  Account,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from '@stellar/stellar-sdk';

export interface OnChainInvoice {
  id: number;
  status: string;
  amount: string;
  amountFunded: string;
  amountPaid: string;
  funder: string | null;
}

/**
 * Public, incident-relevant protocol state from `get_protocol_status()`
 * (Issue #775). Field names mirror the on-chain `ProtocolStatus` struct.
 */
export interface OnChainProtocolStatus {
  paused: boolean;
  /** Ledger timestamp (seconds) of the most recent pause; 0 if never paused. */
  lastPauseTimestamp: number;
  admin: string;
  multisigConfigured: boolean;
  multisigThreshold: number;
  multisigSignerCount: number;
  oracleCircuitTripped: boolean;
  oracleCircuitsTripped: number;
}

export interface ChainReader {
  /** Returns null when the contract reports the invoice does not exist. */
  getInvoice(invoiceId: number): Promise<OnChainInvoice | null>;
  getInvoiceCount(): Promise<number>;
  /**
   * Reads `get_protocol_status()`; null if the contract has no such view.
   * Optional so existing `ChainReader` fakes in tests don't have to implement it.
   */
  getProtocolStatus?(): Promise<OnChainProtocolStatus | null>;
}

export interface SorobanChainReaderOptions {
  rpcUrl: string;
  contractId: string;
  networkPassphrase: string;
}

const SIMULATION_ACCOUNT = new Account('G' + '0'.repeat(55), '0');

function normalizeStatus(value: unknown): string {
  if (value && typeof value === 'object' && 'tag' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>).tag);
  }
  if (typeof value === 'string') {
    return value;
  }
  return '';
}

function normalizeAmount(value: unknown): string {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number') {
    return Math.trunc(value).toString();
  }
  return String(value ?? '0');
}

export class SorobanChainReader implements ChainReader {
  private readonly server: rpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;

  constructor(options: SorobanChainReaderOptions, server?: rpc.Server) {
    this.server =
      server ?? new rpc.Server(options.rpcUrl, { allowHttp: options.rpcUrl.startsWith('http://') });
    this.contract = new Contract(options.contractId);
    this.networkPassphrase = options.networkPassphrase;
  }

  async getInvoice(invoiceId: number): Promise<OnChainInvoice | null> {
    const raw = await this.simulate('get_invoice', nativeToScVal(BigInt(invoiceId), { type: 'u64' }));
    if (raw === null) {
      return null;
    }

    const record = raw as Record<string, unknown>;
    const funderRaw = record.funder;
    const funder =
      funderRaw === null || funderRaw === undefined || funderRaw === '' ? null : String(funderRaw);

    return {
      id: Number(record.id ?? invoiceId),
      status: normalizeStatus(record.status),
      amount: normalizeAmount(record.amount),
      amountFunded: normalizeAmount(record.amount_funded),
      amountPaid: normalizeAmount(record.amount_paid),
      funder,
    };
  }

  async getInvoiceCount(): Promise<number> {
    const raw = await this.simulate('get_invoice_count');
    if (raw === null) {
      return 0;
    }
    return Number(raw);
  }

  async getProtocolStatus(): Promise<OnChainProtocolStatus | null> {
    const raw = await this.simulate('get_protocol_status');
    if (raw === null || typeof raw !== 'object') {
      return null;
    }
    const record = raw as Record<string, unknown>;
    const num = (v: unknown): number =>
      typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? Math.trunc(v) : Number(v ?? 0);
    return {
      paused: record.paused === true,
      lastPauseTimestamp: num(record.last_pause_timestamp),
      admin: String(record.admin ?? ''),
      multisigConfigured: record.multisig_configured === true,
      multisigThreshold: num(record.multisig_threshold),
      multisigSignerCount: num(record.multisig_signer_count),
      oracleCircuitTripped: record.oracle_circuit_tripped === true,
      oracleCircuitsTripped: num(record.oracle_circuits_tripped),
    };
  }

  /**
   * Simulate a read-only contract invocation and return the decoded return
   * value. Maps the contract's InvoiceNotFound error (code 1) to null so
   * callers can treat "missing on-chain" as a first-class outcome.
   */
  private async simulate(fnName: string, ...args: ReturnType<typeof nativeToScVal>[]): Promise<unknown | null> {
    const tx = new TransactionBuilder(SIMULATION_ACCOUNT, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(fnName, ...args))
      .setTimeout(30)
      .build();

    const simulated = await this.server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(simulated)) {
      const message = String(simulated.error);
      // errors.rs: 1 == InvoiceNotFound
      if (message.includes('Error(Contract, 1)')) {
        return null;
      }
      throw new Error(`Chain read ${fnName} failed: ${message}`);
    }

    const retval = simulated.result?.retval;
    if (!retval) {
      return null;
    }
    return scValToNative(retval);
  }
}
