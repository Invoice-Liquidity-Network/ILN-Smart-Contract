import { Command } from "commander";
import * as readline from "readline";
import { resolveProfile, loadConfig } from "../config.js";
import { formatOutput, formatError, isJsonMode } from "../format.js";
import { ILNClient, pause as sdkPause, unpause as sdkUnpause, KeypairSigner } from "@iln/sdk";
import { Keypair, Contract, Account, TransactionBuilder, BASE_FEE, scValToNative } from "@stellar/stellar-sdk";

export interface PauseResult {
  txHash: string;
  paused?: boolean;
}

export type PauseExecutor = (profile?: string) => Promise<PauseResult>;
export type StateChecker = (profile?: string) => Promise<boolean>;

async function promptConfirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

function getClient(profileFlag?: string): ILNClient {
  const profile = resolveProfile(profileFlag);
  if (!profile || !profile.secretKey) {
    throw new Error("No connected wallet found or missing secret key. Run: iln wallet generate");
  }
  const kp = Keypair.fromSecret(profile.secretKey);
  const signer = new KeypairSigner(kp);
  
  const cfg = loadConfig();
  if (cfg.network === "mainnet") {
    return ILNClient.mainnet(signer);
  }
  return ILNClient.testnet(signer);
}

// Default real executors
async function defaultPauseExecutor(profile?: string): Promise<PauseResult> {
  const client = getClient(profile);
  const res = await sdkPause(client);
  return { txHash: res.txHash, paused: true };
}

async function defaultUnpauseExecutor(profile?: string): Promise<PauseResult> {
  const client = getClient(profile);
  const res = await sdkUnpause(client);
  return { txHash: res.txHash, paused: false };
}

async function defaultStateChecker(profile?: string): Promise<boolean> {
  // Use a client without signer just for read
  let client: ILNClient;
  try {
    client = getClient(profile);
  } catch (err) {
    const cfg = loadConfig();
    client = cfg.network === "mainnet" ? ILNClient.mainnet() : ILNClient.testnet();
  }
  const contract = new Contract(client.contractId);
  const op = contract.call("get_protocol_status");
  const sourceAccount = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0");
  const simTx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: client.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await client.rpc.simulateTransaction(simTx);
  if (!sim.result?.retval) return false;
  const raw = scValToNative(sim.result.retval) as any;
  return raw.paused === true;
}

export function makePauseCommand(
  stateChecker: StateChecker = defaultStateChecker,
  pauseExecutor: PauseExecutor = defaultPauseExecutor,
  confirm: (msg: string) => Promise<boolean> = promptConfirm
): Command {
  const cmd = new Command("pause").description("Pause all contract operations");

  cmd
    .option("--yes", "Skip confirmation prompt")
    .action(async (opts: { yes?: boolean }) => {
      const rootOpts = cmd.parent?.opts() as Record<string, unknown> | undefined;
      const json = isJsonMode(rootOpts);
      const profileFlag = rootOpts?.profile as string | undefined;

      try {
        // Require admin authentication
        const profile = resolveProfile(profileFlag);
        if (!profile) {
          formatError("No connected wallet found. Run: iln wallet generate", "NO_WALLET", json);
          return;
        }

        // Check current state
        const isCurrentlyPaused = await stateChecker(profileFlag);
        if (isCurrentlyPaused) {
          formatOutput({ paused: true, message: "contract is already paused" }, json, () => {
            console.log("Contract is already paused. No changes made.");
          });
          return;
        }

        // Confirmation prompt
        if (!opts.yes) {
          const msg = "Confirm pause of contract? [y/N]";
          const confirmed = await confirm(msg);
          if (!confirmed) {
            formatOutput({ aborted: true, message: "contract not paused" }, json, () => {
              console.log("Aborted — contract not paused.");
            });
            return;
          }
        }

        const result = await pauseExecutor(profileFlag);

        formatOutput({ ...result, state: "Paused" }, json, () => {
          console.log(`Contract paused. TX: ${result.txHash}`);
          console.log(`Contract State: Paused`);
        });
      } catch (err) {
        formatError((err as Error).message, "PAUSE_ERROR", json);
      }
    });

  return cmd;
}

export function makeUnpauseCommand(
  stateChecker: StateChecker = defaultStateChecker,
  unpauseExecutor: PauseExecutor = defaultUnpauseExecutor,
  confirm: (msg: string) => Promise<boolean> = promptConfirm
): Command {
  const cmd = new Command("unpause").description("Unpause contract operations");

  cmd
    .option("--yes", "Skip confirmation prompt")
    .action(async (opts: { yes?: boolean }) => {
      const rootOpts = cmd.parent?.opts() as Record<string, unknown> | undefined;
      const json = isJsonMode(rootOpts);
      const profileFlag = rootOpts?.profile as string | undefined;

      try {
        // Require admin authentication
        const profile = resolveProfile(profileFlag);
        if (!profile) {
          formatError("No connected wallet found. Run: iln wallet generate", "NO_WALLET", json);
          return;
        }

        // Check current state
        const isCurrentlyPaused = await stateChecker(profileFlag);
        if (!isCurrentlyPaused) {
          formatOutput({ paused: false, message: "contract is already unpaused" }, json, () => {
            console.log("Contract is already unpaused. No changes made.");
          });
          return;
        }

        // Confirmation prompt
        if (!opts.yes) {
          const msg = "Confirm unpause of contract? [y/N]";
          const confirmed = await confirm(msg);
          if (!confirmed) {
            formatOutput({ aborted: true, message: "contract not unpaused" }, json, () => {
              console.log("Aborted — contract not unpaused.");
            });
            return;
          }
        }

        const result = await unpauseExecutor(profileFlag);

        formatOutput({ ...result, state: "Active" }, json, () => {
          console.log(`Contract unpaused. TX: ${result.txHash}`);
          console.log(`Contract State: Active`);
        });
      } catch (err) {
        formatError((err as Error).message, "UNPAUSE_ERROR", json);
      }
    });

  return cmd;
}
