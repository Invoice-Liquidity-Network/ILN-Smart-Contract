import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = resolve(__dirname, '../../docker-compose.test.yml');
const ENV_FILE = resolve(__dirname, '../.env.e2e');
const STELLAR_RPC = 'http://localhost:8000';

async function waitForStellarNode(timeoutMs = 60000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${STELLAR_RPC}/ledger`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Stellar node did not become ready within timeout');
}

export default async function globalSetup(): Promise<void> {
  console.log('[e2e] Starting Stellar node via Docker Compose...');
  execSync(`docker compose -f "${COMPOSE_FILE}" up -d stellar`, {
    stdio: 'inherit',
  });

  console.log('[e2e] Waiting for Stellar node to be healthy...');
  await waitForStellarNode();

  const contractIds: Record<string, string> = {
    INVOICE_LIQUIDITY: 'CAQEQBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ILN_GOVERNANCE: 'CAQEQBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB',
    ILN_DISTRIBUTION: 'CAQEQBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC',
    INSURANCE_POOL: 'CAQEQBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD',
    REPUTATION_BONUS: 'CAQEQBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE',
  };

  writeFileSync(
    ENV_FILE,
    [
      `STELLAR_RPC_URL=${STELLAR_RPC}`,
      `STELLAR_NETWORK=local`,
      `INVOICE_LIQUIDITY_ID=${contractIds.INVOICE_LIQUIDITY}`,
      `ILN_GOVERNANCE_ID=${contractIds.ILN_GOVERNANCE}`,
      `ILN_DISTRIBUTION_ID=${contractIds.ILN_DISTRIBUTION}`,
      `INSURANCE_POOL_ID=${contractIds.INSURANCE_POOL}`,
      `REPUTATION_BONUS_ID=${contractIds.REPUTATION_BONUS}`,
    ].join('\n'),
  );

  process.env.STELLAR_RPC_URL = STELLAR_RPC;
  process.env.STELLAR_NETWORK = 'local';
  process.env.INVOICE_LIQUIDITY_ID = contractIds.INVOICE_LIQUIDITY;
  process.env.ILN_GOVERNANCE_ID = contractIds.ILN_GOVERNANCE;
  process.env.ILN_DISTRIBUTION_ID = contractIds.ILN_DISTRIBUTION;
  process.env.INSURANCE_POOL_ID = contractIds.INSURANCE_POOL;
  process.env.REPUTATION_BONUS_ID = contractIds.REPUTATION_BONUS;

  console.log('[e2e] Setup complete');
}
