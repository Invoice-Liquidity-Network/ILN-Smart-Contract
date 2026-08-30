import { createServer } from 'node:http';
import { config } from './config.js';
import { getDb } from './database/db.js';
import { createApp } from './app.js';
import { EventWebSocketEndpoint } from './api/websocket.js';
import { createSqlEventRepository } from './db/eventRepository.js';
import { createEventListener } from './ingestion/eventListener.js';
import { startReconciliationSchedule, createWebhookAlertDispatcher } from './reconciliation/consistencyJob.js';
import { SorobanChainReader } from './reconciliation/chainReader.js';
import { logger } from './lib/logger.js';

const db = getDb(config.dbPath);

// A single Soroban read-only reader, reused by the public `/protocol-status`
// endpoint (Issue #775) and by continuous reconciliation. Built whenever a
// contract id is configured; RPC URL falls back to the public testnet.
const sorobanRpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const networkPassphrase = process.env.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015';
const chainReader = config.contractId
  ? new SorobanChainReader({
      rpcUrl: sorobanRpcUrl,
      contractId: config.contractId,
      networkPassphrase,
    })
  : undefined;

const app = createApp(db, { apiKeys: config.apiKeys, chainReader });
const eventRepository = createSqlEventRepository(db);
const eventListener = createEventListener({
  repository: eventRepository,
  horizonUrl: config.horizonUrl,
  contractAddress: config.contractId,
});

const httpServer = createServer(app);
const wsEndpoint = new EventWebSocketEndpoint({ server: httpServer, path: '/events' });
wsEndpoint.start();

if (config.contractId) {
  void eventListener.start().catch((error) => {
    logger.error('indexer ingestion loop exited unexpectedly', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  if (process.env.RECONCILIATION_ENABLED === 'true' && chainReader) {
    const alertUrl = process.env.RECONCILIATION_ALERT_URL;
    if (alertUrl) {
      startReconciliationSchedule(db, chainReader, {
        alert: createWebhookAlertDispatcher(alertUrl),
      });
    } else {
      startReconciliationSchedule(db, chainReader);
    }
    logger.info('continuous reconciliation schedule started');
  }
} else {
  logger.warn('ILN_CONTRACT_ID/CONTRACT_ID is not set; event ingestion is disabled');
}

httpServer.listen(config.port, () => {
  logger.info('ILN indexer API listening', { port: config.port, transport: 'http+ws' });
});

export { wsEndpoint, eventListener };
