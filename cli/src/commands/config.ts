/**
 * `iln config` — manage CLI settings.
 *
 * Sub-commands:
 *   iln config set <key> <value>
 *   iln config get <key>
 *   iln config list
 *   iln config reset
 *
 * Issue: #245
 */
import { Command } from "commander";
import {
  getConfigValue,
  loadConfig,
  resetConfig,
  setConfigValue,
} from "../config.js";
import { formatOutput, formatError, isJsonMode } from "../format.js";

export function makeConfigCommand(): Command {
  const cmd = new Command("config").description(
    "Manage ILN CLI configuration stored in ~/.iln/config.json"
  );

  // iln config set <key> <value>
  cmd
    .command("set <key> <value>")
    .description(
      "Set a config value (keys: network, rpcUrl, defaultProfile)"
    )
    .action((key: string, value: string) => {
      const parentOpts = cmd.parent?.opts() as Record<string, unknown> | undefined;
      const json = isJsonMode(parentOpts);

      try {
        setConfigValue(key, value);
        formatOutput({ key, value, set: true }, json, () => {
          console.log(`✓ Set ${key} = ${value}`);
        });
      } catch (err) {
        formatError((err as Error).message, "CONFIG_ERROR", json);
      }
    });

  // iln config get <key>
  cmd
    .command("get <key>")
    .description("Get a single config value")
    .action((key: string) => {
      const parentOpts = cmd.parent?.opts() as Record<string, unknown> | undefined;
      const json = isJsonMode(parentOpts);

      const val = getConfigValue(key as "network" | "rpcUrl" | "defaultProfile");
      if (val === undefined) {
        formatError(`Key "${key}" not found in config.`, "KEY_NOT_FOUND", json);
      }
      formatOutput({ key, value: val }, json, () => {
        console.log(val);
      });
    });

  // iln config list
  cmd
    .command("list")
    .description("Show all current config values")
    .option("--json", "Output as JSON (also available as global flag)")
    .action((opts: { json?: boolean }) => {
      const parentOpts = cmd.parent?.opts() as Record<string, unknown> | undefined;
      const json = opts.json || isJsonMode(parentOpts);

      const cfg = loadConfig();
      formatOutput(cfg, json, () => {
        for (const [k, v] of Object.entries(cfg)) {
          console.log(`${k}: ${v}`);
        }
      });
    });

  // iln config reset
  cmd
    .command("reset")
    .description("Restore all config values to defaults")
    .action(() => {
      const parentOpts = cmd.parent?.opts() as Record<string, unknown> | undefined;
      const json = isJsonMode(parentOpts);

      resetConfig();
      formatOutput({ reset: true }, json, () => {
        console.log("✓ Config reset to defaults.");
      });
    });

  return cmd;
}
