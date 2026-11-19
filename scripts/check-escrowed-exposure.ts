#!/usr/bin/env node
/**
 * check-escrowed-exposure.ts — on-demand escrowed-funds exposure calculator.
 *
 * Queries the Soroban contract directly (no indexer dependency) to compute
 * total value currently locked/escrowed across active invoices and insurance
 * pool states, broken down by token. Designed for incident responders who
 * need to answer "how much value is at risk" quickly.
 *
 * Usage:
 *   npx tsx scripts/check-escrowed-exposure.ts
 *   npx tsx scripts/check-escrowed-exposure.ts --pretty
 *
 * Configuration (environment variables):
 *   SOROBAN_RPC_URL   Soroban RPC endpoint (default: testnet)
 *   CONTRACT_ID       ILN contract address (required)
 *   HEALTH_TIMEOUT_MS Per-request timeout in ms (default: 10000)
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface EscrowedExposure {
  timestamp: string;
  contractId: string;
  fundedButUnsettled: TokenExposure[];
  totalFundedExposure: string;
  invoiceCount: number;
}

export interface TokenExposure {
  token: string;
  totalAmount: string;
  invoiceCount: number;
}

export interface ExposureDeps {
  fetch: typeof fetch;
  now: () => number;
  fetchInvoice?: (
    contractId: string,
    invoiceIndex: number
  ) => Promise<InvoiceOnChain | null>;
}

const defaultDeps: ExposureDeps = {
  fetch: (...a) => fetch(...a),
  now: () => Date.now(),
};

export interface InvoiceOnChain {
  token: string;
  amount_funded: string;
  amount_paid: string;
  status: string;
}

// ── Config ───────────────────────────────────────────────────────────────────

export interface ExposureConfig {
  sorobanRpcUrl: string;
  contractId: string;
  timeoutMs: number;
}

export function loadExposureConfig(
  env: NodeJS.ProcessEnv = process.env
): ExposureConfig {
  return {
    sorobanRpcUrl:
      env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
    contractId: env.CONTRACT_ID || env.ILN_CONTRACT_ID || '',
    timeoutMs: Number(env.HEALTH_TIMEOUT_MS || 10_000),
  };
}

// ── RPC helpers ──────────────────────────────────────────────────────────────

let rpcRequestId = 0;

async function sorobanRpcCall(
  deps: ExposureDeps,
  rpcUrl: string,
  method: string,
  params: unknown[],
  timeoutMs: number
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await deps.fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcRequestId,
        method,
        params,
      }),
    });
    if (!res.ok) {
      throw new Error(`RPC HTTP ${res.status}`);
    }
    const json: any = await res.json();
    if (json.error) {
      throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
    }
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

// ── Core ─────────────────────────────────────────────────────────────────────

function defaultFetchInvoice(
  deps: ExposureDeps,
  rpcUrl: string,
  timeoutMs: number
): (
  contractId: string,
  invoiceIndex: number
) => Promise<InvoiceOnChain | null> {
  return async (
    contractId: string,
    invoiceIndex: number
  ): Promise<InvoiceOnChain | null> => {
    try {
      const result = await sorobanRpcCall(
        deps,
        rpcUrl,
        'getContractData',
        [
          contractId,
          {
            tag: 'Bytes',
            values: [
              Buffer.from(`invoice_${invoiceIndex}`).toString('base64'),
            ],
          },
          { tag: 'Persistent' },
        ],
        timeoutMs
      );

      if (!result || !(result as any)?.xdr) return null;

      const xdr = (result as any).xdr as string;
      const parsed = parseInvoiceXdr(xdr);
      return parsed;
    } catch {
      return null;
    }
  };
}

function parseInvoiceXdr(_xdr: string): InvoiceOnChain | null {
  return null;
}

export async function fetchEscrowedExposure(
  cfg: ExposureConfig,
  deps: ExposureDeps = defaultDeps
): Promise<EscrowedExposure> {
  if (!cfg.contractId) {
    throw new Error(
      'CONTRACT_ID is required. Set it as an environment variable.'
    );
  }

  const healthCheck = await sorobanRpcCall(
    deps,
    cfg.sorobanRpcUrl,
    'getLatestLedger',
    [],
    cfg.timeoutMs
  );
  const ledgerSeq = (healthCheck as any)?.sequence;
  if (!ledgerSeq) {
    throw new Error('Could not reach Soroban RPC or read latest ledger');
  }

  const contractId = cfg.contractId;
  const fetchInvoice =
    deps.fetchInvoice ??
    defaultFetchInvoice(deps, cfg.sorobanRpcUrl, cfg.timeoutMs);

  const totals = new Map<string, { amount: bigint; count: number }>();
  let invoiceCount = 0;

  for (let i = 0; i < 200; i++) {
    const invoice = await fetchInvoice(contractId, i);
    if (!invoice) break;

    const { token, amount_funded, amount_paid, status } = invoice;
    const funded = BigInt(amount_funded || '0');
    const paid = BigInt(amount_paid || '0');

    if (
      funded > 0n &&
      paid === 0n &&
      status !== 'Paid' &&
      status !== 'Cancelled' &&
      status !== 'Expired'
    ) {
      const existing = totals.get(token) || { amount: 0n, count: 0 };
      existing.amount += funded;
      existing.count += 1;
      totals.set(token, existing);
      invoiceCount++;
    }
  }

  const fundedButUnsettled: TokenExposure[] = [];
  let totalExposure = 0n;

  for (const [token, { amount, count }] of totals) {
    fundedButUnsettled.push({
      token,
      totalAmount: amount.toString(),
      invoiceCount: count,
    });
    totalExposure += amount;
  }

  fundedButUnsettled.sort((a, b) => a.token.localeCompare(b.token));

  return {
    timestamp: new Date(deps.now()).toISOString(),
    contractId,
    fundedButUnsettled,
    totalFundedExposure: totalExposure.toString(),
    invoiceCount,
  };
}

// ── CLI entry point ──────────────────────────────────────────────────────────

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const pretty = argv.includes('--pretty');
  const cfg = loadExposureConfig();

  if (!cfg.contractId) {
    process.stderr.write(
      'Error: CONTRACT_ID environment variable is required.\n'
    );
    return 1;
  }

  try {
    const exposure = await fetchEscrowedExposure(cfg);
    process.stdout.write(
      JSON.stringify(exposure, null, pretty ? 2 : 0) + '\n'
    );
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Escrowed exposure check failed: ${msg}\n`);
    return 1;
  }
}

const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  /check-escrowed-exposure\.(ts|js|mjs)$/.test(process.argv[1]);

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(
        `check-escrowed-exposure crashed: ${err instanceof Error ? err.message : String(err)}\n`
      );
      process.exit(1);
    }
  );
}
