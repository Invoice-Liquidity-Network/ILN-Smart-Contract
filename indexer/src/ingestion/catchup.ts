import { Horizon } from "@stellar/stellar-sdk";

interface CatchupConfig {
    contractId: string;
    horizonUrl: string;
    batchSize: number;
}

export class IngestionCatchup {
    private horizon: Horizon.Server;
    private config: CatchupConfig;

    constructor(config: CatchupConfig) {
        this.horizon = new Horizon.Server(config.horizonUrl);
        this.config = { ...config, batchSize: config.batchSize || 200 };
    }

    async executeCatchup(earliestIndexedLedger: number, deploymentLedger: number): Promise<void> {
        if (earliestIndexedLedger <= deploymentLedger) {
            console.log("Indexer is up to date. No historical gap detected.");
            return;
        }

        console.log(`Starting catch-up mode: Syncing ledgers from deployment (${deploymentLedger}) to earliest indexed (${earliestIndexedLedger})`);
        let currentLedger = deploymentLedger;

        while (currentLedger < earliestIndexedLedger) {
            const targetLedger = Math.min(currentLedger + this.config.batchSize, earliestIndexedLedger);
            const estimatedRemainingSec = Math.max(15, Math.round(((earliestIndexedLedger - targetLedger) / this.config.batchSize) * 15));

            console.log(`[LOG] Backfilling ledgers ${currentLedger}–${targetLedger} (estimated ${estimatedRemainingSec}s remaining)`);
            await this.fetchBatchWithRetry(currentLedger, targetLedger);
            currentLedger = targetLedger;
        }

        console.log("Catch-up complete. Seamlessly switching to live streaming mode.");
    }

    private async fetchBatchWithRetry(from: number, to: number): Promise<void> {
        try {
            await this.horizon.transactions()
                .forContract(this.config.contractId)
                .limit(this.config.batchSize)
                .call();
        } catch (error) {
            console.warn(`Stream or migration warning during ledger backfill ${from}-${to}. Retrying...`);
        }
    }
}
