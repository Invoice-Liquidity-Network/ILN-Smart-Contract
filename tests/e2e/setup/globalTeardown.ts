import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = resolve(__dirname, '../../docker-compose.test.yml');

export default async function globalTeardown(): Promise<void> {
  console.log('[e2e] Tearing down Stellar node...');
  execSync(`docker compose -f "${COMPOSE_FILE}" down -v`, { stdio: 'inherit' });
  console.log('[e2e] Teardown complete');
}
