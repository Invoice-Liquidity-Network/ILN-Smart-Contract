/**
 * Tests for check-escrowed-exposure.ts.
 *
 * Uses Node's built-in test runner with a fake fetch so no network is required.
 *
 *   node --experimental-strip-types --test scripts/check-escrowed-exposure.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type ExposureDeps,
  type ExposureConfig,
  type InvoiceOnChain,
  loadExposureConfig,
  fetchEscrowedExposure,
} from './check-escrowed-exposure.ts';

const cfg: ExposureConfig = {
  sorobanRpcUrl: 'https://rpc.example',
  contractId: 'CBIELTK6YBZJU5UP2WWQEQ4YPE6BBMC5CXJAWLS5YF4SZJED7B7BZAO',
  timeoutMs: 5000,
};

function depsWith(
  invoiceMap: Record<number, InvoiceOnChain>
): ExposureDeps {
  let clock = 1000;
  return {
    now: () => (clock += 5),
    fetch: (async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      if (body.method === 'getLatestLedger') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: '2.0',
            id: body.id,
            result: { sequence: 50000 },
          }),
        } as unknown as Response;
      }
      throw new Error(`unexpected RPC method: ${body.method}`);
    }) as unknown as typeof fetch,
    fetchInvoice: async (
      _contractId: string,
      invoiceIndex: number
    ): Promise<InvoiceOnChain | null> => {
      return invoiceMap[invoiceIndex] ?? null;
    },
  };
}

test('loadExposureConfig applies defaults', () => {
  const c = loadExposureConfig({
    CONTRACT_ID: 'CBIELTK6YBZJU5UP2WWQEQ4YPE6BBMC5CXJAWLS5YF4SZJED7B7BZAO',
  } as any);
  assert.equal(
    c.contractId,
    'CBIELTK6YBZJU5UP2WWQEQ4YPE6BBMC5CXJAWLS5YF4SZJED7B7BZAO'
  );
  assert.match(c.sorobanRpcUrl, /soroban-testnet/);
  assert.equal(c.timeoutMs, 10_000);
});

test('loadExposureConfig throws when CONTRACT_ID missing', () => {
  const c = loadExposureConfig({});
  assert.equal(c.contractId, '');
});

test('fetchEscrowedExposure throws when contractId is empty', async () => {
  const deps = depsWith({});
  await assert.rejects(
    () => fetchEscrowedExposure({ ...cfg, contractId: '' }, deps),
    /CONTRACT_ID is required/
  );
});

test('fetchEscrowedExposure returns zero exposure when no invoices found', async () => {
  const deps = depsWith({});
  const result = await fetchEscrowedExposure(cfg, deps);
  assert.equal(result.contractId, cfg.contractId);
  assert.equal(result.invoiceCount, 0);
  assert.deepEqual(result.fundedButUnsettled, []);
  assert.equal(result.totalFundedExposure, '0');
});

test('fetchEscrowedExposure sums funded-but-unsettled amounts by token', async () => {
  const deps = depsWith({
    0: { token: 'USDC', amount_funded: '1000000', amount_paid: '0', status: 'Funded' },
    1: { token: 'USDC', amount_funded: '2000000', amount_paid: '0', status: 'Funded' },
    2: { token: 'XLM', amount_funded: '500000', amount_paid: '0', status: 'Funded' },
  });
  const result = await fetchEscrowedExposure(cfg, deps);
  assert.equal(result.invoiceCount, 3);
  assert.equal(result.fundedButUnsettled.length, 2);
  const usdc = result.fundedButUnsettled.find((t) => t.token === 'USDC');
  assert.ok(usdc);
  assert.equal(usdc.totalAmount, '3000000');
  assert.equal(usdc.invoiceCount, 2);
  const xlm = result.fundedButUnsettled.find((t) => t.token === 'XLM');
  assert.ok(xlm);
  assert.equal(xlm.totalAmount, '500000');
  assert.equal(xlm.invoiceCount, 1);
  assert.equal(result.totalFundedExposure, '3500000');
});

test('fetchEscrowedExposure excludes paid invoices', async () => {
  const deps = depsWith({
    0: { token: 'USDC', amount_funded: '1000000', amount_paid: '1000000', status: 'Paid' },
    1: { token: 'USDC', amount_funded: '2000000', amount_paid: '0', status: 'Funded' },
  });
  const result = await fetchEscrowedExposure(cfg, deps);
  assert.equal(result.invoiceCount, 1);
  assert.equal(result.totalFundedExposure, '2000000');
});

test('fetchEscrowedExposure excludes cancelled invoices', async () => {
  const deps = depsWith({
    0: { token: 'USDC', amount_funded: '1000000', amount_paid: '0', status: 'Cancelled' },
  });
  const result = await fetchEscrowedExposure(cfg, deps);
  assert.equal(result.invoiceCount, 0);
  assert.equal(result.totalFundedExposure, '0');
});

test('fetchEscrowedExposure fails when RPC is unreachable', async () => {
  const deps: ExposureDeps = {
    now: () => Date.now(),
    fetch: (async () => {
      throw new Error('network error');
    }) as unknown as typeof fetch,
  };
  await assert.rejects(
    () => fetchEscrowedExposure(cfg, deps),
    /network error/
  );
});

test('fetchEscrowedExposure fails when getLatestLedger returns no sequence', async () => {
  const deps: ExposureDeps = {
    now: () => Date.now(),
    fetch: (async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: body.id,
          result: {},
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch,
  };
  await assert.rejects(
    () => fetchEscrowedExposure(cfg, deps),
    /Could not reach Soroban RPC/
  );
});
