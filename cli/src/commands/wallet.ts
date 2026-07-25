import { Command } from "commander";
import { listProfiles, saveProfile, loadProfile, resolveProfile } from "../config.js";
import { Keypair, Horizon } from "@stellar/stellar-sdk";
import readline from "readline/promises";
import { formatOutput, formatError, isJsonMode } from "../format.js";

/**
 * Helper to read input from the terminal (e.g., for PINs or secrets).
 */
async function ask(question: string, silent = false): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  if (silent) {
    process.stdout.write(question);
    const password = await new Promise<string>((resolve) => {
      process.stdin.on("data", (data) => {
        resolve(data.toString().trim());
      });
    });
    process.stdout.write("\n");
    rl.close();
    return password;
  }
  const answer = await rl.question(question);
  rl.close();
  return answer;
}

/** Generate a Stellar keypair. */
export function generateKeypair(): { publicKey: string; secretKey: string } {
  const kp = Keypair.random();
  return {
    publicKey: kp.publicKey(),
    secretKey: kp.secret(),
  };
}

export function makeWalletCommand(): Command {
  const cmd = new Command("wallet").description(
    "Manage Stellar keypairs and named profiles"
  );

  // iln wallet generate [--profile name]
  cmd
    .command("generate")
    .description("Generate a new Stellar keypair and store it as a named profile")
    .option("--profile <name>", "Profile name to store the keypair under", "default")
    .option("--json", "Output result as JSON (also available as global flag)")
    .action(async (opts: { profile: string; json?: boolean }) => {
      const parentOpts = cmd.parent?.opts() as Record<string, unknown> | undefined;
      const json = opts.json || isJsonMode(parentOpts);

      const kp = generateKeypair();

      if (!json) {
        console.log(`\x1b[33mWarning: Keep your secret key secure. Anyone with access to it can control your funds.\x1b[0m`);
        const pin = await ask("Set a PIN to encrypt your secret key: ", true);
        saveProfile({ name: opts.profile, publicKey: kp.publicKey, secretKey: kp.secretKey }, undefined, pin);

        console.log(`✓ Keypair generated and saved as profile "${opts.profile}"`);
        console.log(`  Public key : ${kp.publicKey}`);
      } else {
        saveProfile({ name: opts.profile, publicKey: kp.publicKey, secretKey: kp.secretKey });
        formatOutput({ profile: opts.profile, publicKey: kp.publicKey }, true);
      }
    });

  // iln wallet import --secret S...
  cmd
    .command("import")
    .description("Import an existing Stellar secret key")
    .requiredOption("--secret <secret>", "The Stellar secret key to import")
    .option("--profile <name>", "Profile name to store the keypair under", "default")
    .action(async (opts: { secret: string; profile: string }) => {
      const parentOpts = cmd.parent?.opts() as Record<string, unknown> | undefined;
      const json = isJsonMode(parentOpts);

      try {
        const kp = Keypair.fromSecret(opts.secret);
        const pin = await ask("Set a PIN to encrypt your secret key: ", true);
        saveProfile({ name: opts.profile, publicKey: kp.publicKey(), secretKey: opts.secret }, undefined, pin);
        formatOutput({ profile: opts.profile, publicKey: kp.publicKey() }, json, () => {
          console.log(`✓ Secret key imported and saved as profile "${opts.profile}"`);
          console.log(`  Public key : ${kp.publicKey()}`);
        });
      } catch (err: any) {
        formatError(`Invalid secret key. ${err.message}`, "INVALID_SECRET", json);
      }
    });

  // iln wallet show
  cmd
    .command("show")
    .description("Display the current public key and balances")
    .action(async () => {
      const parentOpts = cmd.parent?.opts() as Record<string, unknown> | undefined;
      const json = isJsonMode(parentOpts);

      const profile = resolveProfile();
      if (!profile) {
        formatError("No active wallet profile found.", "NO_WALLET", json);
      }

      try {
        const server = new Horizon.Server("https://horizon-testnet.stellar.org");
        const account = await server.loadAccount(profile!.publicKey);

        const targets = ["XLM", "USDC", "EURC"];
        const balances: Record<string, string> = {};
        for (const asset of targets) {
          const bal = account.balances.find((b: any) =>
            b.asset_type === "native" ? asset === "XLM" : b.asset_code === asset
          );
          balances[asset] = bal ? bal.balance : "0";
        }

        formatOutput(
          { name: profile!.name, publicKey: profile!.publicKey, balances },
          json,
          () => {
            console.log(`\x1b[1mActive Wallet Profile: ${profile!.name}\x1b[0m`);
            console.log(`Public Key: ${profile!.publicKey}`);
            console.log(`\n\x1b[1mBalances:\x1b[0m`);
            for (const [asset, amount] of Object.entries(balances)) {
              console.log(`${asset.padEnd(5)}: ${amount}`);
            }
          }
        );
      } catch (err: any) {
        formatError(`Could not fetch balances: ${err.message}`, "BALANCE_ERROR", json);
      }
    });

  // iln wallet fund
  cmd
    .command("fund")
    .description("Request testnet XLM via Friendbot")
    .action(async () => {
      const parentOpts = cmd.parent?.opts() as Record<string, unknown> | undefined;
      const json = isJsonMode(parentOpts);

      const profile = resolveProfile();
      if (!profile) {
        formatError("No active wallet profile found.", "NO_WALLET", json);
      }

      try {
        const res = await fetch("https://friendbot.stellar.org", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: profile!.publicKey }),
        });
        if (res.ok) {
          formatOutput({ success: true, publicKey: profile!.publicKey }, json, () => {
            console.log(`✓ Successfully requested XLM from Friendbot.`);
          });
        } else {
          formatError(`Friendbot request failed with status ${res.status}`, "FRIENDBOT_ERROR", json);
        }
      } catch (err: any) {
        formatError(err.message, "FRIENDBOT_ERROR", json);
      }
    });

  // iln wallet list
  cmd
    .command("list")
    .description("List all saved profiles with their public keys")
    .option("--json", "Output as JSON (also available as global flag)")
    .action((opts: { json?: boolean }) => {
      const parentOpts = cmd.parent?.opts() as Record<string, unknown> | undefined;
      const json = opts.json || isJsonMode(parentOpts);

      const profiles = listProfiles();
      const data = profiles.map((p) => ({ name: p.name, publicKey: p.publicKey }));
      formatOutput(data, json, () => {
        if (profiles.length === 0) {
          console.log("No profiles found. Run: iln wallet generate");
        } else {
          for (const p of profiles) {
            console.log(`${p.name.padEnd(20)} ${p.publicKey}`);
          }
        }
      });
    });

  return cmd;
}
